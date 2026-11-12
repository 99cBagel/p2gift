// Browser checkout gate (v0.3.0 auth model).
//
// The MCP service is open — the agent needs no token. Everything costly
// or irreversible instead waits for a human in a real browser: when a
// checkout was prepared by an agent (an open prefill), the buyer must
// sign in here — Google, GitHub, or a US phone code — right before
// paying. The sign-in reuses the authorization server's upstream
// machinery (src/features/auth/oauth.ts: the same provider exchanges,
// the same Twilio Verify flow, the same rate caps) but finishes as a
// first-party session cookie instead of an OAuth token grant:
//
//   GET  /checkout/signin    the gate page (three sign-in options)
//   POST /checkout/signin    Google/GitHub -> upstream redirect, with a
//                            signed `state` (kind: "gate") and the flow
//                            kept in a signed cookie; SMS -> Twilio code
//   POST /checkout/sms-check code check -> signed sms_token -> callback
//   GET  /oauth/callback     tryGateCallback() here claims the return
//                            when `state` is a gate state (the OAuth
//                            library's own flow never sees it) ->
//                            gate session cookie -> back to checkout
//
// The gate session cookie (p2g_gate) is a signed token carrying the
// verified identity { userId, email?, name?, provider }. The checkout
// surfaces (checkout page, cart, /api/checkout) require it whenever an
// open prefill is in play, and the identity is recorded on the prefill
// row (migration 0042) as the order's verified contact.
import { signToken, verifyToken } from './token';
import {
  escapeHtml,
  errorPage,
  s256,
  upstreamAuthorizeUrl,
  exchangeGoogle,
  exchangeGitHub,
  normalizeUsPhone,
  twilioConfigured,
  twilioSendCode,
  twilioCheckCode,
  smsSendAllowed,
  smsSendRecord,
  oauthCallbackUrl,
  oauthIssuer,
} from './oauth';
import { getOpenPrefill } from '../orders/prefill';

export interface GateIdentity {
  userId: string;
  email?: string;
  name?: string;
  provider: 'google' | 'github' | 'sms';
}

export const GATE_COOKIE = 'p2g_gate';
const FLOW_COOKIE = 'p2g_gate_flow';
// The gate session only has to outlive one checkout; two hours covers a
// slow payer without becoming a standing login.
const GATE_TTL_SECONDS = 2 * 60 * 60;
// Same 15 minutes as the SMS proof token and the prefill link itself.
const FLOW_TTL_SECONDS = 15 * 60;
const SMS_TOKEN_TTL_SECONDS = 15 * 60;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(header);
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  const base = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  return secure ? `${base}; Secure` : base;
}

function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

/** Only same-origin paths may be a post-sign-in destination. */
function sanitizeNext(raw: string | null | undefined): string {
  const next = (raw ?? '').trim();
  if (next.startsWith('/') && !next.startsWith('//')) return next;
  return '/cart';
}

interface GateFlow {
  provider: 'google' | 'github' | 'sms';
  nonce: string;
  next: string;
  verifier?: string;
  phone?: string;
}

async function signPayload(env: Cloudflare.Env, payload: unknown, ttlSeconds: number): Promise<string> {
  if (!env.AUTH_SECRET) throw new Error('AUTH_SECRET is not configured');
  return signToken(JSON.stringify(payload), env.AUTH_SECRET, ttlSeconds, nowSeconds());
}

