// Lock-stage wizard sessions — the server-side state machine.
//
// The server is the referee: a wizard_sessions row (migration 0046)
// holds the state and every locked field. The Agent holds only the
// session_id. Each tool reads its preconditions from the row — never
// from Agent arguments — and advances exactly one transition:
//
//   SOURCE_LOADED ──submit(pitch)──▶ PITCH_LOCKED
//   PITCH_LOCKED ──submit(product)──▶ GIFT_LOCKED
//   GIFT_LOCKED ──submit(layout)──▶ LAYOUT_LOCKED   (issues ARTWORK_SPECS)
//   LAYOUT_LOCKED ──submit(artwork)──▶ ARTWORK_LOCKED
//   ARTWORK_LOCKED ──pay──▶ CHECKOUT_ISSUED
//   CHECKOUT_ISSUED ──status (webhook-settled)──▶ ORDER_CONFIRMED
//
// (DETAILS_LOCKED remains reachable only through the retired
// order-details path; pay still accepts it for legacy sessions.)
//
// Locks are forward-only and write-once: there is no unlock in
// v1 — a wrong lock means a fresh session via start.
// Repeating the call that produced the current state is idempotent:
// it returns the current state and changes nothing.
//
// Artwork carries NO automated file rail (owner decision 2026-11-13):
// submit (stage: artwork) parks the file exactly as received; the operator
// reviews it in Admin and addresses any issue with the customer
// manually. ARTWORK_SPECS are advisory text for the Assistant,
// issued at the layout lock from the locked product's row.

import { loadInventory } from "./inventory.js";

export const SITE = "https://p2gift.keeg.uk";


// Session ids are all-digit, 10 digits, first digit non-zero (owner
// decision 2026-11-14): the session id IS the order number when the run
// settles — the store claims this number as the order's public id at
// checkout — so the whole run carries one easy-to-use number. Mirrors
// generateNumericId in src/features/ids/publicId.ts; keep the two in sync.
// Sessions minted earlier carry ses_… ids and stay valid.
function newSessionId() {
  let out = "";
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let i = 0;
  while (out.length < 10) {
    if (i >= buf.length) {
      crypto.getRandomValues(buf);
      i = 0;
    }
    const b = buf[i++];
    if (b >= 250) continue; // 250 = 25 × 10 keeps b % 10 uniform
    const d = b % 10;
    if (out.length === 0 && d === 0) continue;
    out += String(d);
  }
  return out;
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
  "- File: PNG only, 3 MB or smaller",
  "- Background: transparent",
  "- Color: single color",
  "- Content: text only (no logo, no images)",
  "- Font size: any",
].join("\n");

// The pitch's form, from its structure — the settled condensed form
// is 《title》 + noun phrases separated by 、; a pitch longer than a
// short phrase with no condensed structure reads as full. Recorded
// on the session as information only: since the flex-menu dialog
// (2026-11-14) the pitch locks verbatim — no fit rail judges it
// against the catalog surfaces.
export function pitchForm(text) {
  const t = String(text ?? "").trim();
  if (/《[^》]+》/.test(t) && t.includes("、")) return "condensed";
  if ([...t].length <= 30 && !/\n/.test(t)) return "short";
  return "full";
}

export function hasPrintableText(text) {
  return /[\p{L}\p{N}]/u.test(String(text ?? ""));
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
  SOURCE_LOADED: "submit (stage: pitch) — settle the pitch wording with the user, then lock it.",
  PITCH_LOCKED: "submit (stage: product) — the user picks in the dialog; pass the issued pick string in the 'I pick N — …' shape.",
  GIFT_LOCKED: "submit (stage: layout) — render the layout mockups locally, the user picks one, lock it to receive ARTWORK_SPECS.",
  LAYOUT_LOCKED: "submit (stage: artwork) — render the Final_Print_Artwork locally to ARTWORK_SPECS, the user approves it, then submit the file.",
  ARTWORK_LOCKED: "pay — issue the payment link from the locked session. Quantity, address and card are entered on the linked page; nothing is asked in the dialog.",
  DETAILS_LOCKED: "pay — issue the payment link from the locked session.",
  CHECKOUT_ISSUED: "status — read the order state; the call waits server-side while payment settles.",
  ORDER_CONFIRMED: "Done — the confirmation has been delivered. Later checks use status with the order no. + token.",
};

