// p2gift MCP service — JSON-RPC + public routes, zero dependencies.
// Implements the JSON-RPC surface MCP clients need: initialize,
// notifications/initialized, tools/list, tools/call, resources/list,
// resources/read, prompts/list, prompts/get, ping.
//
// v0.6.0 — the p2gift Intake Service (owner decisions, 2026-11-15).
// Four tools only: start opens a server-side session (D1 table
// wizard_sessions, migration 0046), submit advances it one stage at
// a time (pitch → product → layout → artwork), pay issues the
// payment link, status reads the settled order. The state machine
// lives in session.js / checkout.js; locks are read from the session
// row, never from Agent arguments. The pitch locks verbatim — no fit
// rail. There is no order-details stage: pay runs from the artwork
// lock and the payment page collects quantity, address and card.
// Artwork carries no automated file rail — submit parks the file
// as-is and the operator reviews it manually (owner decision,
// 2026-11-13). The service's only description is the worked example
// (examples/default.md): the connect prompt below points at it, and
// the same text rides in the initialize instructions so every
// connecting agent receives it without fetching. Install is
// copy-only — no reusable skill is issued or saved.
// v0.6.1 (2026-11-15): the dialog rounds are streamlined —
// # Select A Source takes an attachment with no menu, and # Pitch
// + # Pick A Product merge into # Pitch and Product (one round,
// two submits back-to-back). The tool surface is unchanged.
// v0.6.2 (2026-11-15): distinct reference alphabets per pick —
// pitch options stay numeric (1, 2, 3), product picks are letters
// ("I pick A — …"), layout options are X / Y / Z. The server
// enforces all three: the pick parser takes a letter, and layout
// keys come from the product's layout_options text (X/Y/Z).
//
// Auth (unchanged from v0.3.0): /mcp is OPEN — no token, no sign-in.
// The agent works token-free; abuse control is rate limits (see
// rate-limit.js) plus the browser sign-in gate at checkout: the
// checkout link leads to a checkout where the HUMAN signs in
// (Google, GitHub, or a US phone code) in the browser right before
// paying. That gate is the only identity check in the wizard, and it
// sits inside the checkout stage. The OAuth authorization server
// still lives in the Worker (src/features/auth/oauth.ts).
// `authProps` may still arrive when a caller is signed in; orders
// then carry that identity, but it is never required. /health and
// /inventory stay public.
// R2 binding P2GIFT_BUCKET (bucket "p2gift") serves the learning
// examples at examples/ — the Worker reads them from R2, it
// does not embed the images in code.
//
// This module is transport-agnostic: the named handlers below take a
// Request and an env (with P2GIFT_BUCKET) and return a Response. The
// Astro routes in src/pages/inventory.ts, src/pages/connect.ts and
// src/pages/health.ts call them, and /mcp is routed by the Worker
// entry (src/worker.ts) straight to handleMcpRequest, so the MCP
// service has exactly one implementation. The default export is the
// standalone Worker entry (the pre-merge shape), kept for local use:
// there the Connect Guide is the landing page at / and /connect
// redirects to it. In the merged Worker the storefront owns / and
// the guide is served at /connect instead — same handler, different
// route.
import { loadInventory } from "./inventory.js";
import {
  startSession,
  approvePitch,
  selectGift,
  approveLayout,
  approveArtwork,
} from "./session.js";
import { prepareCheckoutFromSession, getOrderStatus, lookupOrder } from "./checkout.js";
import {
  rateLimitHit,
  clientIp,
  MCP_GENERAL_LIMIT_PER_HOUR,
  MCP_PREPARE_CHECKOUT_LIMIT_PER_HOUR,
} from "./rate-limit.js";

const SERVER = { name: "p2gift", version: "0.6.2" };

