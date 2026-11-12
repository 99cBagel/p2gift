// OAuth 2.1 authorization for p2gift (v0.2.0; re-scoped in v0.3.0).
//
// Same-Worker topology: this Worker hosts the authorization server (signs
// users in, issues tokens). Through v0.2.x it also acted as the resource
// server gating /mcp. In the v0.3.0 model /mcp is OPEN (token-free, rate
// limited — see mcp-server/index.js), and this authorization server's
// sign-in machinery (Google first, GitHub second, SMS third) instead
// serves the browser checkout gate (src/features/auth/checkoutGate.ts):
// the human signs in here, in the browser, right before paying. The
// resource-server object is kept for its metadata route and for a
// possible future re-gating; cleanup waits until the new flow verifies.
//
// Routing (owned by src/worker.ts, the Worker entry — "you own routing"):
//   /mcp                                        -> MCP handler (open)
//   /.well-known/oauth-protected-resource/mcp     -> resourceServer metadata
//   /.well-known/oauth-authorization-server       -> authorizationServer metadata
//   /oauth/token, /oauth/revoke, /oauth/register  -> authorizationServer
//   /authorize                                  -> sign-in + consent page (below)
//   /oauth/callback                             -> Google/GitHub/SMS return
//   /oauth/sms-check                            -> SMS code form (Twilio check)
//   everything else                             -> Astro storefront
//
// The sign-in flow (one page, one POST):
//   GET  /authorize      parse + describeConsent + beginConsent -> the page:
//                        what the app asks for, then three sign-in options
//                        in order: Google, GitHub, SMS (Twilio Verify).
//   POST /authorize      approveConsent (or denyConsent) -> then, and only
//                        then, the chosen sign-in: beginUpstream redirects
//                        to Google/GitHub, or a Twilio code is texted.
//   POST /oauth/sms-check the code form: Twilio checks the code; a wrong
//                        code re-renders the form (the state is not spent),
//                        a right code redirects to the callback with a
//                        signed token proving it.
//   GET  /oauth/callback finishUpstream recovers the approved request ->
//                        exchange the provider code (or verify the SMS
//                        token) -> completeAuthorization -> back to the client.
//
// Identity: what completeAuthorization() stores (userId, email, name,
// provider) is encrypted into the token record and reaches the MCP handler
// as ctx.props on every request, so an order can carry the signed-in user's
// identity. Upstream provider tokens (Google/GitHub) are NOT stored in props
// — we only need identity, not their APIs. An SMS identity is just the phone
// number (E.164); there is no email or name — the checkout contact email is
// collected separately at checkout.

import {
  AuthorizationError,
  CimdFetchError,
  OAuthAuthorizationServer,
  OAuthResourceServer,
  authorizationErrorRedirect,
  insufficientScope,
  type ConsentDescription,
} from '@cloudflare/workers-oauth-provider';
import { handleMcpRequest } from '../../../mcp-server/index.js';
import { signToken, verifyToken } from './token';

/** Identity stored at sign-in and handed to the MCP handler on every call. */
export interface AuthProps {
  userId: string;
  email?: string;
  name?: string;
  provider: 'google' | 'github' | 'sms';
}

// Production defaults. Local dev overrides them via .dev.vars (wrangler dev
// loads it): the library rejects authorization requests that arrive at any
// origin but the issuer, so the local server must advertise itself as
// http://localhost:<port> or every OAuth route 404s / 500s there.
export const DEFAULT_OAUTH_ISSUER = 'https://p2gift.keeg.uk';
export const DEFAULT_OAUTH_MCP_URL = 'https://p2gift.keeg.uk/mcp';

export function oauthIssuer(env: Cloudflare.Env): string {
  return env.OAUTH_ISSUER ?? DEFAULT_OAUTH_ISSUER;
}
export function oauthMcpUrl(env: Cloudflare.Env): string {
  return env.MCP_URL ?? DEFAULT_OAUTH_MCP_URL;
}
export function oauthCallbackUrl(env: Cloudflare.Env): string {
  return `${oauthIssuer(env)}/oauth/callback`;
}

// Everything the server can grant. `offline_access` lets the connector
// refresh its token without asking the user to sign in again.
export const OAUTH_SCOPES = ['mcp:read', 'mcp:write', 'offline_access'];