function wrongState(row, tool) {
  return {
    error: `Session ${row.id} is at ${row.state}; ${tool} is not the open step. A run opens at Stage 1 (# Select A Source) and advances one stage per lock — follow the open step only.`,
    session: publicSession(row),
    next: NEXT_STEP[row.state] ?? null,
  };
}

async function loadRow(env, sessionId) {
  if (!env?.DB) return { error: "Store database is not available to the MCP server." };
  const row = await env.DB.prepare("SELECT * FROM wizard_sessions WHERE id = ?")
    .bind(String(sessionId ?? ""))
    .first();
  if (!row) return { error: `Unknown session: ${sessionId ?? "(missing)"}. Open one with start.` };
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
  // Mint + insert with collision retry — the PK is the authority.
  let id = null;
  for (let attempt = 0; attempt < 5 && !id; attempt++) {
    const candidate = newSessionId();
    try {
      await env.DB.prepare(
        "INSERT INTO wizard_sessions (id, state, pitch_candidates, customer) VALUES (?, 'SOURCE_LOADED', ?, ?)",
      )
        .bind(candidate, candidates.length ? JSON.stringify(candidates) : null, customer ? JSON.stringify(customer) : null)
        .run();
      id = candidate;
    } catch (err) {
      if (!/UNIQUE/i.test(String(err?.message ?? err))) throw err;
    }
  }
  if (!id) return { error: "Could not start a session — please retry." };
  const { row } = await loadRow(env, id);
  return {
    session: publicSession(row),
    state: row.state,
    next: NEXT_STEP.SOURCE_LOADED,
    instruction:
      "Pitch candidates recorded. Settle the exact pitch wording with the user — the locked text prints character for character — then submit it (stage: pitch).",
  };
}

// ── Stage 2 · Pitch lock (verbatim — no fit rail) ───────────────────
export async function approvePitch(env, { sessionId, pitchText }) {
  const { row, error } = await loadRow(env, sessionId);
  if (error) return { error };
  if (row.state === "PITCH_LOCKED" && row.pitch_text === String(pitchText ?? "").trim()) {
    return pitchLockedReply(env, row);
  }
  if (row.state !== "SOURCE_LOADED") return wrongState(row, "submit (stage: pitch)");

  const text = String(pitchText ?? "").trim();
  if (!text) return { error: "submit (stage: pitch) needs the settled pitch_text — the exact wording the user approved." };
  if (!hasPrintableText(text)) {
    return {
      rejected: true,
      stage: "pitch",
      reasons: ["The pitch has no printable text (letters or numbers) — it cannot be printed on a gift."],
      next: "Re-extract the pitch from the source with the user and submit it again (stage: pitch).",
    };
  }
  // The pitch locks verbatim, exactly as the user settled it — no
  // form check, no fit rail, no reshape step (flex-menu dialog,
  // owner decision 2026-11-14). pitch_form is recorded as
  // information only.
  const form = pitchForm(text);
  await patch(env, row.id, { state: "PITCH_LOCKED", pitch_text: text, pitch_form: form });
  const { row: updated } = await loadRow(env, row.id);
  return pitchLockedReply(env, updated);
}

async function pitchLockedReply(env, row) {
  return {
    session: publicSession(row),
    state: row.state,
    pitch_text: row.pitch_text,
    pitch_form: row.pitch_form,
    instruction:
      "Pitch locked — it prints exactly as locked. Present the items from the start reply in the dialog, under their service names only; the user taps one. Then submit the pick (stage: product) in the issued shape \"I pick N — <name>[, Color: <color>]\" — the name must be the item's exact service name (the pick string issued at start); the service rejects any other name.",
    next: NEXT_STEP.PITCH_LOCKED,
  };
}