const STAGES = [
  "1 Select A Source — the run opens here; the user attaches a pitch deck (PPT/PDF or photo), no menu",
  "2 Pitch and Product — in one round: submit locks the pitch verbatim, then the product from the user's tap, under its service-issued name",
  "3 Layout — submit locks the Print Layout Design and issues ARTWORK_SPECS",
  "4 Artwork — submit files the user-approved Final_Print_Artwork (parked as-is, no automated check)",
  "5 Check Out — pay issues the signed payment link; quantity, address and card are entered on the linked page",
  "6 Order Status — status reports the settled order; later checks take the order no. + token, no session needed",
];

// The MCP-to-Agent prompt upon connect. The same text is returned by
// prompts/get (p2gift-connect) and carried in the initialize result's
// instructions, so an agent receives it whether or not it fetches
// prompts. It points at the example — the service's only description.
const CONNECT_TEXT = [
  "You are connected to the p2gift Intake Service. Read the example first — p2gift://examples/default.md — it is the service's only description: one worked intake, the three practices (chat sequence, layout, artwork), and the if-stuck lines. Follow it exactly. Install is copy-only: save nothing, make no reusable skill.",
  "Reply first with # Select A Source — the Connected line and one instruction: attach a pitch deck (PPT/PDF or photo). No menu at this stage. Then # Pitch and Product: present the pitch candidates and the items in one message; the user settles the pitch and taps a product in one round. start opens the session. submit carries each input: the pitch (locks verbatim, exactly as typed or tapped), then the product (named exactly as the service names it — the service issues the pick strings), back-to-back; then the layout pick and the artwork file, one stage each. pay issues the payment link: quantity, address and card are entered on the linked page — ask for none of them in the dialog. status closes the run with the # Order Status message, and serves later checks with the order no. + token.",
  "Never invent pitch wording, quantity, recipient, or price.",
].join("\n\n");

// The service's only description: ONE worked example, stored in R2
// under examples/. The Markdown is the example an agent follows; the
// four images are the pictures it embeds (the three layout mockups
// and the Final_Print_Artwork). The same Markdown is rendered for
// humans at /example (HTML in a browser, raw Markdown with
// ?format=md). Adding a resource = add its file here and sync it
// to R2.
const EXAMPLE_FILES = [
  { key: "examples/default.md", mimeType: "text/markdown", name: "Example — the worked intake", description: "The p2gift Intake Service's only description: one worked intake (pitch, product, layout, artwork, payment link, Order Status), the three practices, and the if-stuck lines. Read it on connect and follow it exactly." },
  { key: "examples/assets/ex1-layout-a.webp", mimeType: "image/webp", name: "Example asset — Layout A mockup", description: "The example's Layout A mockup on the product's themed-base image." },
  { key: "examples/assets/ex1-layout-b.webp", mimeType: "image/webp", name: "Example asset — Layout B mockup (picked)", description: "The example's Layout B mockup on the product's themed-base image — the picked layout." },
  { key: "examples/assets/ex1-layout-c.webp", mimeType: "image/webp", name: "Example asset — Layout C mockup", description: "The example's Layout C mockup on the product's themed-base image." },
  { key: "examples/assets/ex1-artwork-preview.png", mimeType: "image/png", name: "Example asset — Final_Print_Artwork", description: "The example's approved Final_Print_Artwork (Layout B), previewed on black." },
];
const EXAMPLE_RESOURCES = EXAMPLE_FILES.map((f) => ({
  uri: `p2gift://${f.key}`,
  name: f.name,
  description: f.description,
  mimeType: f.mimeType,
}));
const ALL_RESOURCE_FILES = [...EXAMPLE_FILES];

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