// SMS sign-in (Twilio Verify, US-only): the signed token proving a code was
// verified is good for 15 minutes — same TTL as the storefront's magic links.
// The Twilio code itself expires on Twilio's side (default 10 minutes).
const SMS_TOKEN_TTL_SECONDS = 15 * 60;

// SMS abuse guard (KV counters in OAUTH_KV): the /authorize SMS path is
// public and unauthenticated, so a bot could make us text arbitrary numbers.
// Cap code sends per phone and per IP; Twilio locks a verification after too
// many failed code checks, so checks need no separate cap here.
const SMS_SENDS_PER_PHONE_PER_HOUR = 5;
const SMS_SENDS_PER_IP_PER_HOUR = 20;
const SMS_RATE_WINDOW_SECONDS = 60 * 60;

export function createAuthorizationServer(env: Cloudflare.Env) {
  return new OAuthAuthorizationServer({
    issuer: oauthIssuer(env),
    resources: [oauthMcpUrl(env)],
    scopesSupported: OAUTH_SCOPES,
    clientIdMetadataDocumentEnabled: true,
  });
}

export function createResourceServer(
  env: Cloudflare.Env,
  authorizationServer: ReturnType<typeof createAuthorizationServer>,
) {
  return new OAuthResourceServer<Cloudflare.Env, AuthProps>({
    resourceMetadata: {
      resource: oauthMcpUrl(env),
      authorization_servers: [oauthIssuer(env)],
    },
    // Minimal set for basic use; advertised in the 401 challenge so clients
    // request it first. Enforced here: a token without it cannot call the
    // MCP endpoint at all (step-up via insufficientScope if ever needed).
    requiredScopes: ['mcp:read'],
    // Same Worker: validate directly against the authorization server —
    // no Service Binding, no network hop.
    validateToken: (env) => (resource, token) =>
      authorizationServer.validateToken(resource, token, env),
    handler: {
      fetch(request, env, ctx) {
        if (!ctx.auth.scope.includes('mcp:read')) {
          return insufficientScope(ctx.auth, ['mcp:read']);
        }
        // Token already validated by the host; ctx.props is the signed-in
        // user. The MCP handler attaches that identity to orders.
        return handleMcpRequest(request, env, ctx.props);
      },
    },
  });
}

export interface OAuthServers {
  authorizationServer: ReturnType<typeof createAuthorizationServer>;
  resourceServer: ReturnType<typeof createResourceServer>;
}

export function createOAuthServers(env: Cloudflare.Env): OAuthServers {
  const authorizationServer = createAuthorizationServer(env);
  return {
    authorizationServer,
    resourceServer: createResourceServer(env, authorizationServer),
  };
}

/** Paths the OAuth layer owns. Anything else falls through to Astro. */
export function isOAuthPath(pathname: string): boolean {
  return (
    pathname === '/authorize' ||
    pathname === '/oauth/callback' ||
    pathname === '/oauth/sms-check' ||
    pathname.startsWith('/oauth/') ||
    pathname === '/.well-known/oauth-authorization-server' ||
    pathname.startsWith('/.well-known/oauth-protected-resource')
  );
}

/**
 * Route one request through the OAuth layer. Returns null when the path is
 * not an OAuth path (caller falls through to the Astro storefront).
 */
export async function handleOAuthRequest(
  request: Request,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  servers: OAuthServers,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);

  if (pathname === '/authorize' || pathname === '/oauth/callback') {
    return handleAuthorizeRequest(request, env, servers);
  }
  // The SMS code form posts here (not to the authorization server): it checks
  // the code with Twilio, then redirects to /oauth/callback with a signed
  // token proving the code was verified. This must sit before the generic
  // /oauth/ branch below, or the authorization server would claim the path.
  if (pathname === '/oauth/sms-check') {
    return handleSmsCheck(request, env);
  }
  if (pathname.startsWith('/.well-known/oauth-protected-resource')) {
    return servers.resourceServer.fetch(request, env, ctx);
  }
  if (
    pathname.startsWith('/oauth/') ||
    pathname === '/.well-known/oauth-authorization-server'
  ) {
    return servers.authorizationServer.fetch(request, env, ctx);
  }
  return null;
}

