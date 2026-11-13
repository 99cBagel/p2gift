// Lock-stage wizard sessions — the server-side state machine.
//
// The server is the referee: a wizard_sessions row (migration 0046)
// holds the state and every locked field. The Agent holds only the
// session_id. Each tool reads its preconditions from the row — never
// from Agent arguments — and advances exactly one transition:
//
//   SOURCE_LOADED ──approve_pitch──▶ PITCH_LOCKED
//   PITCH_LOCKED ──select_gift──▶ GIFT_LOCKED
//   GIFT_LOCKED ──approve_layout──▶ LAYOUT_LOCKED   (issues ARTWORK_SPECS)
//   LAYOUT_LOCKED ──approve_artwork──▶ ARTWORK_LOCKED
//   ARTWORK_LOCKED ──set_order_details──▶ DETAILS_LOCKED
//   DETAILS_LOCKED ──prepare_checkout──▶ CHECKOUT_ISSUED
//   CHECKOUT_ISSUED ──get_order_status (webhook-settled)──▶ ORDER_CONFIRMED
//
// Locks are forward-only and write-once: there is no unlock tool in
// v1 — a wrong lock means a fresh session via start_session.
// Repeating the call that produced the current state is idempotent:
// it returns the current state and changes nothing.
//
// Artwork carries NO automated file rail (owner decision 2026-11-13):
// approve_artwork parks the file exactly as received; the operator
// reviews it in Admin and addresses any issue with the customer
// manually. ARTWORK_SPECS are advisory text for the Assistant,
// issued at the layout lock from the locked product's row.

import { loadInventory } from "./inventory.js";

export const SITE = "https://p2gift.keeg.uk";
// The product page the human picks on. approve_pitch returns it; the
// Agent passes it to the user and never browses or builds it.
export const PRODUCT_PAGE_URL = `${SITE}/`;

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
function newSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return "ses_" + [...bytes].map((b) => CROCKFORD[b & 0x1f]).join("");
}

// Mirrors src/features/products/wizardDefaults.ts — mcp-server is
// plain JS and cannot import the TS module. Keep the two in sync;
// the product row's own text wins whenever it is set.
export const DEFAULT_LAYOUT_OPTIONS = [
  "A — Centered, 3 lines, large",
  "B — Hierarchy, small top line + rule + large name",
  "C — 2 lines, with the em dash kept",
].join("\n");
export const DEFAULT_ARTWORK_SPECS = [
  "Print artwork for this item — render to these specs:",
  "- File: PNG only, under 15 MB",
  "- Background: transparent",
  "- Color: single color",
  "- Content: text only (no logo, no images)",
  "- Font size: any",
].join("\n");

const FORM_RANK = { short: 1, condensed: 2, full: 3 };

// The pitch's form, from its structure — the settled condensed form
// is 《title》 + noun phrases separated by 、; a pitch longer than a
// short phrase with no condensed structure reads as full.
export function pitchForm(text) {
  const t = String(text ?? "").trim();
  if (/《[^》]+》/.test(t) && t.includes("、")) return "condensed";
  if ([...t].length <= 30 && !/\n/.test(t)) return "short";
  return "full";
}

export function hasPrintableText(text) {
  return /[\p{L}\p{N}]/u.test(String(text ?? ""));
}