// ── Stage 3 · Gift lock (from the dialog pick) ──────────────────────
export async function selectGift(env, { sessionId, pick }) {
  const { row, error } = await loadRow(env, sessionId);
  if (error) return { error };
  const parsed = parsePick(pick);
  if (!parsed) {
    return {
      error:
        'submit (stage: product) needs the pick in the shape "I pick N — <name>[, Color: <color>]" — form it from the user\'s tap in the dialog.',
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
    return wrongState(row, "submit (stage: product)");
  }

  const { items } = await loadInventory(env);
  const page = await pageProducts(env, items);
  const entry = page[parsed.n - 1];
  if (!entry) {
    return {
      error: `Pick ${parsed.n} does not match the gift list — it currently has ${page.length} item(s). Ask the user to pick again in the dialog.`,
      session: publicSession(row),
    };
  }
  // Guard rail: the pick must carry the item's server-issued name exactly
  // (words, not punctuation). An invented or decorated name — e.g. a gift
  // presented with an added description — is rejected with the correct
  // pick string, so the dialog self-corrects.
  if (!sameItemName(parsed.name, entry.item.name)) {
    return {
      rejected: true,
      stage: "gift",
      reasons: [
        `"${parsed.name}" is not the server's name for item ${parsed.n}. Gift items are presented and passed under the server's names only — never add descriptions or taglines. Use exactly: "I pick ${parsed.n} — ${entry.item.name}".`,
      ],
      session: publicSession(row),
    };
  }
  // No fit check: the locked pitch prints on the picked item
  // verbatim (flex-menu dialog, owner decision 2026-11-14).
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
  const name = colorMatch ? rest.slice(0, colorMatch.index).trim() : rest;
  return { n: Number(m[1]), name, color: colorMatch ? colorMatch[1].trim() : null };
}

// Guard rail: a pick is valid only under the item's server-issued name —
// gift items are presented and passed under the server's names only, never
// with added descriptions or taglines. The comparison tolerates case and
// punctuation; the words themselves must be the server's.
function sameItemName(a, b) {
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(a) !== "" && norm(a) === norm(b);
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
      "Product locked. Render the layout mockups locally ON the themed_base_image: download it and apply the locked pitch_text onto the product itself, in the locked variant_label's color — one mockup per layout option (the layout_options above, the item's real A/B/C descriptions), so they are clean mockups of the real product, never bare text-layout panels. The words never change. Present the mockups for the user's pick. Then submit the picked letter (stage: layout).",
    next: NEXT_STEP.GIFT_LOCKED,
  };
}

// ── Stage 4 · Layout lock → ARTWORK_SPECS ───────────────────────────
export async function approveLayout(env, { sessionId, layout }) {
  const { row, error } = await loadRow(env, sessionId);
  if (error) return { error };
  const wanted = String(layout ?? "").trim().toUpperCase();
  if (row.state === "LAYOUT_LOCKED" && row.layout === wanted) return layoutLockedReply(env, row);
  if (row.state !== "GIFT_LOCKED") return wrongState(row, "submit (stage: layout)");

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
      "Layout locked. Render the Final_Print_Artwork locally to these ARTWORK_SPECS, show it to the user, and on their approval submit the file (stage: artwork). The specs are advisory — no automated check runs on the file.",
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
  if (row.state !== "LAYOUT_LOCKED") return wrongState(row, "submit (stage: artwork)");
  if (!env?.FILES) return { error: "The private files bucket is not available to the MCP server." };

  const clean = String(artworkBase64 ?? "").replace(/\s+/g, "");
  if (!clean) return { error: "submit (stage: artwork) needs the approved Final_Print_Artwork file (base64)." };
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
      "Artwork locked — filed exactly as submitted; the operator reviews it in Admin. Call pay to issue the payment link. Quantity, address and card are entered on the linked page; nothing is asked in the dialog.",
    next: NEXT_STEP.ARTWORK_LOCKED,
  };
}

export { loadRow, patch, publicSession as sessionView, NEXT_STEP };