async function verifyPayload<T>(env: Cloudflare.Env, token: string | null): Promise<T | null> {
  if (!token || !env.AUTH_SECRET) return null;
  const raw = await verifyToken(token, env.AUTH_SECRET, nowSeconds());
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** The verified gate identity from a raw p2g_gate cookie value, or null. */
export async function parseGateIdentity(
  cookieValue: string | null | undefined,
  env: Cloudflare.Env,
): Promise<GateIdentity | null> {
  const identity = await verifyPayload<GateIdentity>(env, cookieValue ?? null);
  if (!identity || typeof identity.userId !== 'string' || !identity.userId) return null;
  if (identity.provider !== 'google' && identity.provider !== 'github' && identity.provider !== 'sms') {
    return null;
  }
  return identity;
}

/** The verified gate identity for a raw Request (API routes), or null. */
export async function gateIdentityForRequest(
  request: Request,
  env: Cloudflare.Env,
): Promise<GateIdentity | null> {
  return parseGateIdentity(readCookie(request, GATE_COOKIE), env);
}

export function isGatePath(pathname: string): boolean {
  return pathname === '/checkout/signin' || pathname === '/checkout/sms-check';
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function gatePage(env: Cloudflare.Env, next: string, message?: string): string {
  const googleOff = env.GOOGLE_CLIENT_ID ? '' : ' disabled';
  const githubOff = env.GITHUB_CLIENT_ID ? '' : ' disabled';
  const smsOff = twilioConfigured(env) ? '' : ' disabled';
  return `<!doctype html>
<meta charset="utf-8">
<title>Sign in to check out — p2gift</title>
<h1>One quick sign-in before payment</h1>
<p>Your agent prepared this gift checkout for you. Sign in to confirm it's you — then you'll see the locked price and cart and pay on the store page. Your card is only ever entered on the payment page, never with the agent.</p>
${message ? `<p><strong>${escapeHtml(message)}</strong></p>` : ''}
<form method="post" action="/checkout/signin">
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <p>
    <button name="provider" value="google"${googleOff}>Continue with Google</button>${googleOff ? ' <small>(not set up yet)</small>' : ''}
  </p>
  <p>
    <button name="provider" value="github"${githubOff}>Continue with GitHub</button>${githubOff ? ' <small>(not set up yet)</small>' : ''}
  </p>
  <p>
    <label>Mobile number (US only) <input type="tel" name="phone" placeholder="+1 415 555 0132"></label>
    <button name="provider" value="sms"${smsOff}>Text me a sign-in code</button>${smsOff ? ' <small>(not set up yet)</small>' : ''}
  </p>
</form>`;
}

function gateSmsCodePage(state: string, phone: string, next: string, message?: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>Enter your sign-in code — p2gift</title>
<h1>Enter your sign-in code</h1>
<p>We texted a 6-digit code to <strong>${escapeHtml(phone)}</strong>. It expires in 10 minutes.</p>
${message ? `<p><strong>${escapeHtml(message)}</strong></p>` : ''}
<form method="post" action="/checkout/sms-check">
  <input type="hidden" name="state" value="${escapeHtml(state)}">
  <input type="hidden" name="phone" value="${escapeHtml(phone)}">
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <p><label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" autofocus></label></p>
  <p>
    <button name="action" value="check">Verify code</button>
    <button name="action" value="resend">Send a new code</button>
  </p>
</form>`;
}

function htmlPage(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleGateRequest(request: Request, env: Cloudflare.Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/checkout/sms-check') return handleGateSmsCheck(request, env);
  // /checkout/signin
  if (request.method === 'POST') return handleGateSigninPost(request, env);
  const next = sanitizeNext(url.searchParams.get('next'));
  // Already signed in: the gate is satisfied, go straight back.
  if (await gateIdentityForRequest(request, env)) {
    return Response.redirect(new URL(next, url), 302);
  }
  return htmlPage(gatePage(env, next));
}

async function handleGateSigninPost(request: Request, env: Cloudflare.Env): Promise<Response> {
  const form = await request.formData();
  const provider = String(form.get('provider') ?? '');
  const next = sanitizeNext(String(form.get('next') ?? ''));
  const nonce = crypto.randomUUID();
  const secure = isSecure(request);

  if (provider === 'google' || provider === 'github') {
    const clientId = provider === 'google' ? env.GOOGLE_CLIENT_ID : env.GITHUB_CLIENT_ID;
    const clientSecret =
      provider === 'google' ? env.GOOGLE_CLIENT_SECRET : env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return errorPage(
        `${provider === 'google' ? 'Google' : 'GitHub'} sign-in isn't set up on this store yet.`,
      );
    }
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const flow: GateFlow = { provider, nonce, next, verifier };
    const state = await signPayload(env, { kind: 'gate', provider, nonce }, FLOW_TTL_SECONDS);
    const headers = new Headers({
      Location: upstreamAuthorizeUrl(provider, clientId, state, await s256(verifier), oauthCallbackUrl(env)),
    });
    headers.append('set-cookie', setCookie(FLOW_COOKIE, await signPayload(env, flow, FLOW_TTL_SECONDS), FLOW_TTL_SECONDS, secure));
    return new Response(null, { status: 302, headers });
  }

  if (provider === 'sms') {
    const phone = normalizeUsPhone(String(form.get('phone') ?? ''));
    if (!phone) return errorPage('Enter a US mobile number, like +1 415 555 0132.');
    if (!twilioConfigured(env)) return errorPage("Text sign-in isn't set up on this store yet.");
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (!(await smsSendAllowed(env, phone, ip))) {
      return errorPage('Too many codes sent to this number just now. Wait a little and try again.', 429);
    }
    const flow: GateFlow = { provider: 'sms', nonce, next, phone };
    const state = await signPayload(env, { kind: 'gate', provider: 'sms', nonce }, FLOW_TTL_SECONDS);
    if (!(await twilioSendCode(env, phone))) {
      console.error('Checkout gate SMS send failed');
      return errorPage('The sign-in code could not be sent. Try again.', 502);
    }
    await smsSendRecord(env, phone, ip);
    const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
    headers.append('set-cookie', setCookie(FLOW_COOKIE, await signPayload(env, flow, FLOW_TTL_SECONDS), FLOW_TTL_SECONDS, secure));
    return new Response(gateSmsCodePage(state, phone, next), { headers, status: 200 });
  }

  return errorPage('Choose a sign-in method: Google, GitHub, or text message.');
}

