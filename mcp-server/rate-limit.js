// Rate limits for the open MCP endpoint (v0.3.0 auth model).
//
// /mcp no longer requires a sign-in: the agent works token-free, and
// abuse control moves to (a) these KV-counter rate limits and (b) the
// browser sign-in gate at checkout (see src/features/auth/checkoutGate.ts).
// Two buckets:
//   - general: every /mcp POST, per client IP — catalog reads, workflow
//     steps, resource reads. Generous: a full order flow is ~15 calls.
//   - prepare_checkout: the costly call (Workers AI artwork check +
//     R2/D1 writes), per IP AND per workflow session id. A handful per
//     order is normal (initial try + a couple of artwork fixes).
//
// Counters live in OAUTH_KV (already bound for the OAuth/SMS guards)
// with a sliding one-hour window — same pattern as the SMS send caps
// in src/features/auth/oauth.ts. When the KV binding is absent (local
// standalone runs, the check harness), the limiter steps aside: it is
// an abuse guard, not an auth gate, and local development has no
// abuser. Production always has the binding.

const WINDOW_SECONDS = 60 * 60;
export const MCP_GENERAL_LIMIT_PER_HOUR = 300;
export const MCP_PREPARE_CHECKOUT_LIMIT_PER_HOUR = 10;

async function kvCount(env, key) {
  const raw = await env.OAUTH_KV.get(key);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Check (and, when allowed, record) one hit against a bucket.
 * Returns true when the hit is within the limit.
 */
export async function rateLimitHit(env, bucket, key, limit) {
  if (!env?.OAUTH_KV || !key) return true;
  const kvKey = `mcp-rl:${bucket}:${key}`;
  try {
    const count = await kvCount(env, kvKey);
    if (count >= limit) return false;
    await env.OAUTH_KV.put(kvKey, String(count + 1), { expirationTtl: WINDOW_SECONDS });
    return true;
  } catch {
    // A KV hiccup must not take the service down; the checkout gate
    // still protects everything costly or irreversible.
    return true;
  }
}

export function clientIp(request) {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}