// ---------------------------------------------------------------------------
// /authorize + /oauth/callback — the sign-in + consent page
// ---------------------------------------------------------------------------

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function errorPage(message: string, status = 400): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>p2gift sign-in</title><h1>Sign-in didn't finish</h1><p>${escapeHtml(message)}</p><p>Go back to your assistant and start the connection again.</p>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

/** SHA-256, base64url — the PKCE S256 code challenge for the upstream redirect. */
export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(digest);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function authorizePage(
  details: ConsentDescription,
  handle: string,
  env: Cloudflare.Env,
): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.';
  const scopes = details.scope
    .map(
      (scope) =>
        `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label>`,
    )
    .join('<br>');
  // A button is off when its provider isn't configured — the choice is
  // still visible, so the user sees what exists instead of a missing step.
  const googleOff = env.GOOGLE_CLIENT_ID ? '' : ' disabled';
  const githubOff = env.GITHUB_CLIENT_ID ? '' : ' disabled';
  const smsOff = twilioConfigured(env) ? '' : ' disabled';
  return `<!doctype html>
<meta charset="utf-8">
<title>Sign in to p2gift</title>
<h1>Sign in to p2gift</h1>
<p><strong>${name}</strong> wants to connect to your p2gift account. ${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>' : ''}
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  ${scopes}
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
  <p><button name="decision" value="deny">Deny</button></p>
</form>`;
}

// The library's errors are plain classes, but the Workers bundle can carry
// a second copy of a class across a module boundary, which breaks
// instanceof. Match by name as well, so a real authorization failure renders
// a local 400 instead of surfacing as a 500.
function isAuthorizationError(error: unknown): error is AuthorizationError {
  return (
    error instanceof AuthorizationError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'AuthorizationError')
  );
}
function isCimdFetchError(error: unknown): error is CimdFetchError {
  return (
    error instanceof CimdFetchError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'CimdFetchError')
  );
}

