/**
 * The human leg of the MCP checkout handoff. prepare_checkout (MCP
 * side) validated the order's shape and wrote a prefill_carts row;
 * opening this link sets the visitor's cart cookie from that row,
 * remembers the prefill in a cookie so /checkout can pre-fill the
 * delivery address and attach the approved Final Print Artwork to the
 * order, and lands on the store's checkout entry for its configured
 * payment rail. Payment happens there, by the human, as with any
 * guest checkout.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getOpenPrefill } from '../../../features/orders/prefill';
import { getStoreSettings } from '../../../features/settings/db';
import { defaultMethod, isMethodAvailable } from '../../../features/payments';

const EXPIRED_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Checkout link expired — p2gift</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;background:#f6f4ef;color:#171a1f;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:26rem;padding:2rem;text-align:center}a{color:#0f766e}</style>
</head><body><main>
<h1>This checkout link has expired</h1>
<p>Agent-prefilled checkout links stay open for 7 days and close once used. Ask your agent to prepare the checkout again, or browse the store and check out as usual.</p>
<p><a href="/">Back to the store</a></p>
</main></body></html>`;

export const GET: APIRoute = async ({ params, cookies, redirect, url }) => {
  const token = params.token ?? '';
  const rec = token ? await getOpenPrefill(env.DB, token) : null;
  if (!rec) {
    return new Response(EXPIRED_HTML, {
      status: 410,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
  const items: Record<string, number> = {};
  let count = 0;
  for (const line of rec.lines) {
    const key = line.variant_public_id
      ? `${line.product_public_id}:${line.variant_public_id}`
      : line.product_public_id;
    items[key] = line.qty;
    count += line.qty;
  }
  const secure = url.protocol === 'https:';
  // Same shape + lifetime as writeCart in features/cart/cart.ts.
  cookies.set('cart', { v: 2, items }, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: 60 * 60 * 24 * 30,
  });
  cookies.set('cart_n', String(count), {
    path: '/',
    httpOnly: false,
    sameSite: 'lax',
    secure,
    maxAge: 60 * 60 * 24 * 30,
  });
  cookies.set('prefill', rec.token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: 60 * 60 * 24 * 7,
  });
  // Land where this store actually takes payment: the in-app checkout
  // page serves the demo/lightning/opennode rails and needs its rail
  // named (?method=); a hosted rail (Stripe) starts from the cart
  // page's own checkout button instead. Any doubt → the cart, which
  // is already filled.
  let target = '/cart';
  try {
    const settings = await getStoreSettings(env.DB);
    const method = defaultMethod(settings);
    if (method !== 'stripe' && isMethodAvailable(method, settings)) {
      target = `/checkout?method=${method}`;
    }
  } catch {
    // Settings unreadable — the cart landing still completes the flow.
  }
  return redirect(target, 302);
};
