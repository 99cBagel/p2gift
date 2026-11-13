// p2gift MCP service — JSON-RPC + public routes, zero dependencies.
// Implements the JSON-RPC surface MCP clients need: initialize,
// notifications/initialized, tools/list, tools/call, resources/list,
// resources/read, prompts/list, prompts/get, ping.
//
// v0.4.0 — the lock-stage wizard. Ordering runs through a server-side
// session (D1 table wizard_sessions, migration 0046): the Agent holds
// only a session_id, and each tool advances exactly one stage —
// intake → pitch → gift → layout → artwork → order details →
// checkout → confirmation (+ order lookup). The state machine lives
// in session.js / checkout.js; locks are read from the session row,
// never from Agent arguments. The Product Page is hidden from the
// Agent: approve_pitch returns its URL for the human to pick on, and
// the pick comes back as a pasted message. Artwork carries no
// automated file rail — approve_artwork parks the file as-is and the
// operator reviews it manually (owner decision, 2026-11-13).
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
  setOrderDetails,
} from "./session.js";
import { prepareCheckoutFromSession, getOrderStatus, lookupOrder } from "./checkout.js";
import {
  rateLimitHit,
  clientIp,
  MCP_GENERAL_LIMIT_PER_HOUR,
  MCP_PREPARE_CHECKOUT_LIMIT_PER_HOUR,
} from "./rate-limit.js";

const SERVER = { name: "p2gift", version: "0.4.0" };

const STAGES = [
  "1 Intake — start_session records the pitch candidates from the source",
  "2 Pitch — approve_pitch locks the exact pitch text (fit-checked against the catalog surfaces)",
  "3 Gift — select_gift locks the gift from the user's pasted product-page pick",
  "4 Layout — approve_layout locks the Print Layout Design and issues ARTWORK_SPECS",
  "5 Artwork — approve_artwork parks the user-approved Final Print Artwork (no automated check)",
  "6 Order details — set_order_details locks quantity + delivery name/address",
  "7 Checkout — prepare_checkout issues the signed checkout link; OAuth sign-in happens in the browser, inside this stage only",
  "8 Confirmation — get_order_status reports the webhook-settled order back to the Agent",
  "9 Order lookup — lookup_order by order # + order token, no session needed",
];

