// Wizard checkout + confirmation + lookup (Stages 7–9).
//
// prepare_checkout(session_id) builds the cart from the LOCKED
// session row — gift, variant, quantity (1 unless an order-details
// lock set one), and the artwork parked at the artwork lock —
// prices it from D1, writes the prefill_carts row, and returns the
// signed checkout link. There is no order-details stage in the
// flex-menu dialog (owner decision 2026-11-14): the delivery
// address is collected by Stripe on its checkout page, never by
// the agent. The only identity check in the wizard sits inside
// this stage, in the browser, at the store's OAuth gate (v0.3.0,
// unchanged). No automated artwork check runs here: the artwork
// stage accepted the file as-is (owner decision 2026-11-13), so
// checkout cannot reject what that stage accepted.
//
// Confirmation is pull, never push: get_order_status links the
// session to its order through the prefill token (the checkout API
// consumes the prefill for the order's own cart), then reads the
// orders table — which settles from the Stripe webhook only.
// The browser redirect is never proof of payment.

import { loadRow, patch, sessionView, NEXT_STEP, SITE } from "./session.js";
import { loadInventory } from "./inventory.js";

const PREFILL_TTL_MS = 15 * 60 * 1000;
const TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function newPrefillToken() {
  const buf = new Uint8Array(20);
  crypto.getRandomValues(buf);
  return "pf_" + [...buf].map((b) => TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]).join("");
}