const TOOLS = [
  {
    name: "start",
    description: "Open an intake session with the p2gift Intake Service. Call once the pitch candidates are drafted locally from the user's source (deck or text). Returns the session_id — the only state you carry — plus the stages and the items with their issued pick strings. No sign-in or token is needed.",
    inputSchema: {
      type: "object",
      properties: {
        pitch_candidates: {
          type: "array",
          items: { type: "string" },
          description: "The pitch options drafted from the source, for the user to pick or edit.",
        },
      },
    },
  },
  {
    name: "submit",
    description: "Advance the session by one stage, with the user's input for the open stage. stage 'pitch' takes pitch_text — the settled wording, locked verbatim exactly as given. stage 'product' takes pick — the issued pick string, in the shape \"I pick A — <name>[, Color: <color>]\"; the name must be the item's exact service name, and the service rejects any other name. stage 'layout' takes layout — 'X', 'Y' or 'Z' from the locked item's layout options; the reply carries ARTWORK_SPECS. stage 'artwork' takes artwork_png_base64 — the user-approved Final_Print_Artwork, filed exactly as submitted. The service holds the stage order and rejects an input that is not the open stage.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        stage: { type: "string", enum: ["pitch", "product", "layout", "artwork"], description: "The stage this input belongs to." },
        pitch_text: { type: "string", description: "stage 'pitch': the settled pitch, exactly as the user approved it — it prints character for character." },
        pick: { type: "string", description: "stage 'product': the pick, in the shape \"I pick A — <name>[, Color: <color>]\"." },
        layout: { type: "string", description: "stage 'layout': the picked layout key, e.g. \"B\"." },
        artwork_png_base64: { type: "string", description: "stage 'artwork': the approved Final_Print_Artwork, base64-encoded." },
        artwork_name: { type: ["string", "null"], description: "stage 'artwork': file name for the artwork (defaults to final-print-artwork.png)." },
      },
      required: ["session_id", "stage"],
    },
  },
  {
    name: "pay",
    description: "Issue the payment link for the locked session. The item, variant, quantity (1 unless one was locked) and price all come from the locked session and the live item data — you supply only the session_id. Returns a signed, single-use link expiring in about 15 minutes: the user opens it and enters quantity, address and card on the linked page; nothing is asked in the dialog, and the card never passes through you. An expired link is re-issued by calling again.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "status",
    description: "Read an order's state. With session_id: this session's order, with a server-side wait — while no settled order is linked, the call re-checks every 5 s (up to 3 repeats, ~15 s) and returns the moment payment settles, the payment link expires unpaid, or the order is refunded; call again to keep waiting. With order_id + order_token instead (both in the run's confirmation and the confirmation email): the same order with no session. Payment truth is the settled order record — the payment page is never proof. On paid, returns the confirmation (payment; expected delivery date = order date + the item's Lead_Time; the order no. + token for later checks).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The intake session to read the order for." },
        order_id: { type: "string", description: "The order's number, for a session-less check." },
        order_token: { type: "string", description: "The order's access token (the token in the order page link)." },
      },
    },
  },
];

