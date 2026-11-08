import { handle } from '@astrojs/cloudflare/handler';
import { env } from 'cloudflare:workers';
import { createOAuthServers, handleOAuthRequest, isOAuthPath } from './features/auth/oauth';
import { sweepStaleNotifications } from './features/email/outbox';
import { releaseExpiredReservations } from './features/orders/reservations';
import { getSetting } from './features/settings/db';

// OAuth 2.1 (v0.2.0): this Worker is both the authorization server and the
// MCP resource server. The servers are pure config (no I/O), so they are
// built per OAuth request from that request's env — local dev overrides the
// issuer/resource via .dev.vars, which is why they can't be built once at
// cold start.

/**
 * Worker entrypoint.
 *
 * `fetch` is Astro's, unchanged — this file exists only so the Worker can also
 * export `scheduled`. (Astro's adapter generates the entry otherwise; the
 * wrangler `main` pointing here is what swaps it. See the Cloudflare adapter's
 * custom-entrypoint docs.)
 *
 * WHY a cron at all: every recurring job in minshop was previously driven by
 * incoming traffic — the notification sweep piggybacks on live settlements, and
 * expired inventory holds are released by the NEXT shopper's reservation. That
 * inverts the risk: the quieter the store, the longer a failed confirmation
 * email goes unretried and the longer sold-out-looking stock stays locked. A
 * store with one order a day could sit a full day in that state.
 *
 * Everything here is idempotent and bounded, because a cron can overlap a live
 * request doing the same work: the notification claim is a conditional UPDATE,
 * and reservation release is guarded per row. Nothing below is exclusive to the
 * cron — it is the same code the request paths call, just on a clock.
 */
async function runScheduledSweeps(): Promise<void> {
  const db = env.DB;

  // Inventory first: it needs no configuration and it is the one that silently
  // costs sales, since held stock reads as sold out to every shopper.
  try {
    await releaseExpiredReservations(db, 50);
  } catch (err) {
    console.error('Scheduled reservation sweep failed:', err);
  }

  // Notification retry needs an origin to build order links with, and a cron
  // has no request to take one from. rememberStoreUrl records it from live
  // traffic; until a first order has flowed there is nothing queued to retry
  // anyway, so skipping is correct rather than merely safe. Never guess here —
  // a wrong origin sends real customers dead links.
  try {
    const origin = await getSetting(db, 'store_url');
    if (origin) {
      await sweepStaleNotifications(db, origin);
    }
  } catch (err) {
    console.error('Scheduled notification sweep failed:', err);
  }
}

export default {
  // OAuth + MCP paths are routed before Astro: /mcp goes through the token
  // check in the resource server, /authorize and the /oauth/* protocol
  // endpoints go to the authorization server, and everything else is the
  // storefront. /health, /inventory and /connect stay public Astro routes.
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Promise<Response> {
    if (isOAuthPath(new URL(request.url).pathname)) {
      const oauthResponse = await handleOAuthRequest(request, env, ctx, createOAuthServers(env));
      if (oauthResponse) return oauthResponse;
    }
    return handle(request, env, ctx);
  },

  // Each sweep catches its own errors, so one failing job never strands the
  // others. waitUntil keeps the invocation alive for the whole pass.
  scheduled(_controller, _env, ctx) {
    ctx.waitUntil(runScheduledSweeps());
  },
  // Bindings are reached through the `cloudflare:workers` env import (as every
  // other module here does), so the handler itself needs no Env generic.
} satisfies ExportedHandler<Cloudflare.Env>;