// Worked examples for few-shot (N-shot) learning, stored in R2 under
// examples/. One Markdown file per example, slug-named; "default" is
// Example 1 (xDrive PPT run). The same Markdown is rendered for humans
// at /example/<slug> (HTML in a browser, raw Markdown with ?format=md).
// Adding an example = add its files here and sync them to R2.
const EXAMPLE_FILES = [
  { key: "examples/connect-prompt/default.md", mimeType: "text/markdown", name: "Connect Prompt — p2gift overview for the connected Agent", description: "Read first on connect: what p2gift (PPT-to-Gift) is, why it exists, the canonical terms, the lock-stage wizard (stages, tools, locks, the checkout rule), and Stages 8–9." },
  { key: "examples/default.md", mimeType: "text/markdown", name: "Example 1 (default) — Muse Chat Log, xDrive PPT run (wizard)", description: "Default worked example, wizard run: PPT in, pitch locked, gift picked on the product page, layout lock issuing ARTWORK_SPECS, artwork lock, checkout from the locked session, Stage 8 confirmation, Stage 9 lookup." },
  { key: "examples/assets/themed-base.webp", mimeType: "image/webp", name: "Example asset — themed-base (Tumbler mockup)", description: "Stainless Tumbler mockup, white pitch text on matte black, no period." },
  { key: "examples/assets/layout-a.webp", mimeType: "image/webp", name: "Example asset — Layout A", description: "Layout A: centered, 3 lines, large." },
  { key: "examples/assets/layout-b.webp", mimeType: "image/webp", name: "Example asset — Layout B", description: "Layout B, chosen: small top line, rule, large name." },
  { key: "examples/assets/layout-c.webp", mimeType: "image/webp", name: "Example asset — Layout C", description: "Layout C: 2 lines, em dash kept." },
  { key: "examples/assets/layout-3choices.webp", mimeType: "image/webp", name: "Example asset — Layouts A, B, C in one image", description: "The three print layout designs side by side in one strip — A left, B middle, C right; the combined image shown in the default workflow example." },
  { key: "examples/assets/final_print_artwork.png", mimeType: "image/png", name: "Example asset — Final Print Artwork, Layout B", description: "Final Print Artwork, Layout B, white text on black." },
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

const SHIPPING_SCHEMA = {
  type: "object",
  description: "Delivery address for the recipient, exactly as the user gave it.",
  properties: {
    name: { type: "string" },
    line1: { type: "string" },
    line2: { type: ["string", "null"] },
    city: { type: "string" },
    state: { type: ["string", "null"] },
    postal: { type: "string" },
    country: { type: "string", description: "2-letter country code, e.g. US." },
  },
  required: ["name", "line1", "city", "postal", "country"],
};

const TOOLS = [
  {
    name: "service_info",
    description: "PPT-to-Gift service overview: the lock-stage wizard stages and the live gift item pool (names + print surfaces).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "start_session",
    description: "Stage 1 (Intake): open a wizard session and record the pitch candidates extracted locally from the user's source (deck, text). Returns the session_id — the only state the agent carries. No sign-in or token at any stage before checkout.",
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
    name: "approve_pitch",
    description: "Stage 2 (Pitch): lock the pitch wording the user settled. The pitch is fit-checked against the live catalog's print surfaces (full / condensed / short) before it locks — a pitch no available item can bear is rejected with the form to resubmit in. On the lock, returns product_page_url for the user's gift pick.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        pitch_text: { type: "string", description: "The settled pitch, exactly as the user approved it — it prints character for character." },
      },
      required: ["session_id", "pitch_text"],
    },
  },
  {
    name: "select_gift",
    description: "Stage 3 (Gift): lock the gift from the pick message the user pasted back from the product page — `I pick N — <gift item name>[, Color: <color>] [<image url>]`. The number maps to the product page's order; a pick whose surface cannot bear the locked pitch is rejected. On the lock it feeds back the item's layout_options and themed_base_image for the layout stage.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        pick: { type: "string", description: "The user's pasted pick message, verbatim." },
      },
      required: ["session_id", "pick"],
    },
  },
  {
    name: "approve_layout",
    description: "Stage 4 (Layout): lock the Print Layout Design the user picked (A, B, or C — from the locked gift item's Layout_Options). Returns the item's ARTWORK_SPECS for the local artwork render.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        layout: { type: "string", description: "The picked layout key, e.g. \"B\"." },
      },
      required: ["session_id", "layout"],
    },
  },
  {
    name: "approve_artwork",
    description: "Stage 5 (Artwork): park the Final Print Artwork the user approved, exactly as submitted — PNG, base64-encoded. No automated check runs on the file; the operator reviews it in Admin and addresses any issue with the customer manually.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        artwork_png_base64: { type: "string", description: "The approved Final Print Artwork, base64-encoded." },
        artwork_name: { type: ["string", "null"], description: "File name for the artwork (defaults to final-print-artwork.png)." },
      },
      required: ["session_id", "artwork_png_base64"],
    },
  },
  {
    name: "set_order_details",
    description: "Stage 6 (Order details): lock the quantity and the delivery name + address, exactly as the user gave them — none may be invented.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        quantity: { type: "integer" },
        shipping: SHIPPING_SCHEMA,
      },
      required: ["session_id", "quantity", "shipping"],
    },
  },
  {
    name: "prepare_checkout",
    description: "Stage 7 (Checkout): build the checkout from the locked session — the agent supplies only the session_id; gift, variant, quantity, address, artwork, and price all come from the locked row and the live catalog. Returns checkout_url: a signed, single-use link expiring in about 15 minutes. The user opens it, signs in in the browser (Google, GitHub, or a US phone code — the wizard's only sign-in, inside this stage), sees the locked price and cart, and pays on the store page; the card never passes through the agent. An expired link is re-issued by calling again.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "get_order_status",
    description: "Stage 8 (Confirmation): read this session's order state from the store. Payment truth is the webhook-settled orders table — the browser checkout page is never proof. On paid, returns the three-part confirmation (Stripe payment confirmation; expected delivery date = order date + the gift item's Lead_Time; the p2gift-order-lookup pointer with order # + token) and locks the session ORDER_CONFIRMED.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "lookup_order",
    description: "Stage 9 (Order lookup): look up an order by its order # and order token — no wizard session needed. Returns the fulfilment ladder (paid → print ordered → received → shipped → delivered), the expected delivery date, and the order page link. The middle ladder stages light up when the operator's print feed lands; v1 reports paid, shipping state, and the expected date.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "The order's public id (ord_…), from the Stage 8 confirmation." },
        order_token: { type: "string", description: "The order's guest access token (the token in the order page URL)." },
      },
      required: ["order_id", "order_token"],
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
export function handleHealthRequest() {
  return new Response(JSON.stringify({ service: "p2gift", mcp: "/mcp", version: SERVER.version, auth: "open", checkout_gate: "oauth", example: "p2gift://examples/default.md" }), {
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
// session for prepare_checkout), and everything costly or
// irreversible sits behind the browser sign-in gate at checkout.
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
        description: "Connect to p2gift: read the connect prompt first, then the worked example, then open a wizard session with start_session.",
      }],
    });
  } else if (method === "prompts/get") {
    if (params?.name !== "p2gift-connect") {
      payload = error(id, -32602, `Unknown prompt: ${params?.name}`);
    } else {
      payload = result(id, {
        description: "Connect to p2gift: read the connect prompt first, then the worked example, then open a wizard session with start_session.",
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: "You are connected to p2gift (PPT-to-Gift). Before starting any order, read these resources in order: 1) p2gift://examples/connect-prompt/default.md — the connect prompt: what p2gift is, the canonical terms, the lock-stage wizard, the resources and the tools — then 2) p2gift://examples/default.md, the worked example, and 3) know the 6 image assets in the same folder — examples/assets/themed-base.webp, layout-a.webp, layout-b.webp, layout-c.webp, layout-3choices.webp, final_print_artwork.png — as presentation links: fetch one only when you need to show it to the user or check a mockup; the text resources carry the rules, so you do not need to read the images to learn the flow. The wizard: the server holds the session; you hold only the session_id. Start with start_session (Stage 1) once the pitch candidates are drafted locally from the user's source. Each stage locks before the next opens — approve_pitch (the pitch fit-checks against the catalog surfaces; on the lock you receive the product page URL for the user's pick — never present your own gift list or link), select_gift (the user's pasted pick message), approve_layout (returns ARTWORK_SPECS), approve_artwork (the user-approved file, parked as-is), set_order_details (quantity + delivery address, never invented), prepare_checkout (the signed link; the user signs in with OAuth in the browser, inside checkout only, and pays there — the card never passes through you). Then poll get_order_status for the store's confirmation, and know lookup_order + the p2gift-order-lookup skill for later status checks. Never invent pitch wording, quantity, recipient, or price.",
          },
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
    if (name === "service_info") {
      const inv = await loadInventory(env);
      payload = result(id, textResult({
        service: "PPT-to-Gift Service Worker",
        endpoint: "https://p2gift.keeg.uk/mcp",
        version: SERVER.version,
        flow: "lock-stage wizard",
        stages: STAGES,
        inventory_source: inv.source,
        gift_items: inv.items.map((i) => ({ id: i.id, name: i.name, surface: i.surface, treatment: i.treatment ?? null, lead_time_days: i.lead_time_days ?? null })),
        note: "The product page URL is issued by approve_pitch at the pitch lock — it is not listed here, and the agent never presents its own gift list or catalog link.",
      }));
    } else if (name === "start_session") {
      payload = toolPayload(id, await startSession(env, { pitchCandidates: args.pitch_candidates, customer }));
    } else if (name === "approve_pitch") {
      if (!args.session_id || !args.pitch_text) payload = error(id, -32602, "session_id and pitch_text are required");
      else payload = toolPayload(id, await approvePitch(env, { sessionId: args.session_id, pitchText: args.pitch_text }));
    } else if (name === "select_gift") {
      if (!args.session_id || !args.pick) payload = error(id, -32602, "session_id and pick are required");
      else payload = toolPayload(id, await selectGift(env, { sessionId: args.session_id, pick: args.pick }));
    } else if (name === "approve_layout") {
      if (!args.session_id || !args.layout) payload = error(id, -32602, "session_id and layout are required");
      else payload = toolPayload(id, await approveLayout(env, { sessionId: args.session_id, layout: args.layout }));
    } else if (name === "approve_artwork") {
      if (!args.session_id || !args.artwork_png_base64) payload = error(id, -32602, "session_id and artwork_png_base64 are required");
      else payload = toolPayload(id, await approveArtwork(env, { sessionId: args.session_id, artworkBase64: args.artwork_png_base64, artworkName: args.artwork_name ?? undefined }));
    } else if (name === "set_order_details") {
      if (!args.session_id || args.quantity == null || !args.shipping) payload = error(id, -32602, "session_id, quantity and shipping are required");
      else payload = toolPayload(id, await setOrderDetails(env, { sessionId: args.session_id, quantity: args.quantity, shipping: args.shipping }));
    } else if (name === "prepare_checkout") {
      if (!args.session_id) {
        payload = error(id, -32602, "session_id is required");
      } else if (
        !(await rateLimitHit(env, "prepare-checkout-ip", ip, MCP_PREPARE_CHECKOUT_LIMIT_PER_HOUR)) ||
        !(await rateLimitHit(env, "prepare-checkout-session", args.session_id, MCP_PREPARE_CHECKOUT_LIMIT_PER_HOUR))
      ) {
        // The costly call (D1/R2 writes) gets the strict bucket: per IP
        // and per wizard session.
        payload = error(id, -32000, "Too many checkout preparations in the last hour. Wait, or use Live Connect (draft an email to hello@keeg.uk).");
      } else {
        payload = toolPayload(id, await prepareCheckoutFromSession(env, authProps, { sessionId: args.session_id }));
      }
    } else if (name === "get_order_status") {
      if (!args.session_id) payload = error(id, -32602, "session_id is required");
      else payload = toolPayload(id, await getOrderStatus(env, { sessionId: args.session_id }));
    } else if (name === "lookup_order") {
      if (!args.order_id || !args.order_token) payload = error(id, -32602, "order_id and order_token are required");
      else payload = toolPayload(id, await lookupOrder(env, { orderId: args.order_id, orderToken: args.order_token }));
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
    if (url.pathname === "/health") return handleHealthRequest();
    if (url.pathname === "/inventory") return handleInventoryRequest(env);
    if (url.pathname === "/connect") {
      return Response.redirect(new URL("/", request.url), 301);
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    return handleMcpRequest(request, env);
  },
};