async function handleAuthorizeRequest(
  request: Request,
  env: Cloudflare.Env,
  servers: OAuthServers,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/authorize') {
      return request.method === 'POST'
        ? handleAuthorizePost(request, env, servers)
        : handleAuthorizeGet(request, env, servers);
    }
    return handleOAuthCallback(request, env, servers);
  } catch (error) {
    // Redirect back to the client only once the client and its exact
    // redirect URI are validated; everything else renders locally.
    if (isAuthorizationError(error) && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (isAuthorizationError(error) || isCimdFetchError(error)) {
      const message =
        isAuthorizationError(error)
          ? error.description
          : 'This app could not be verified.';
      return new Response(escapeHtml(message), {
        status: 400,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    throw error;
  }
}

async function handleAuthorizeGet(
  request: Request,
  env: Cloudflare.Env,
  servers: OAuthServers,
): Promise<Response> {
  const oauth = servers.authorizationServer.getOAuthApi(env);
  const authRequest = await oauth.parseAuthRequest(request);
  // describeConsent first: a failed client lookup leaves nothing in KV.
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  const headers = new Headers(consent.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(authorizePage(details, consent.handle, env), { headers });
}

export function upstreamAuthorizeUrl(
  provider: 'google' | 'github',
  clientId: string,
  state: string,
  codeChallenge: string,
  callbackUrl: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  if (provider === 'google') {
    params.set('scope', 'openid email profile');
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }
  params.set('scope', 'read:user user:email');
  return `https://github.com/login/oauth/authorize?${params}`;
}

async function handleAuthorizePost(
  request: Request,
  env: Cloudflare.Env,
  servers: OAuthServers,
): Promise<Response> {
  const oauth = servers.authorizationServer.getOAuthApi(env);
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  const provider = String(form.get('provider') ?? '');

  // Deny consumes the handle and sends the client its access_denied redirect.
  if (form.get('decision') === 'deny') {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  // SMS: validate before approveConsent, so a bad number, a missing Twilio
  // setup, or a rate limit doesn't burn the one-use consent handle — the user
  // can fix it and submit again. (Google/GitHub validate after approval;
  // their redirect carries the failure instead.)
  let smsPhone: string | null = null;
  if (provider === 'sms') {
    smsPhone = normalizeUsPhone(String(form.get('phone') ?? ''));
    if (!smsPhone) {
      return errorPage('Enter a US mobile number, like +1 415 555 0132.');
    }
    if (!twilioConfigured(env)) {
      return errorPage("Text sign-in isn't set up on this store yet.");
    }
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    if (!(await smsSendAllowed(env, smsPhone, ip))) {
      return errorPage(
        'Too many codes sent to this number just now. Wait a little and try again.',
        429,
      );
    }
  }

  // Approve first: the handle works once, and only the approved request
  // (recovered from storage, never from the form) may continue.
  const approved = await oauth.approveConsent(request, handle, {
    scope: form.getAll('scope').map(String),
  });

  // Google / GitHub: hand the user to the provider, with PKCE.
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
    const { state, headers } = await oauth.beginUpstream(approved.request, {
      data: { provider, verifier },
      headers: approved.headers,
    });
    headers.set(
      'Location',
      upstreamAuthorizeUrl(provider, clientId, state, await s256(verifier), oauthCallbackUrl(env)),
    );
    return new Response(null, { status: 302, headers });
  }

  // SMS: a Twilio Verify code. The approved request is stored server-side by
  // beginUpstream and recovered at the callback via its state — the same
  // machinery as the providers above. The code page posts the code to
  // /oauth/sms-check (not the callback), so a wrong code doesn't consume the
  // state: the user can retry or ask for a new code.
  if (provider === 'sms') {
    const phone = smsPhone;
    if (!phone) return errorPage('Enter a US mobile number, like +1 415 555 0132.');
    const { state, headers } = await oauth.beginUpstream(approved.request, {
      data: { provider: 'sms', phone },
      headers: approved.headers,
    });
    if (!(await twilioSendCode(env, phone))) {
      console.error('OAuth SMS sign-in send failed');
      return errorPage('The sign-in code could not be sent. Try again from your assistant.', 502);
    }
    await smsSendRecord(env, phone, request.headers.get('cf-connecting-ip') ?? 'unknown');
    headers.set('content-type', 'text/html; charset=utf-8');
    return new Response(smsCodePage(state, phone), { headers, status: 200 });
  }

  return errorPage('Choose a sign-in method: Google, GitHub, or text message.');
}

interface UpstreamData {
  provider?: string;
  verifier?: string;
  phone?: string;
}

async function handleOAuthCallback(
  request: Request,
  env: Cloudflare.Env,
  servers: OAuthServers,
): Promise<Response> {
  const oauth = servers.authorizationServer.getOAuthApi(env);
  const url = new URL(request.url);
  let resumed;
  try {
    resumed = await oauth.finishUpstream<UpstreamData>(request);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return errorPage(
        'This sign-in link expired or was opened in another browser. Go back to your assistant and start the connection again.',
      );
    }
    throw error;
  }
  const { request: original, data, headers } = resumed;

  // The provider declined or failed there: answer the client with it.
  if (url.searchParams.get('error')) {
    headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
    return new Response(null, { status: 302, headers });
  }

  let identity: { userId: string; email?: string; name?: string };
  try {
    if (data.provider === 'google') {
      identity = await exchangeGoogle(url.searchParams.get('code'), data, env);
    } else if (data.provider === 'github') {
      identity = await exchangeGitHub(url.searchParams.get('code'), data, env);
    } else if (data.provider === 'sms') {
      identity = await verifySmsCode(url, data, env);
    } else {
      return errorPage('Unknown sign-in method. Start again from your assistant.');
    }
  } catch (err) {
    console.error('Sign-in exchange failed:', err);
    return errorPage(
      'Sign-in failed at the provider. Go back to your assistant and start the connection again.',
      502,
    );
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: identity.userId,
    metadata: {},
    scope: original.scope,
    props: {
      userId: identity.userId,
      email: identity.email,
      name: identity.name,
      provider: data.provider as AuthProps['provider'],
    },
  });
  headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers });
}

export async function exchangeGoogle(
  code: string | null,
  data: UpstreamData,
  env: Cloudflare.Env,
): Promise<{ userId: string; email: string; name?: string }> {
  if (!code || !data.verifier) throw new Error('missing Google code');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: oauthCallbackUrl(env),
      grant_type: 'authorization_code',
      code_verifier: data.verifier,
    }),
  });
  if (!tokenRes.ok) throw new Error(`Google token exchange failed: ${tokenRes.status}`);
  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  if (!access_token) throw new Error('Google returned no access token');
  const meRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!meRes.ok) throw new Error(`Google profile fetch failed: ${meRes.status}`);
  const me = (await meRes.json()) as { sub?: string; email?: string; name?: string };
  if (!me.sub || !me.email) throw new Error('Google profile has no id or email');
  return { userId: `google:${me.sub}`, email: me.email, name: me.name };
}