// ── Stage 7 · Checkout ──────────────────────────────────────────────
export async function prepareCheckoutFromSession(env, authProps, { sessionId }) {
  const { row, error } = await loadRow(env, sessionId);
  if (error) return { error };
  if (row.state === "CHECKOUT_ISSUED" || row.state === "ORDER_CONFIRMED") {
    // Re-issuing is how an expired link is replaced (spec, Stage 8
    // branches): fall through and mint a fresh prefill from the
    // locked data. Before settlement this changes nothing else.
    if (row.state === "ORDER_CONFIRMED") {
      return {
        error: `Session ${row.id} is already ORDER_CONFIRMED (order ${row.order_public_id}).`,
        session: sessionView(row),
      };
    }
  } else if (row.state !== "DETAILS_LOCKED" && row.state !== "ARTWORK_LOCKED") {
    return {
      error: `Session ${row.id} is at ${row.state}; prepare_checkout is not the open step.`,
      session: sessionView(row),
      next: NEXT_STEP[row.state] ?? null,
    };
  }

  const { items } = await loadInventory(env);
  const item = items.find((i) => i.id === row.gift_item_id);
  const product = await env.DB.prepare(
    "SELECT id, public_id, name, price_cents, stock, active FROM products WHERE id = ?",
  )
    .bind(row.product_id)
    .first();
  if (!item || !product?.active) {
    return { rejected: true, stage: "cart", reasons: ["The locked gift item is no longer sold in the store. Start a new session."] };
  }
  let variant = null;
  let unitPrice = product.price_cents;
  let stock = product.stock;
  if (row.variant_label) {
    variant = await env.DB.prepare(
      "SELECT id, public_id, label, price_cents, stock FROM product_variants WHERE product_id = ? AND active = 1 AND lower(label) = lower(?)",
    )
      .bind(product.id, row.variant_label)
      .first();
    if (!variant) {
      return { rejected: true, stage: "cart", reasons: [`Variant "${row.variant_label}" no longer exists for ${item.name}.`] };
    }
    unitPrice = variant.price_cents;
    stock = variant.stock;
  }
  // No order-details stage in the dialog: quantity is whatever an
  // optional set_order_details lock set, else 1.
  const qty = row.quantity ?? 1;
  if (!Number.isInteger(qty) || qty < 1 || qty > stock) {
    return { rejected: true, stage: "cart", reasons: [`Only ${stock} of ${item.name} in stock — the quantity ${qty} cannot be filled.`] };
  }
  const total = unitPrice * qty;
  const shipping = JSON.parse(row.shipping);

  const token = newPrefillToken();
  const lines = [{ product_public_id: product.public_id, variant_public_id: variant?.public_id ?? null, qty, product_id: product.id }];
  const expiresAt = new Date(Date.now() + PREFILL_TTL_MS).toISOString().replace("T", " ").slice(0, 19);
  const customer = row.customer ? JSON.parse(row.customer) : null;
  await env.DB.prepare(
    `INSERT INTO prefill_carts (token, lines, artwork_key, artwork_name, artwork_size, shipping, total_cents, currency, agent_user_id, session_id, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'usd', ?, ?, 'open', ?)`,
  )
    .bind(
      token,
      JSON.stringify(lines),
      row.artwork_key,
      row.artwork_name ?? "final-print-artwork.png",
      row.artwork_size,
      row.shipping,
      total,
      customer?.userId ?? authProps?.userId ?? null,
      row.id,
      expiresAt,
    )
    .run();
  await patch(env, row.id, { state: "CHECKOUT_ISSUED", prefill_token: token });
  const { row: updated } = await loadRow(env, row.id);

  // Checkout gate state (runtime setting `checkout_gate_enabled`):
  // '0' = off — the buyer goes straight to payment and Stripe's
  // email + payment collection is the signing. Absent/on = the
  // browser OAuth sign-in inside checkout.
  let gateOff = false;
  try {
    const gateRow = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'checkout_gate_enabled'",
    ).first();
    gateOff = gateRow?.value === "0";
  } catch { /* a settings read failure leaves the gate wording at its default */ }

  return {
    session: sessionView(updated),
    state: updated.state,
    checkout_url: `${SITE}/cart/prefill/${token}`,
    expires_at: expiresAt + " UTC",
    summary: {
      gift_item: item.name,
      variant: variant?.label ?? null,
      quantity: qty,
      total_cents: total,
      currency: "usd",
      ship_to: shipping ? `${shipping.name}, ${shipping.city}, ${shipping.postal}, ${shipping.country}` : null,
    },
    instruction: gateOff
      ? "Give the user the checkout_url now — it expires in about 15 minutes. Inside checkout, in the browser: the user sees the locked price and cart and pays on the store page — Stripe collects the email, the delivery address and the card there, and the payment is the signing (this store's OAuth gate is off); the card never passes through the agent. Then poll get_order_status until the store confirms — the checkout page itself is not proof of payment."
      : "Give the user the checkout_url now — it expires in about 15 minutes. Inside checkout, in the browser: the user signs in with OAuth (the only sign-in in the wizard), sees the locked price and cart, and pays on the store page — Stripe collects the email, the delivery address and the card there; the card never passes through the agent. Then poll get_order_status until the store confirms — the checkout page itself is not proof of payment.",
    next: NEXT_STEP.CHECKOUT_ISSUED,
  };
}

// ── Order reading (Stages 8–9) ──────────────────────────────────────

function expectedDelivery(order) {
  // [order date + the gift item's Lead_Time] — the store-computed
  // estimate until a shipment's carrier ETA replaces it.
  if (!order.paid_at || order.lead_time_days == null) return null;
  const d = new Date(String(order.paid_at).replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Number(order.lead_time_days));
  return d.toISOString().slice(0, 10);
}

function isoUtc(sqlTs) {
  if (!sqlTs) return null;
  return String(sqlTs).replace(" ", "T") + "Z";
}

const ORDER_COLS = `o.public_id, o.status, o.amount_total_cents, o.currency,
  o.provider_session_id AS stripe_session_id, o.created_at, o.fulfillment_status, o.tracking_carrier,
  o.tracking_number, o.fulfilled_at, o.ship_address,
  (SELECT oi.name FROM order_items oi WHERE oi.order_id = o.id ORDER BY oi.id LIMIT 1) AS item_name,
  (SELECT p.lead_time_days FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = o.id AND oi.product_id IS NOT NULL ORDER BY oi.id LIMIT 1) AS lead_time_days,
  (SELECT g.access_token FROM order_guest_access g WHERE g.order_public_id = o.public_id LIMIT 1) AS access_token`;

