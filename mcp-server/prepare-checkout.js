// prepare_checkout — the module that turns a completed workflow
// checkout draft into a real, human-payable store checkout.
//
// Its core is the SHAPE CHECK, run in order:
//   1. Cart shape — the gift item is live in the store (D1), the
//      variant exists, the quantity is sane and in stock, the shipping
//      address is complete, and the quoted price EQUALS the live
//      catalog price. A mismatch is rejected, never adjusted.
//   2. Artwork Layer 1 — the Final Print Artwork file rules
//      (PNG only, under 15 MB, transparent background, single color).
//   3. Artwork Layer 2 — the gift item's own rules plus the Workers AI
//      negative check (see artwork-check.js).
// Only when every check passes does it act: the artwork is stored in
// the private FILES bucket, a prefill_carts row is written, and the
// caller gets the checkout link the human opens to pay. Any failure
// returns the reasons so the agent can fix and resubmit; after two
// failed artwork attempts the guidance points at Live Connect.

import { loadInventory } from "./inventory.js";
import { checkArtworkL1, checkArtworkL2 } from "./artwork-check.js";

const SITE = "https://p2gift.keeg.uk";
const PREFILL_TTL_DAYS = 7;

function newToken() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const buf = new Uint8Array(20);
  crypto.getRandomValues(buf);
  return "pf_" + [...buf].map((b) => alphabet[b % alphabet.length]).join("");
}