async function handleGateSmsCheck(request: Request, env: Cloudflare.Env): Promise<Response> {
  if (request.method !== 'POST') {
    return errorPage('Use the sign-in page to request a code.', 405);
  }
  const form = await request.formData();
  const state = String(form.get('state') ?? '');
  const phone = normalizeUsPhone(String(form.get('phone') ?? ''));
  const code = String(form.get('code') ?? '').trim();
  const action = String(form.get('action') ?? 'check');
  const next = sanitizeNext(String(form.get('next') ?? ''));
  if (!state || !phone) {
    return errorPage('This sign-in expired. Go back to the checkout and sign in again.');
  }
  if (!twilioConfigured(env) || !env.AUTH_SECRET) {
    return errorPage("Text sign-in isn't set up on this store yet.");
  }
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (action === 'resend') {
    if (!(await smsSendAllowed(env, phone, ip))) {
      return htmlPage(gateSmsCodePage(state, phone, next, 'Too many codes sent just now. Wait a little and try again.'), 429);
    }
    if (!(await twilioSendCode(env, phone))) {
      return errorPage('The sign-in code could not be sent. Try again.', 502);
    }
    await smsSendRecord(env, phone, ip);
    return htmlPage(gateSmsCodePage(state, phone, next, 'A new code was sent.'));
  }
  if (!/^\d{4,8}$/.test(code)) {
    return htmlPage(gateSmsCodePage(state, phone, next, 'Enter the 6-digit code from the text.'));
  }
  if (!(await twilioCheckCode(env, phone, code))) {
    return htmlPage(gateSmsCodePage(state, phone, next, "That code didn't match. Try again, or send a new code."));
  }
  const smsToken = await signToken(
    JSON.stringify({ phone, state }),
    env.AUTH_SECRET,
    SMS_TOKEN_TTL_SECONDS,
    nowSeconds(),
  );
  const location = `${oauthIssuer(env)}/oauth/callback?state=${encodeURIComponent(state)}&sms_token=${encodeURIComponent(smsToken)}`;
  return Response.redirect(location, 302);
}

/**
 * Claim a /oauth/callback return whose `state` is a gate state.
 * Returns null when the state is not one of ours (the OAuth library's
 * own authorization flow then handles the return as before).
 */
export async function tryGateCallback(request: Request, env: Cloudflare.Env): Promise<Response | null> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  if (!state) return null;
  const statePayload = await verifyPayload<{ kind?: string; provider?: string; nonce?: string }>(env, state);
  if (!statePayload || statePayload.kind !== 'gate') return null;

  const flow = await verifyPayload<GateFlow>(env, readCookie(request, FLOW_COOKIE));
  if (!flow || flow.nonce !== statePayload.nonce || flow.provider !== statePayload.provider) {
    return errorPage(
      'This sign-in link expired or was opened in another browser. Go back to the checkout and sign in again.',
    );
  }
  if (url.searchParams.get('error')) {
    return errorPage('The sign-in was cancelled at the provider. Go back to the checkout and try again.');
  }

  let identity: GateIdentity;
  try {
    if (flow.provider === 'google') {
      const id = await exchangeGoogle(url.searchParams.get('code'), { verifier: flow.verifier }, env);
      identity = { ...id, provider: 'google' };
    } else if (flow.provider === 'github') {
      const id = await exchangeGitHub(url.searchParams.get('code'), { verifier: flow.verifier }, env);
      identity = { ...id, provider: 'github' };
    } else {
      // SMS: the code check signed a short-lived token binding the
      // phone to this exact state (same proof as the OAuth flow's).
      const smsToken = url.searchParams.get('sms_token');
      const payload = await verifyPayload<{ phone?: string; state?: string }>(env, smsToken);
      if (!payload || payload.state !== state || !payload.phone || payload.phone !== flow.phone) {
        throw new Error('sms token does not match this sign-in');
      }
      identity = { userId: payload.phone, provider: 'sms' };
    }
  } catch (err) {
    console.error('Checkout gate sign-in exchange failed:', err);
    return errorPage('Sign-in failed at the provider. Go back to the checkout and try again.', 502);
  }

  const secure = isSecure(request);
  const headers = new Headers({ Location: new URL(flow.next, url).toString() });
  headers.append(
    'set-cookie',
    setCookie(GATE_COOKIE, await signPayload(env, identity, GATE_TTL_SECONDS), GATE_TTL_SECONDS, secure),
  );
  headers.append('set-cookie', setCookie(FLOW_COOKIE, '', 0, secure));

  // Record the verified identity on the open prefill, if this browser
  // carries one: it is the order's verified contact (migration 0042).
  // Bookkeeping only — a failure here must not strand a signed-in buyer.
  try {
    const prefillToken = readCookie(request, 'prefill');
    if (prefillToken && env.DB) {
      const rec = await getOpenPrefill(env.DB, prefillToken);
      if (rec) {
        await env.DB.prepare(
          `UPDATE prefill_carts SET gate_user_id = ?, gate_email = ?, gate_provider = ? WHERE token = ? AND status = 'open'`,
        )
          .bind(identity.userId, identity.email ?? null, identity.provider, rec.token)
          .run();
      }
    }
  } catch (err) {
    console.error('Recording gate identity on prefill failed:', err);
  }

  return new Response(null, { status: 302, headers });
}