// Per-item fit of a pitch form against the item's print surface.
export function fitFor(form, surface) {
  if (!FORM_RANK[form] || !FORM_RANK[surface]) return "no-fit";
  if (FORM_RANK[form] <= FORM_RANK[surface]) return "fits";
  return surface === "condensed" ? "needs-condensed" : "needs-short";
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function publicSession(row) {
  if (!row) return null;
  return {
    session_id: row.id,
    state: row.state,
    pitch_text: row.pitch_text,
    pitch_form: row.pitch_form,
    gift_item_id: row.gift_item_id,
    variant_label: row.variant_label,
    layout: row.layout,
    quantity: row.quantity,
    order_id: row.order_public_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const NEXT_STEP = {
  SOURCE_LOADED: "approve_pitch — settle the pitch wording with the user, then lock it.",
  PITCH_LOCKED: "select_gift — the user picks on the product page and pastes the pick message; pass it in.",
  GIFT_LOCKED: "approve_layout — render the layout mockups locally, the user picks one, lock it to receive ARTWORK_SPECS.",
  LAYOUT_LOCKED: "approve_artwork — render the Final Print Artwork locally to ARTWORK_SPECS, the user approves it, then submit the file.",
  ARTWORK_LOCKED: "set_order_details — ask the user for quantity and the delivery name + address.",
  DETAILS_LOCKED: "prepare_checkout — issue the checkout link from the locked session.",
  CHECKOUT_ISSUED: "get_order_status — poll until the store's webhook settles the order.",
  ORDER_CONFIRMED: "Done — the confirmation has been delivered. Later checks use lookup_order.",
};

function wrongState(row, tool) {
  return {
    error: `Session ${row.id} is at ${row.state}; ${tool} is not the open step.`,
    session: publicSession(row),
    next: NEXT_STEP[row.state] ?? null,
  };
}

async function loadRow(env, sessionId) {
  if (!env?.DB) return { error: "Store database is not available to the MCP server." };
  const row = await env.DB.prepare("SELECT * FROM wizard_sessions WHERE id = ?")
    .bind(String(sessionId ?? ""))
    .first();
  if (!row) return { error: `Unknown wizard session: ${sessionId ?? "(missing)"}. Start one with start_session.` };
  return { row };
}

async function patch(env, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await env.DB.prepare(
    `UPDATE wizard_sessions SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(...keys.map((k) => fields[k]), id)
    .run();
}

// The D1 product a feed inventory item maps to (the storefront pick
// order is products ORDER BY id ASC — the same order this returns).
async function productForItem(env, item) {
  if (!item?.store?.slug) return null;
  return env.DB.prepare(
    "SELECT id, public_id, name, slug, price_cents, stock, active, lead_time_days, layout_options, artwork_specs, image_key FROM products WHERE slug = ?",
  )
    .bind(item.store.slug)
    .first();
}

async function pageProducts(env, items) {
  const out = [];
  for (const item of items) {
    const product = await productForItem(env, item);
    if (product?.active) out.push({ item, product });
  }
  return out;
}

function layoutKeys(layoutOptionsText) {
  const keys = [];
  for (const line of String(layoutOptionsText ?? "").split("\n")) {
    const m = line.trim().match(/^([A-Za-z])\s*[—–-]/);
    if (m) keys.push(m[1].toUpperCase());
  }
  return keys.length ? keys : ["A", "B", "C"];
}

// ── Stage 1 · Intake ────────────────────────────────────────────────
export async function startSession(env, { pitchCandidates, customer }) {
  if (!env?.DB) return { error: "Store database is not available to the MCP server." };
  const candidates = Array.isArray(pitchCandidates)
    ? pitchCandidates.map((c) => String(c ?? "").trim()).filter(Boolean)
    : [];
  const id = newSessionId();
  await env.DB.prepare(
    "INSERT INTO wizard_sessions (id, state, pitch_candidates, customer) VALUES (?, 'SOURCE_LOADED', ?, ?)",
  )
    .bind(id, candidates.length ? JSON.stringify(candidates) : null, customer ? JSON.stringify(customer) : null)
    .run();
  const { row } = await loadRow(env, id);
  return {
    session: publicSession(row),
    state: row.state,
    next: NEXT_STEP.SOURCE_LOADED,
    instruction:
      "Pitch candidates recorded. Settle the exact pitch wording with the user — the locked text prints character for character — then call approve_pitch.",
  };
}

// ── Stage 2 · Pitch lock + fit rail ─────────────────────────────────
export async function approvePitch(env, { sessionId, pitchText }) {
  const { row, error } = await loadRow(env, sessionId);
  if (error) return { error };
  if (row.state === "PITCH_LOCKED" && row.pitch_text === String(pitchText ?? "").trim()) {
    return pitchLockedReply(env, row);
  }
  if (row.state !== "SOURCE_LOADED") return wrongState(row, "approve_pitch");

  const text = String(pitchText ?? "").trim();
  if (!text) return { error: "approve_pitch needs the settled pitch_text — the exact wording the user approved." };
  if (!hasPrintableText(text)) {
    return {
      rejected: true,
      stage: "pitch",
      reasons: ["The pitch has no printable text (letters or numbers) — it cannot be printed on a gift."],
      next: "Re-extract the pitch from the source with the user and call approve_pitch again.",
    };
  }
  const form = pitchForm(text);
  const { items, source } = await loadInventory(env);
  const fits = items.map((item) => ({ gift_item_id: item.id, gift_item: item.name, surface: item.surface, fit: fitFor(form, item.surface) }));
  if (!fits.some((f) => f.fit === "fits")) {
    const best = fits.some((f) => f.fit === "needs-condensed") ? "condensed" : "short";
    return {
      rejected: true,
      stage: "pitch",
      pitch_form: form,
      fits,
      inventory_source: source,
      reasons: [
        `No available gift item can bear the pitch in its ${form} form. ${
          best === "condensed"
            ? "Condense it to the settled form — 《title》 + noun phrases separated by 、 — and resubmit."
            : "Reduce it to a short phrase and resubmit."
        }`,
      ],
      next: "If the pitch cannot be shortened after honest attempts, use Live Connect: draft an email for the user to hello@keeg.uk with the session reference and the block.",
    };
  }
  await patch(env, row.id, { state: "PITCH_LOCKED", pitch_text: text, pitch_form: form });
  const { row: updated } = await loadRow(env, row.id);
  return pitchLockedReply(env, updated, fits, source);
}

async function pitchLockedReply(env, row, fits, source) {
  if (!fits) {
    const inv = await loadInventory(env);
    source = inv.source;
    fits = inv.items.map((item) => ({
      gift_item_id: item.id,
      gift_item: item.name,
      surface: item.surface,
      fit: fitFor(row.pitch_form, item.surface),
    }));
  }
  return {
    session: publicSession(row),
    state: row.state,
    pitch_text: row.pitch_text,
    pitch_form: row.pitch_form,
    fits,
    inventory_source: source,
    product_page_url: PRODUCT_PAGE_URL,
    instruction:
      "Pitch locked — it prints exactly as locked. Give the user the product_page_url: they pick a gift there and paste the pick message back into the chat. Then call select_gift with that pasted message. Do not present your own gift list or link — the pick happens on the product page.",
    next: NEXT_STEP.PITCH_LOCKED,
  };
}

// ── Stage 3 · Gift lock (from the pasted pick message) ──────────────
export async function selectGift(env, { sessionId, pick }) {
  const { row, error } = await loadRow(env, sessionId);
  if (error) return { error };
  const parsed = parsePick(pick);
  if (!parsed) {
    return {
      error:
        'select_gift needs the pick message the user pasted from the product page, in the shape "I pick N — <gift item name>[, Color: <color>] [<image url>]".',
    };
  }
  if (row.state !== "PITCH_LOCKED") {
    // Idempotent re-pick of the same item returns the current state.
    if (row.gift_item_id && row.state !== "SOURCE_LOADED") {
      const inv = await loadInventory(env);
      const locked = inv.items.find((i) => i.id === row.gift_item_id);
      const page = await pageProducts(env, inv.items);
      const lockedEntry = page.find((e) => e.item.id === row.gift_item_id);
      if (lockedEntry && lockedEntry.product.id != null && page.indexOf(lockedEntry) + 1 === parsed.n && locked) {
        return giftLockedReply(env, row, lockedEntry.item, lockedEntry.product);
      }
    }
    return wrongState(row, "select_gift");
  }

  const { items } = await loadInventory(env);
  const page = await pageProducts(env, items);
  const entry = page[parsed.n - 1];
  if (!entry) {
    return {
      error: `Pick ${parsed.n} does not match the product page — it currently lists ${page.length} item(s). Ask the user to pick again on the product page.`,
      session: publicSession(row),
    };
  }
  const fit = fitFor(row.pitch_form, entry.item.surface);
  if (fit !== "fits") {
    return {
      rejected: true,
      stage: "gift",
      reasons: [
        `The locked pitch (${row.pitch_form} form) does not fit ${entry.item.name} — its surface takes a ${entry.item.surface} pitch. Pick a fitting item on the product page, or start a new session with a ${entry.item.surface === "condensed" ? "condensed" : "short"} pitch.`,
      ],
      session: publicSession(row),
    };
  }
  let variantLabel = parsed.color;
  if (variantLabel) {
    const variant = await env.DB.prepare(
      "SELECT label FROM product_variants WHERE product_id = ? AND active = 1 AND lower(label) = lower(?)",
    )
      .bind(entry.product.id, variantLabel)
      .first();
    if (!variant) {
      return {
        rejected: true,
        stage: "gift",
        reasons: [`"${entry.item.name}" has no variant "${variantLabel}". The pick message's color must be one of the item's variants.`],
        session: publicSession(row),
      };
    }
    variantLabel = variant.label;
  }
  await patch(env, row.id, {
    state: "GIFT_LOCKED",
    gift_item_id: entry.item.id,
    product_id: entry.product.id,
    variant_label: variantLabel,
  });
  const { row: updated } = await loadRow(env, row.id);
  return giftLockedReply(env, updated, entry.item, entry.product);
}

function parsePick(pick) {
  const text = String(pick ?? "").trim();
  const m = text.match(/^I pick\s+(\d+)\s*[—–-]\s*(.+)$/i);
  if (!m) return null;
  const rest = m[2].replace(/https?:\/\/\S+\s*$/, "").replace(/\.+$/, "").trim();
  const colorMatch = rest.match(/,\s*Color:\s*([^,]+)$/i);
  return { n: Number(m[1]), name: rest, color: colorMatch ? colorMatch[1].trim() : null };
}

function giftLockedReply(env, row, item, product) {
  return {
    session: publicSession(row),
    state: row.state,
    gift_item: { id: item.id, name: item.name, surface: item.surface, treatment: item.treatment ?? null },
    variant_label: row.variant_label,
    price_cents: product.price_cents,
    currency: "usd",
    lead_time_days: product.lead_time_days ?? null,
    layout_options: product.layout_options || DEFAULT_LAYOUT_OPTIONS,
    themed_base_image: product.image_key ? `${SITE}/images/${product.image_key}` : null,
    instruction:
      "Gift locked. Render the layout mockups locally ON the themed_base_image: download it and apply the locked pitch_text onto the product itself, in the locked variant_label's color — one mockup per layout option (the layout_options above, the item's real A/B/C descriptions), so they are clean mockups of the real product, never bare text-layout panels. The words never change. Present the mockups for the user's pick. Then call approve_layout with the picked letter.",
    next: NEXT_STEP.GIFT_LOCKED,
  };
}

// ── Stage 4 · Layout lock → ARTWORK_SPECS ───────────────────────────
export async function approveLayout(env, { sessionId, layout }) {
  const { row, error } = await loadRow(env, sessionId);
  if (error) return { error };
  const wanted = String(layout ?? "").trim().toUpperCase();
  if (row.state === "LAYOUT_LOCKED" && row.layout === wanted) return layoutLockedReply(env, row);
  if (row.state !== "GIFT_LOCKED") return wrongState(row, "approve_layout");

  const product = await env.DB.prepare(
    "SELECT layout_options, artwork_specs FROM products WHERE id = ?",
  )
    .bind(row.product_id)
    .first();
  const layoutOptions = product?.layout_options || DEFAULT_LAYOUT_OPTIONS;
  const keys = layoutKeys(layoutOptions);
  if (!keys.includes(wanted)) {
    return {
      error: `Layout must be one of ${keys.join(", ")} for this gift item — got "${layout ?? ""}".`,
      layout_options: layoutOptions,
      session: publicSession(row),
    };
  }
  await patch(env, row.id, { state: "LAYOUT_LOCKED", layout: wanted });
  const { row: updated } = await loadRow(env, row.id);
  return layoutLockedReply(env, updated);
}

async function layoutLockedReply(env, row) {
  const product = await env.DB.prepare(
    "SELECT name, layout_options, artwork_specs FROM products WHERE id = ?",
  )
    .bind(row.product_id)
    .first();
  return {
    session: publicSession(row),
    state: row.state,
    layout: row.layout,
    layout_options: product?.layout_options || DEFAULT_LAYOUT_OPTIONS,
    artwork_specs: product?.artwork_specs || DEFAULT_ARTWORK_SPECS,
    instruction:
      "Layout locked. Render the Final Print Artwork locally to these ARTWORK_SPECS, show it to the user, and on their approval call approve_artwork with the file. The specs are advisory — no automated check runs on the file.",
    next: NEXT_STEP.LAYOUT_LOCKED,
  };
}

// ── Stage 5 · Artwork lock (parked as-is, no automated rail) ───────
export async function approveArtwork(env, { sessionId, artworkBase64, artworkName }) {
  const { row, error } = await loadRow(env, sessionId);
  if (error) return { error };
  if (row.state === "ARTWORK_LOCKED" && row.artwork_key) {
    return {
      session: publicSession(row),
      state: row.state,
      artwork: { key: row.artwork_key, name: row.artwork_name, size: row.artwork_size },
      next: NEXT_STEP.ARTWORK_LOCKED,
    };
  }
  if (row.state !== "LAYOUT_LOCKED") return wrongState(row, "approve_artwork");
  if (!env?.FILES) return { error: "The private files bucket is not available to the MCP server." };

  const clean = String(artworkBase64 ?? "").replace(/\s+/g, "");
  if (!clean) return { error: "approve_artwork needs the approved Final Print Artwork file (base64)." };
  let bytes;
  try {
    const bin = atob(clean);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return { error: "The artwork payload is not valid base64." };
  }
  const name = String(artworkName ?? "final-print-artwork.png").trim() || "final-print-artwork.png";
  const key = `artwork/wizard/${row.id}.png`;
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
  await patch(env, row.id, { state: "ARTWORK_LOCKED", artwork_key: key, artwork_name: name, artwork_size: bytes.length });
  const { row: updated } = await loadRow(env, row.id);
  return {
    session: publicSession(updated),
    state: updated.state,
    artwork: { key, name, size: bytes.length },
    instruction:
      "Artwork locked — parked exactly as submitted; the operator reviews it in Admin. Ask the user for the quantity and the delivery name + address, then call set_order_details.",
    next: NEXT_STEP.ARTWORK_LOCKED,
  };
}

// ── Stage 6 · Order details lock ────────────────────────────────────
export function normalizeShipping(s) {
  const shipping = {
    name: String(s?.name ?? "").trim(),
    line1: String(s?.line1 ?? "").trim(),
    line2: String(s?.line2 ?? "").trim() || null,
    city: String(s?.city ?? "").trim(),
    state: String(s?.state ?? "").trim() || null,
    postal: String(s?.postal ?? s?.postal_code ?? "").trim(),
    country: String(s?.country ?? "").trim().toUpperCase(),
  };
  const reasons = [];
  if (!shipping.name || !shipping.line1 || !shipping.city || !shipping.postal) {
    reasons.push("Delivery needs name, address line 1, city, and postal code — all of them, none invented.");
  }
  if (!/^[A-Z]{2}$/.test(shipping.country)) {
    reasons.push(`Delivery country must be a 2-letter code — got "${s?.country ?? ""}".`);
  }
  return { shipping, reasons };
}

export async function setOrderDetails(env, { sessionId, quantity, shipping }) {
  const { row, error } = await loadRow(env, sessionId);
  if (error) return { error };
  if (row.state !== "ARTWORK_LOCKED") return wrongState(row, "set_order_details");
  const qty = Number(quantity);
  const { shipping: normalized, reasons } = normalizeShipping(shipping);
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
    reasons.unshift(`Quantity must be a whole number between 1 and 99 — got "${quantity}".`);
  }
  if (reasons.length) return { rejected: true, stage: "order_details", reasons, session: publicSession(row) };
  await patch(env, row.id, { state: "DETAILS_LOCKED", quantity: qty, shipping: JSON.stringify(normalized) });
  const { row: updated } = await loadRow(env, row.id);
  return {
    session: publicSession(updated),
    state: updated.state,
    quantity: qty,
    shipping: normalized,
    instruction: "Order details locked. Call prepare_checkout to issue the checkout link from the locked session.",
    next: NEXT_STEP.DETAILS_LOCKED,
  };
}

export { loadRow, patch, publicSession as sessionView, NEXT_STEP };