function decodeBase64(b64) {
  const clean = String(b64 ?? "").replace(/\s+/g, "");
  if (!clean) return new Uint8Array(0);
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function draftPriceCents(draft) {
  const p = draft?.price;
  if (typeof p === "number" && Number.isFinite(p)) return Math.round(p * 100);
  if (typeof p === "string") {
    const n = Number(p.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100);
  }
  return null;
}

export async function prepareCheckout(env, authProps, input = {}) {
  const session = input.session ?? null;
  if (!session || session.step !== "done" || !session.checkout_draft) {
    return {
      error:
        "prepare_checkout needs a completed workflow session (step \"done\" with a checkout draft). Finish the 5 steps first — pitch, gift, mockup, artwork, checkout.",
    };
  }
  const draft = session.checkout_draft;

  // ── Resolve the gift item against the live inventory + store ──────
  const giftItemId = input.gift_item_id || session.gift_item;
  const { items } = await loadInventory(env);
  const item = items.find((i) => i.id === giftItemId);
  if (!item?.store?.slug) {
    return { rejected: true, stage: "cart", reasons: [`Gift item "${giftItemId}" is not in the live store inventory.`] };
  }
  if (!env?.DB) return { error: "Store database is not available to the MCP server." };
  const product = await env.DB.prepare(
    "SELECT id, public_id, name, price_cents, stock, active FROM products WHERE slug = ?",
  )
    .bind(item.store.slug)
    .first();
  if (!product || !product.active) {
    return { rejected: true, stage: "cart", reasons: [`"${item.name}" is not currently sold in the store.`] };
  }

  // ── Cart shape ─────────────────────────────────────────────────────
  const reasons = [];
  let variant = null;
  let unitPrice = product.price_cents;
  let stock = product.stock;
  if (input.variant_label) {
    variant = await env.DB.prepare(
      "SELECT id, public_id, label, price_cents, stock FROM product_variants WHERE product_id = ? AND active = 1 AND lower(label) = lower(?)",
    )
      .bind(product.id, String(input.variant_label))
      .first();
    if (!variant) {
      reasons.push(`Variant "${input.variant_label}" does not exist for ${item.name}.`);
    } else {
      unitPrice = variant.price_cents;
      stock = variant.stock;
    }
  }
  const qtyRaw = input.quantity ?? draft.quantity;
  const qty = Number(qtyRaw);
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
    reasons.push(`Quantity must be a whole number between 1 and 99 — got "${qtyRaw}".`);
  } else if (variant || product) {
    if (qty > stock) reasons.push(`Only ${stock} of ${item.name} in stock — quantity ${qty} cannot be filled.`);
  }

  const s = input.shipping ?? {};
  const shipping = {
    name: String(s.name ?? "").trim(),
    line1: String(s.line1 ?? "").trim(),
    line2: String(s.line2 ?? "").trim() || null,
    city: String(s.city ?? "").trim(),
    state: String(s.state ?? "").trim() || null,
    postal: String(s.postal ?? "").trim(),
    country: String(s.country ?? "").trim().toUpperCase(),
  };
  if (!shipping.name || !shipping.line1 || !shipping.city || !shipping.postal) {
    reasons.push("Shipping needs name, address line 1, city, and postal code — all of them, none invented.");
  }
  if (!/^[A-Z]{2}$/.test(shipping.country)) {
    reasons.push(`Shipping country must be a 2-letter code — got "${s.country ?? ""}".`);
  }

  const total = unitPrice * (Number.isInteger(qty) ? qty : 0);
  if (input.price_cents != null && Number(input.price_cents) !== total) {
    reasons.push(
      `Quoted price ${Number(input.price_cents)} cents does not equal the live catalog total ${total} cents (${item.name} x ${qty}). Prices are never adjusted silently — re-quote from the catalog.`,
    );
  }
  const dp = draftPriceCents(draft);
  if (dp != null && dp !== total) {
    reasons.push(
      `The checkout draft price (${dp} cents) does not equal the live catalog total (${total} cents). Re-confirm the price with the user from the catalog.`,
    );
  }
  if (reasons.length) return { rejected: true, stage: "cart", reasons };

  // ── Artwork shape: Layer 1, then Layer 2 ───────────────────────────
  const attempts = Number(input.artwork_attempts ?? 0);
  const resubmitGuidance =
    attempts + 1 >= 2
      ? "This is the second failed artwork attempt. Fix and resubmit once more, or use Live Connect: draft an email for the user to hello@keeg.uk (see the connect prompt) and wait for the operator's reply."
      : "Fix the artwork and call prepare_checkout again with artwork_attempts incremented.";
  const base64 = String(input.artwork_png_base64 ?? "");
  const bytes = decodeBase64(base64);
  const l1 = await checkArtworkL1(bytes);
  if (!l1.pass) {
    return { rejected: true, stage: "artwork_layer_1", reasons: l1.reasons, artwork_facts: l1.facts, artwork_attempts: attempts + 1, next: resubmitGuidance };
  }
  const l2 = await checkArtworkL2(env, {
    base64,
    pitchText: input.pitch_text || session.pitch || "",
    layout: input.layout || session.layout || null,
    item,
  });
  if (l2.unavailable) {
    return {
      error: "artwork_check_unavailable",
      reason: l2.reason,
      next: "The order cannot be prepared while the Layer 2 artwork check is unavailable. Tell the user, or use Live Connect (draft an email to hello@keeg.uk).",
    };
  }
  if (!l2.pass) {
    return {
      rejected: true,
      stage: "artwork_layer_2",
      reasons: l2.reasons,
      ai_transcription: l2.transcription,
      artwork_attempts: attempts + 1,
      next: resubmitGuidance,
    };
  }

  // ── All checks passed: store the artwork, write the prefill ───────
  if (!env?.FILES) return { error: "The private files bucket is not available to the MCP server." };
  const token = newToken();
  const artworkKey = `artwork/${token}.png`;
  await env.FILES.put(artworkKey, bytes, { httpMetadata: { contentType: "image/png" } });

  const lines = [{ product_public_id: product.public_id, variant_public_id: variant?.public_id ?? null, qty, product_id: product.id }];
  const expiresAt = new Date(Date.now() + PREFILL_TTL_DAYS * 86400000).toISOString().replace("T", " ").slice(0, 19);
  await env.DB.prepare(
    `INSERT INTO prefill_carts (token, lines, artwork_key, artwork_name, artwork_size, shipping, total_cents, currency, agent_user_id, session_id, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'usd', ?, ?, 'open', ?)`,
  )
    .bind(
      token,
      JSON.stringify(lines),
      artworkKey,
      "final-print-artwork.png",
      bytes.length,
      JSON.stringify(shipping),
      total,
      authProps?.userId ?? null,
      session.session_id ?? null,
      expiresAt,
    )
    .run();

  return {
    checkout_url: `${SITE}/cart/prefill/${token}`,
    expires_at: expiresAt + " UTC",
    summary: {
      gift_item: item.name,
      variant: variant?.label ?? null,
      quantity: qty,
      total_cents: total,
      currency: "usd",
      ship_to: `${shipping.name}, ${shipping.city}, ${shipping.postal}, ${shipping.country}`,
    },
    artwork: { ...l1.facts, ai_transcription: l2.transcription },
    instruction:
      "Give the user the checkout_url. They open it, the cart is prefilled with the gift item, and they enter their email and payment on the store page — the card never passes through the agent. The approved Final Print Artwork rides the order.",
  };
}