function result(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function error(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function textResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

// Wizard tool plumbing: a function's { error } becomes a JSON-RPC
// error; anything else (including { rejected, reasons }) is a result
// the agent acts on.
function toolPayload(id, out) {
  if (out?.error) return error(id, -32602, out.error);
  return result(id, textResult(out));
}

// GET /health — public service JSON (no key needed).
export async function handleHealthRequest(env) {
  // checkout_gate mirrors the store's runtime setting: "oauth" when
  // the browser sign-in gate is in force, "off" when agent-prefill
  // checkouts go straight to Stripe payment.
  let checkoutGate = "oauth";
  try {
    if (env?.DB) {
      const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'checkout_gate_enabled'").first();
      if (row?.value === "0") checkoutGate = "off";
    }
  } catch { /* health stays up; the gate reports its default */ }
  return new Response(JSON.stringify({ service: "p2gift", mcp: "/mcp", version: SERVER.version, auth: "open", checkout_gate: checkoutGate, example: "p2gift://examples/default.md" }), {
    headers: { "content-type": "application/json" },
  });
}

// GET /inventory — public JSON for the picker page and the wiki gift items page.
export async function handleInventoryRequest(env) {
  const inv = await loadInventory(env);
  return new Response(JSON.stringify({ source: inv.source, items: inv.items }), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

// GET /connect — consolidated Connect guide (Muse + Claude), served from R2.
// Served by the deployed Worker, not from GitHub, so the page stays public
// even though the repo will go private.
export async function handleConnectRequest(env) {
  if (!env?.P2GIFT_BUCKET) return new Response("Connect guide not configured", { status: 503 });
  const obj = await env.P2GIFT_BUCKET.get("connect/Connect_page_guide.html");
  if (!obj) return new Response("Connect guide not found in R2", { status: 404 });
  return new Response(await obj.text(), { headers: { "content-type": "text/html; charset=utf-8" } });
}

// POST /mcp — JSON-RPC over Streamable HTTP (stateless transport;
// wizard state lives in D1, keyed by the session_id the agent
// carries). OPEN endpoint: no token is required or checked. Abuse
// control is the rate limiter below (per IP generally; per IP + per
// session for pay), and everything costly or irreversible sits
// behind the browser sign-in gate at payment.
// `authProps` is optional — when a caller happens to be signed in,
// orders carry that identity.
export async function handleMcpRequest(request, env, authProps) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const ip = clientIp(request);
  if (!(await rateLimitHit(env, "mcp", ip, MCP_GENERAL_LIMIT_PER_HOUR))) {
    return Response.json(
      error(null, -32000, "Rate limit reached for this network. Wait a while and try again — or use Live Connect (draft an email to hello@keeg.uk)."),
      { status: 429 },
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(error(null, -32700, "Parse error"), { status: 400 });
  }
  const { id, method, params } = body;
  // Notifications have no id and need no reply.
  if (method && method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }
  let payload;
  if (method === "initialize") {
    payload = result(id, {
      protocolVersion: params?.protocolVersion ?? "2025-03-26",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: SERVER,
      instructions: CONNECT_TEXT,
    });
  } else if (method === "ping") {
    payload = result(id, {});
  } else if (method === "resources/list") {
    payload = result(id, { resources: EXAMPLE_RESOURCES });
  } else if (method === "resources/read") {
    const uri = params?.uri ?? "";
    const file = ALL_RESOURCE_FILES.find((f) => `p2gift://${f.key}` === uri);
    if (!file) {
      payload = error(id, -32002, `Resource not found: ${uri}`);
    } else if (!env?.P2GIFT_BUCKET) {
      payload = error(id, -32603, "R2 binding P2GIFT_BUCKET is not configured on this Worker.");
    } else {
      const obj = await env.P2GIFT_BUCKET.get(file.key);
      if (!obj) {
        payload = error(id, -32002, `Resource not found in R2: ${file.key}`);
      } else if (file.mimeType.startsWith("text/") || file.mimeType === "application/json") {
        const text = await obj.text();
        payload = result(id, { contents: [{ uri, mimeType: file.mimeType, text }] });
      } else {
        const buf = await obj.arrayBuffer();
        payload = result(id, { contents: [{ uri, mimeType: file.mimeType, blob: arrayBufferToBase64(buf) }] });
      }
    }
  } else if (method === "prompts/list") {
    payload = result(id, {
      prompts: [{
        name: "p2gift-connect",
        description: "Connect to the p2gift Intake Service: read the example — the service's only description — then reply with the # Select A Source stage.",
      }],
    });
  } else if (method === "prompts/get") {
    if (params?.name !== "p2gift-connect") {
      payload = error(id, -32602, `Unknown prompt: ${params?.name}`);
    } else {
      payload = result(id, {
        description: "Connect to the p2gift Intake Service: read the example — the service's only description — then reply with the # Select A Source stage.",
        messages: [{
          role: "user",
          content: { type: "text", text: CONNECT_TEXT },
        }],
      });
    }
  } else if (method === "tools/list") {
    payload = result(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const customer = authProps?.userId
      ? { userId: authProps.userId, email: authProps.email ?? null, name: authProps.name ?? null, provider: authProps.provider }
      : null;
    if (name === "start") {
      const started = await startSession(env, { pitchCandidates: args.pitch_candidates, customer });
      if (started?.error) {
        payload = toolPayload(id, started);
      } else {
        const inv = await loadInventory(env);
        payload = result(id, textResult({
          service: "p2gift Intake Service",
          endpoint: "https://p2gift.keeg.uk/mcp",
          version: SERVER.version,
          ...started,
          stages: STAGES,
          inventory_source: inv.source,
          items: inv.items.map((i, idx) => ({ id: i.id, name: i.name, pick: `I pick ${String.fromCharCode(65 + idx)} — ${i.name}`, surface: i.surface, treatment: i.treatment ?? null, lead_time_days: i.lead_time_days ?? null })),
        }));
      }
    } else if (name === "submit") {
      if (!args.session_id) {
        payload = error(id, -32602, "session_id is required");
      } else if (args.stage === "pitch") {
        if (!args.pitch_text) payload = error(id, -32602, "pitch_text is required for stage 'pitch'");
        else payload = toolPayload(id, await approvePitch(env, { sessionId: args.session_id, pitchText: args.pitch_text }));
      } else if (args.stage === "product") {
        if (!args.pick) payload = error(id, -32602, "pick is required for stage 'product'");
        else payload = toolPayload(id, await selectGift(env, { sessionId: args.session_id, pick: args.pick }));
      } else if (args.stage === "layout") {
        if (!args.layout) payload = error(id, -32602, "layout is required for stage 'layout'");
        else payload = toolPayload(id, await approveLayout(env, { sessionId: args.session_id, layout: args.layout }));
      } else if (args.stage === "artwork") {
        if (!args.artwork_png_base64) payload = error(id, -32602, "artwork_png_base64 is required for stage 'artwork'");
        else payload = toolPayload(id, await approveArtwork(env, { sessionId: args.session_id, artworkBase64: args.artwork_png_base64, artworkName: args.artwork_name ?? undefined }));
      } else {
        payload = error(id, -32602, "stage must be one of: pitch, product, layout, artwork");
      }
    } else if (name === "pay") {
      if (!args.session_id) {
        payload = error(id, -32602, "session_id is required");
      } else if (
        !(await rateLimitHit(env, "pay-ip", ip, MCP_PREPARE_CHECKOUT_LIMIT_PER_HOUR)) ||
        !(await rateLimitHit(env, "pay-session", args.session_id, MCP_PREPARE_CHECKOUT_LIMIT_PER_HOUR))
      ) {
        // The costly call (D1/R2 writes) gets the strict bucket: per IP
        // and per session.
        payload = error(id, -32000, "Too many payment links issued in the last hour. Wait, or use Live Connect (draft an email to hello@keeg.uk).");
      } else {
        payload = toolPayload(id, await prepareCheckoutFromSession(env, authProps, { sessionId: args.session_id }));
      }
    } else if (name === "status") {
      if (args.session_id) {
        payload = toolPayload(id, await getOrderStatus(env, { sessionId: args.session_id }));
      } else if (args.order_id && args.order_token) {
        payload = toolPayload(id, await lookupOrder(env, { orderId: args.order_id, orderToken: args.order_token }));
      } else {
        payload = error(id, -32602, "status needs session_id, or order_id and order_token");
      }
    } else {
      payload = error(id, -32602, `Unknown tool: ${name}`);
    }
  } else {
    payload = error(id, -32601, `Method not found: ${method}`);
  }
  return Response.json(payload, {
    headers: { "content-type": "application/json", "mcp-session-id": "p2gift-stateless" },
  });
}

// Standalone Worker entry (the pre-merge shape). Kept so the module still
// runs on its own: the Connect Guide is the landing page at / here, and
// /connect redirects to it. In the merged Worker the storefront owns /
// and the guide is served at /connect by the Astro route instead.
// NOTE: /mcp is open in both shapes; the standalone entry lacks the
// D1/FILES bindings, so the wizard tools can only fully run in the
// merged Worker (src/worker.ts) — the deployment.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") return handleConnectRequest(env);
    if (url.pathname === "/health") return handleHealthRequest(env);
    if (url.pathname === "/inventory") return handleInventoryRequest(env);
    if (url.pathname === "/connect") {
      return Response.redirect(new URL("/", request.url), 301);
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    return handleMcpRequest(request, env);
  },
};