async function orderByPublicId(env, publicId) {
  return env.DB.prepare(`SELECT ${ORDER_COLS} FROM orders o WHERE o.public_id = ?`).bind(publicId).first();
}

// Link a session to its order: an order belongs to this session when
// it was created from the session's prefill — the checkout API
// applies the prefill to the order's own cart. When the session
// locked an address (the optional order-details path), the primary
// match is the gift product + recipient snapshot + amount; with no
// locked address (the dialog flow — Stripe collects it), the
// fallback below carries the match.
async function linkSessionOrder(env, row) {
  if (row.order_public_id) return orderByPublicId(env, row.order_public_id);
  if (!row.prefill_token) return null;
  const prefill = await env.DB.prepare("SELECT status, total_cents, consumed_at FROM prefill_carts WHERE token = ?")
    .bind(row.prefill_token)
    .first();
  if (!prefill || prefill.status !== "consumed") return null;
  const candidates = await env.DB.prepare(
    `SELECT ${ORDER_COLS} FROM orders o
      WHERE o.created_at >= ?
        AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.product_id = ?)
      ORDER BY o.created_at ASC LIMIT 10`,
  )
    .bind(row.created_at, row.product_id)
    .all();
  const lockedShip = row.shipping ? JSON.parse(row.shipping) : null;
  if (lockedShip) {
    for (const order of candidates.results ?? []) {
      let ship = null;
      try {
        ship = JSON.parse(order.ship_address);
      } catch {
        continue;
      }
      if (
        ship &&
        ship.name === lockedShip.name &&
        ship.line1 === lockedShip.line1 &&
        ship.postal === lockedShip.postal &&
        order.amount_total_cents === prefill.total_cents
      ) {
        await patch(env, row.id, { order_public_id: order.public_id });
        return order;
      }
    }
  }
  // Fallback: with no locked address to match (the dialog flow, or
  // store shipping disabled), the consumed prefill is single-use and
  // bound to this session, so an order for the locked product at the
  // prefill total, created in the window right after consumption and
  // not claimed by another wizard session, is this session's order.
  if (prefill.consumed_at) {
    const t0 = Date.parse(String(prefill.consumed_at).replace(" ", "T") + "Z");
    const t1 = t0 + 2 * 60 * 60 * 1000;
    for (const order of candidates.results ?? []) {
      const t = Date.parse(String(order.created_at).replace(" ", "T") + "Z");
      if (order.amount_total_cents !== prefill.total_cents || !(t >= t0 && t <= t1)) continue;
      const claimed = await env.DB.prepare(
        "SELECT 1 AS one FROM wizard_sessions WHERE order_public_id = ? AND id != ?",
      )
        .bind(order.public_id, row.id)
        .first();
      if (claimed) continue;
      await patch(env, row.id, { order_public_id: order.public_id });
      return order;
    }
  }
  return null;
}

function fulfillmentLadder(order) {
  const paid = order.status === "paid" || order.status === "refunded";
  return [
    { stage: "paid", done: paid, at: paid ? isoUtc(order.created_at) : null },
    { stage: "print_ordered", done: null, note: "Lights up when the operator's print feed (R3) lands." },
    { stage: "received_by_operator", done: null, note: "Lights up when the operator's print feed (R3) lands." },
    {
      stage: "shipped",
      done: order.fulfillment_status === "fulfilled",
      at: order.fulfilled_at ? isoUtc(order.fulfilled_at) : null,
      tracking: order.tracking_number ? { carrier: order.tracking_carrier, number: order.tracking_number } : null,
    },
    { stage: "delivered", done: null, note: "Carrier-confirmed delivery is not tracked yet." },
  ];
}