export async function exchangeGitHub(
  code: string | null,
  data: UpstreamData,
  env: Cloudflare.Env,
): Promise<{ userId: string; email: string; name?: string }> {
  if (!code || !data.verifier) throw new Error('missing GitHub code');
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID ?? '',
      client_secret: env.GITHUB_CLIENT_SECRET ?? '',
      code,
      redirect_uri: oauthCallbackUrl(env),
      code_verifier: data.verifier,
    }),
  });
  if (!tokenRes.ok) throw new Error(`GitHub token exchange failed: ${tokenRes.status}`);
  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  if (!access_token) throw new Error('GitHub returned no access token');
  const headers = {
    Authorization: `Bearer ${access_token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'p2gift',
  };
  const meRes = await fetch('https://api.github.com/user', { headers });
  if (!meRes.ok) throw new Error(`GitHub profile fetch failed: ${meRes.status}`);
  const me = (await meRes.json()) as { id?: number; login?: string; name?: string };
  if (!me.id) throw new Error('GitHub profile has no id');
  const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
  if (!emailsRes.ok) throw new Error(`GitHub emails fetch failed: ${emailsRes.status}`);
  const emails = (await emailsRes.json()) as { email?: string; primary?: boolean; verified?: boolean }[];
  const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
  if (!primary?.email) throw new Error('GitHub account has no verified email');
  return { userId: `github:${me.id}`, email: primary.email, name: me.name ?? me.login };
}

async function verifySmsCode(
  url: URL,
  data: UpstreamData,
  env: Cloudflare.Env,
): Promise<{ userId: string }> {
  const smsToken = url.searchParams.get('sms_token');
  const state = url.searchParams.get('state');
  if (!smsToken || !state) throw new Error('missing sms token');
  if (!env.AUTH_SECRET) throw new Error('AUTH_SECRET is not configured');
  const payloadRaw = await verifyToken(smsToken, env.AUTH_SECRET, nowSeconds());
  if (!payloadRaw) throw new Error('sms token expired or invalid');
  const payload = JSON.parse(payloadRaw) as { phone?: string; state?: string };
  if (payload.state !== state || payload.phone !== data.phone) {
    throw new Error('sms token does not match this sign-in');
  }
  // The identity IS the phone number (E.164). No email, no name — the
  // checkout contact email is collected separately at checkout.
  return { userId: payload.phone as string };
}

// ---------------------------------------------------------------------------
// SMS sign-in (Twilio Verify, US-only)
// ---------------------------------------------------------------------------

/** US-only: accept 10 digits, 11 digits starting with 1, or +1 form. */
export function normalizeUsPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  let e164: string | null = null;
  if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) e164 = `+${digits}`;
  if (!e164) return null;
  // NANP: area code and exchange can't start with 0 or 1.
  if (!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(e164)) return null;
  return e164;
}

export function twilioConfigured(env: Cloudflare.Env): boolean {
  return Boolean(
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID,
  );
}

/** Twilio's Verify API takes HTTP Basic auth: Account SID + Auth Token. */
function twilioBasicAuth(env: Cloudflare.Env): string {
  return `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`;
}

function twilioVerifyUrl(env: Cloudflare.Env, path: string): string {
  const serviceSid = env.TWILIO_VERIFY_SERVICE_SID as string;
  return `https://verify.twilio.com/v2/Services/${encodeURIComponent(serviceSid)}${path}`;
}

