// Google sign-in for the store admin (/admin/login's "Continue with
// Google" button).
//
// This reuses the SAME Google OAuth client as the browser checkout gate
// (features/auth/checkoutGate.ts): the GOOGLE_CLIENT_ID /
// GOOGLE_CLIENT_SECRET Worker secrets and the already-registered
// redirect URI https://p2gift.keeg.uk/oauth/callback. No new Google-side
// registration is needed — the two flows are told apart by the signed
// `state` payload (kind: "admin-google" here, "gate" at checkout), and
// each claims only its own returns at /oauth/callback.
//
// The security boundary is the allowlist, not the sign-in itself: any
// Google account can complete a Google sign-in (customers do, at the
// checkout gate), so an admin session is minted ONLY when the verified
// Google email appears in the `admin_google_emails` setting (a CSV).
// Absent or empty setting = Google admin sign-in is off (fail closed);
// the password login is unaffected either way.
//
// Success mints the ordinary `admin_session` cookie (features/auth/
// session.ts, bound to the admin credential like the password flow), so
// the middleware gate, session expiry, and password rotation all behave
// exactly as they do for a password sign-in.
//
//   GET  /admin/google     start: signed state + flow cookie -> Google
//   GET  /oauth/callback   tryAdminGoogleCallback() claims the return,
//                          checks the allowlist, sets the session.
import { signToken, verifyToken } from './token';
import {
  errorPage,
  s256,
  upstreamAuthorizeUrl,
  exchangeGoogle,
  oauthCallbackUrl,
} from './oauth';
import { adminCredential } from './admin';
import { signSession, verifySession } from './session';
import { getSetting } from '../settings/db';
import { isAdminEmail } from './adminEmails';

const FLOW_COOKIE = 'p2g_admin_flow';
const FLOW_TTL_SECONDS = 15 * 60;
const SESSION_TTL_SECONDS = 7 * 24 * 3600; // same as the password login
const SESSION_COOKIE = 'admin_session';

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

interface AdminFlow {
  nonce: string;
  verifier: string;
}

export function isAdminGooglePath(pathname: string): boolean {
  return pathname === '/admin/google';
}

/** GET /admin/google — begin the Google sign-in for the admin. */
export async function handleAdminGoogleStart(request: Request, env: Cloudflare.Env): Promise<Response> {
  const cred = await adminCredential(env.DB);
  // No admin password set yet -> bootstrap: the setup wizard is the only
  // door, exactly as /admin/login treats it.
  if (!cred.enabled) {
    return Response.redirect(new URL('/admin/setup', request.url), 302);
  }
  // Already signed in -> straight to the admin, like /admin/login.
  const signingKey = env.AUTH_SECRET || cred.tagSource;
  if (
    await verifySession(readCookie(request, SESSION_COOKIE), signingKey, cred.tagSource, nowSeconds())
  ) {
    return Response.redirect(new URL('/admin', request.url), 302);
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return errorPage("Google sign-in isn't set up on this store yet. Use the admin password instead.");
  }
  if (!env.AUTH_SECRET) {
    return errorPage('Google sign-in is unavailable on this store. Use the admin password instead.', 500);
  }
  const nonce = crypto.randomUUID();
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const flow: AdminFlow = { nonce, verifier };
  const state = await signPayload(env, { kind: 'admin-google', provider: 'google', nonce }, FLOW_TTL_SECONDS);
  const headers = new Headers({
    Location: upstreamAuthorizeUrl(
      'google',
      env.GOOGLE_CLIENT_ID,
      state,
      await s256(verifier),
      oauthCallbackUrl(env),
    ),
  });
  headers.append(
    'set-cookie',
    setCookie(FLOW_COOKIE, await signPayload(env, flow, FLOW_TTL_SECONDS), FLOW_TTL_SECONDS, isSecure(request)),
  );
  return new Response(null, { status: 302, headers });
}

/**
 * Claim a /oauth/callback return whose `state` is an admin-google state.
 * Returns null when the state is not one of ours (the gate and the OAuth
 * authorization server then handle the return as before).
 */
export async function tryAdminGoogleCallback(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  if (!state) return null;
  const statePayload = await verifyPayload<{ kind?: string; nonce?: string }>(env, state);
  if (!statePayload || statePayload.kind !== 'admin-google') return null;

  const backToLogin = errorPage(
    'This sign-in link expired or was opened in another browser. Go back to the admin login and try again.',
  );
  const flow = await verifyPayload<AdminFlow>(env, readCookie(request, FLOW_COOKIE));
  if (!flow || flow.nonce !== statePayload.nonce) return backToLogin;
  if (url.searchParams.get('error')) {
    return errorPage('The Google sign-in was cancelled. Go back to the admin login and try again.');
  }

  let identity: { userId: string; email?: string; name?: string };
  try {
    identity = await exchangeGoogle(url.searchParams.get('code'), { verifier: flow.verifier }, env);
  } catch (err) {
    console.error('Admin Google sign-in exchange failed:', err);
    return errorPage('Sign-in failed at Google. Go back to the admin login and try again.', 502);
  }

  // The allowlist is the whole boundary: a verified Google identity that
  // is not on it gets no session, ever.
  const allowlist = await getSetting(env.DB, 'admin_google_emails');
  if (!isAdminEmail(allowlist, identity.email)) {
    return errorPage(
      'That Google account is not an admin for this store. Sign in with an admin account, or use the admin password.',
      403,
    );
  }

  const cred = await adminCredential(env.DB);
  if (!cred.enabled) {
    return Response.redirect(new URL('/admin/setup', request.url), 302);
  }
  const signingKey = env.AUTH_SECRET || cred.tagSource;
  const token = await signSession(signingKey, cred.tagSource, SESSION_TTL_SECONDS, nowSeconds());
  const secure = isSecure(request);
  const headers = new Headers({ Location: new URL('/admin', request.url).toString() });
  headers.append('set-cookie', setCookie(SESSION_COOKIE, token, SESSION_TTL_SECONDS, secure));
  headers.append('set-cookie', setCookie(FLOW_COOKIE, '', 0, secure));
  return new Response(null, { status: 302, headers });
}