function orderView(order) {
  const paid = order.status === "paid" || order.status === "refunded";
  return {
    order_id: order.public_id,
    status: order.status,
    item: order.item_name,
    amount_cents: order.amount_total_cents,
    currency: order.currency,
    paid_at: paid ? isoUtc(order.created_at) : null,
    payment_method: paid ? "Card" : null,
    stripe_session_ref: order.stripe_session_id ?? null,
    expected_delivery_date: expectedDelivery({ ...order, paid_at: paid ? order.created_at : null }),
    lead_time_days: order.lead_time_days ?? null,
    fulfillment: fulfillmentLadder(order),
    order_page_url: order.access_token ? `${SITE}/order/${order.access_token}` : null,
    order_token: order.access_token ?? null,
  };
}

// ── Stage 8 · Confirmation ──────────────────────────────────────────
export async function getOrderStatus(env, { sessionId }) {
  const { row, error } = await loadRow(env, sessionId);
  if (error) return { error };
  if (row.state !== "CHECKOUT_ISSUED" && row.state !== "ORDER_CONFIRMED") {
    return {
      error: `Session ${row.id} is at ${row.state}; there is no checkout to confirm yet.`,
      session: sessionView(row),
      next: NEXT_STEP[row.state] ?? null,
    };
  }
  const order = await linkSessionOrder(env, row);
  if (!order) {
    return {
      session: sessionView(row),
      state: row.state,
      order_status: "not_created",
      instruction:
        "No order has been created from this session's checkout link yet. If the link expired, call prepare_checkout again to re-issue it from the locked session. Never report a payment the store has not confirmed.",
    };
  }
  const view = orderView(order);
  if ((order.status === "paid" || order.status === "refunded") && row.state !== "ORDER_CONFIRMED") {
    await patch(env, row.id, { state: "ORDER_CONFIRMED" });
  }
  const { row: updated } = await loadRow(env, row.id);
  if (order.status === "paid") {
    return {
      session: sessionView(updated),
      state: updated.state,
      confirmation: {
        payment: {
          headline: "Here is payment confirmation:",
          order_id: view.order_id,
          amount_cents: view.amount_cents,
          currency: view.currency,
          paid_at: view.paid_at,
          method: "Card",
          stripe_session_ref: view.stripe_session_ref,
        },
        delivery: {
          headline: `Here is expected delivery date ${view.expected_delivery_date ?? "(the gift item has no Lead_Time set yet)"}`,
          expected_delivery_date: view.expected_delivery_date,
          lead_time_days: view.lead_time_days,
          basis: "order date + the gift item's Lead_Time; the carrier's date replaces it once the order ships",
        },
        lookup: {
          headline: "You can lookup status of this order, here is the related skill: p2gift-order-lookup",
          skill: "p2gift-order-lookup",
          order_id: view.order_id,
          order_token: view.order_token,
          order_page_url: view.order_page_url,
        },
      },
      instruction:
        "Report the confirmation to the user in the three parts above. The customer also receives the store's order confirmation email.",
    };
  }
  return {
    session: sessionView(updated),
    state: updated.state,
    order_status: order.status,
    order: view,
    instruction:
      order.status === "refunded"
        ? "This order was refunded. Report that plainly; do not present it as a live order."
        : "The order exists but the store has not confirmed payment. Keep polling with backoff, or report 'not confirmed yet' — never claim success from the checkout page.",
  };
}

// ── Stage 9 · Order lookup (no wizard session needed) ───────────────
export async function lookupOrder(env, { orderId, orderToken }) {
  if (!orderId || !orderToken) {
    return { error: "lookup_order needs the order # and the order token (both are in the Stage 8 confirmation and on the customer's order page)." };
  }
  const order = await orderByPublicId(env, String(orderId).trim().toLowerCase());
  if (!order || !order.access_token || order.access_token !== String(orderToken).trim()) {
    return { error: "No order matches that order # and token." };
  }
  const view = orderView(order);
  return {
    order: view,
    status_summary:
      order.status === "paid"
        ? `Paid ✓ — ${view.item ?? "your gift"} is in the print-and-ship chain. Expected delivery date: ${view.expected_delivery_date ?? "not computable yet (no Lead_Time set on the gift item)"}.`
        : `Order status: ${order.status}.`,
    instruction: "Report the stage and the expected delivery date. Full detail is on the order page (order_page_url).",
  };
}