export async function twilioSendCode(env: Cloudflare.Env, phone: string): Promise<boolean> {
  try {
    const res = await fetch(twilioVerifyUrl(env, '/Verifications'), {
      method: 'POST',
      headers: {
        Authorization: twilioBasicAuth(env),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, Channel: 'sms' }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function twilioCheckCode(env: Cloudflare.Env, phone: string, code: string): Promise<boolean> {
  try {
    const res = await fetch(twilioVerifyUrl(env, '/VerificationCheck'), {
      method: 'POST',
      headers: {
        Authorization: twilioBasicAuth(env),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, Code: code }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { status?: string };
    return data.status === 'approved';
  } catch {
    return false;
  }
}

async function kvCount(env: Cloudflare.Env, key: string): Promise<number> {
  const raw = await env.OAUTH_KV.get(key);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

export async function smsSendAllowed(env: Cloudflare.Env, phone: string, ip: string): Promise<boolean> {
  const [byPhone, byIp] = await Promise.all([
    kvCount(env, `sms-send:phone:${phone}`),
    kvCount(env, `sms-send:ip:${ip}`),
  ]);
  return byPhone < SMS_SENDS_PER_PHONE_PER_HOUR && byIp < SMS_SENDS_PER_IP_PER_HOUR;
}

export async function smsSendRecord(env: Cloudflare.Env, phone: string, ip: string): Promise<void> {
  const [byPhone, byIp] = await Promise.all([
    kvCount(env, `sms-send:phone:${phone}`),
    kvCount(env, `sms-send:ip:${ip}`),
  ]);
  // Each put refreshes the TTL (sliding window) — good enough for an abuse
  // guard; the exact window edge doesn't matter here.
  await Promise.all([
    env.OAUTH_KV.put(`sms-send:phone:${phone}`, String(byPhone + 1), {
      expirationTtl: SMS_RATE_WINDOW_SECONDS,
    }),
    env.OAUTH_KV.put(`sms-send:ip:${ip}`, String(byIp + 1), {
      expirationTtl: SMS_RATE_WINDOW_SECONDS,
    }),
  ]);
}

function smsCodePage(state: string, phone: string, message?: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>Enter your sign-in code</title>
<h1>Enter your sign-in code</h1>
<p>We texted a 6-digit code to <strong>${escapeHtml(phone)}</strong>. It expires in 10 minutes.</p>
${message ? `<p><strong>${escapeHtml(message)}</strong></p>` : ''}
<form method="post" action="/oauth/sms-check">
  <input type="hidden" name="state" value="${escapeHtml(state)}">
  <input type="hidden" name="phone" value="${escapeHtml(phone)}">
  <p><label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" autofocus></label></p>
  <p>
    <button name="action" value="check">Verify code</button>
    <button name="action" value="resend">Send a new code</button>
  </p>
</form>`;
}

function smsCodeResponse(state: string, phone: string, message?: string, status = 200): Response {
  return new Response(smsCodePage(state, phone, message), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

/**
 * The code form's POST target. It does NOT call finishUpstream — that stays
 * in the callback, so a wrong code (or a resend) doesn't spend the state.
 * A verified code signs a short-lived token and redirects to /oauth/callback,
 * which consumes the state and finishes the sign-in.
 */
async function handleSmsCheck(request: Request, env: Cloudflare.Env): Promise<Response> {
  if (request.method !== 'POST') {
    return errorPage('Use the sign-in page to request a code.', 405);
  }
  const form = await request.formData();
  const state = String(form.get('state') ?? '');
  const phone = normalizeUsPhone(String(form.get('phone') ?? ''));
  const code = String(form.get('code') ?? '').trim();
  const action = String(form.get('action') ?? 'check');
  if (!state || !phone) {
    return errorPage('This sign-in expired. Start again from your assistant.');
  }
  if (!twilioConfigured(env) || !env.AUTH_SECRET) {
    return errorPage("Text sign-in isn't set up on this store yet.");
  }
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (action === 'resend') {
    if (!(await smsSendAllowed(env, phone, ip))) {
      return smsCodeResponse(state, phone, 'Too many codes sent just now. Wait a little and try again.', 429);
    }
    if (!(await twilioSendCode(env, phone))) {
      return errorPage('The sign-in code could not be sent. Try again from your assistant.', 502);
    }
    await smsSendRecord(env, phone, ip);
    return smsCodeResponse(state, phone, 'A new code was sent.');
  }
  if (!/^\d{4,8}$/.test(code)) {
    return smsCodeResponse(state, phone, 'Enter the 6-digit code from the text.');
  }
  if (!(await twilioCheckCode(env, phone, code))) {
    return smsCodeResponse(state, phone, "That code didn't match. Try again, or send a new code.");
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
