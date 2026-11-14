// p2gift MCP service — JSON-RPC + public routes, zero dependencies.
// Implements the JSON-RPC surface MCP clients need: initialize,
// notifications/initialized, tools/list, tools/call, resources/list,
// resources/read, prompts/list, prompts/get, ping.
//
// v0.5.0 — the lock-stage wizard, flex-menu dialog. Ordering runs
// through a server-side session (D1 table wizard_sessions, migration
// 0046): the Agent holds only a session_id, and each tool advances
// exactly one stage — intake → pitch → gift → layout → artwork →
// checkout → confirmation (+ order lookup). The state machine lives
// in session.js / checkout.js; locks are read from the session row,
// never from Agent arguments. v0.5.0 (owner decisions, 2026-11-14):
// the pitch locks verbatim — the fit rail is gone; there is no
// order-details stage — prepare_checkout runs from the artwork
// lock and Stripe collects the delivery address at payment; all
// picks happen in the Muse dialog (flex menu) and the Product
// Page is view-only reference. Artwork carries no automated file
// rail — approve_artwork parks the file as-is and the operator
// reviews it manually (owner decision, 2026-11-13).
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

const SERVER = { name: "p2gift", version: "0.5.0" };

const STAGES = [
  "1 Intake — start_session records the pitch candidates from the source",
  "2 Pitch — approve_pitch locks the exact pitch text, verbatim (no fit check, no reshape)",
  "3 Gift — select_gift locks the gift from the user's pick in the dialog (the product page is view-only)",
  "4 Layout — approve_layout locks the Print Layout Design and issues ARTWORK_SPECS",
  "5 Artwork — approve_artwork parks the user-approved Final Print Artwork (no automated check)",
  "6 Order details (optional) — set_order_details locks quantity + delivery name/address when the user gave them; checkout does not require it",
  "7 Checkout — prepare_checkout issues the signed checkout link; the user pays on the store page and Stripe collects email, delivery address and card (this store's OAuth gate is off — Stripe's payment is the signing)",
  "8 Confirmation — get_order_status reports the webhook-settled order back to the Agent",
  "9 Order lookup — lookup_order by order # + order token, no session needed",
];

// Worked examples for few-shot (N-shot) learning, stored in R2 under
// examples/. One Markdown file per example, slug-named; "default" is
// Example 1 (the flex-menu dialog, customer view) and "annotated" is
// Example 2 (the same run with the server log lines). The same
// Markdown is rendered for humans at /example/<slug> (HTML in a
// browser, raw Markdown with ?format=md). Adding an example = add
// its files here and sync them to R2.
const EXAMPLE_FILES = [
  { key: "examples/connect-prompt/default.md", mimeType: "text/markdown", name: "Connect Prompt — p2gift overview for the connected Agent", description: "Read first on connect: what p2gift (PPT-to-Gift) is, the flex-menu dialog rules, the stages, the commands, the canonical terms, and the guardrails." },
  { key: "examples/default.md", mimeType: "text/markdown", name: "Example 1 (default) — flex-menu dialog, clean (customer view)", description: "Default worked example: PPT in, pitch locked verbatim, gift + layout + artwork picked in the dialog, checkout link, Order Status. No tool lines — the run as the customer sees it." },
  { key: "examples/annotated.md", mimeType: "text/markdown", name: "Example 2 — flex-menu dialog, annotated (server log)", description: "The same flex-menu run with the server-side log lines: tool calls, tool replies, local work, locks, session states." },
  { key: "examples/assets/ex1-layout-a.webp", mimeType: "image/webp", name: "Example 1 asset — Layout A mockup", description: "Example 1: Layout A mockup on the Tumbler's themed-base image." },
  { key: "examples/assets/ex1-layout-b.webp", mimeType: "image/webp", name: "Example 1 asset — Layout B mockup (picked)", description: "Example 1: Layout B mockup on the Tumbler's themed-base image — the picked layout." },
  { key: "examples/assets/ex1-layout-c.webp", mimeType: "image/webp", name: "Example 1 asset — Layout C mockup", description: "Example 1: Layout C mockup on the Tumbler's themed-base image." },
  { key: "examples/assets/ex1-artwork-preview.png", mimeType: "image/png", name: "Example 1 asset — Final Print Artwork preview", description: "Example 1: the approved Final Print Artwork (Layout B), previewed on black." },
  { key: "examples/assets/ex2-layout-a.webp", mimeType: "image/webp", name: "Example 2 asset — Layout A mockup", description: "Example 2: Layout A mockup on the Tumbler's themed-base image." },
  { key: "examples/assets/ex2-layout-b.webp", mimeType: "image/webp", name: "Example 2 asset — Layout B mockup", description: "Example 2: Layout B mockup on the Tumbler's themed-base image." },
  { key: "examples/assets/ex2-layout-c.webp", mimeType: "image/webp", name: "Example 2 asset — Layout C mockup (picked)", description: "Example 2: Layout C mockup on the Tumbler's themed-base image — the picked layout." },
  { key: "examples/assets/ex2-artwork-preview.png", mimeType: "image/png", name: "Example 2 asset — Final Print Artwork preview", description: "Example 2: the approved Final Print Artwork (Layout C), previewed on black." },
  { key: "examples/assets/themed-base.webp", mimeType: "image/webp", name: "Example asset — themed-base (Tumbler mockup)", description: "Stainless Tumbler mockup, white pitch text on matte black, no period." },
  { key: "examples/assets/layout-a.webp", mimeType: "image/webp", name: "Example asset — Layout A", description: "Layout A: centered, 3 lines, large." },
  { key: "examples/assets/layout-b.webp", mimeType: "image/webp", name: "Example asset — Layout B", description: "Layout B, chosen: small top line, rule, large name." },
  { key: "examples/assets/layout-c.webp", mimeType: "image/webp", name: "Example asset — Layout C", description: "Layout C: 2 lines, em dash kept." },
  { key: "examples/assets/layout-3choices.webp", mimeType: "image/webp", name: "Example asset — Layouts A, B, C in one image", description: "The three print layout designs side by side in one strip — A left, B middle, C right; the combined image shown in the default workflow example." },
  { key: "examples/assets/final_print_artwork.png", mimeType: "image/png", name: "Example asset — Final Print Artwork, Layout B", description: "Final Print Artwork, Layout B, white text on black." },
  { key: "examples/assets/copychar.png", mimeType: "image/png", name: "Example asset — CopyChar icon", description: "The copy icon at the end of the How to Start message line in the skills briefer." },
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
    description: "Stage 2 (Pitch): lock the pitch wording the user settled — verbatim, exactly as given. No fit check and no reshape: any wording with printable text locks. On the lock, returns product_page_url (view-only reference; the gift pick itself happens in the dialog).",
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
    description: "Stage 3 (Gift): lock the gift from the user's pick in the dialog, passed in the shape `I pick N — <gift item name>[, Color: <color>]` (the agent forms it from the user's tap). The number maps to the product page's order. On the lock it feeds back the item's layout_options and themed_base_image for the layout stage.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        pick: { type: "string", description: "The pick, in the shape \"I pick N — <gift item name>[, Color: <color>]\"." },
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
    description: "Stage 6 (Order details, optional): lock a quantity (and delivery name + address) the user gave in the dialog, exactly as given — none may be invented. prepare_checkout does NOT require this stage: without it the quantity is 1 and Stripe collects the delivery address at payment.",
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
    description: "Stage 7 (Checkout): build the checkout from the locked session — the agent supplies only the session_id; gift, variant, quantity (1 unless set_order_details locked one), artwork, and price all come from the locked row and the live catalog. No address is collected by the agent — Stripe collects the email, the delivery address and the card on its page. Returns checkout_url: a signed, single-use link expiring in about 15 minutes. The user opens it, sees the locked price and cart, and pays on the store page (this store's OAuth sign-in gate is off; the payment is the signing); the card never passes through the agent. An expired link is re-issued by calling again.",
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
        description: "Connect to p2gift: read the connect prompt first, then the worked examples, then reply with the # Select A Source stage (flex menu).",
      }],
    });
  } else if (method === "prompts/get") {
    if (params?.name !== "p2gift-connect") {
      payload = error(id, -32602, `Unknown prompt: ${params?.name}`);
    } else {
      payload = result(id, {
        description: "Connect to p2gift: read the connect prompt first, then the worked examples, then reply with the # Select A Source stage (flex menu).",
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: "You are connected to p2gift (PPT-to-Gift). Before starting any order, read these resources in order: 1) p2gift://examples/connect-prompt/default.md — the connect prompt: what p2gift is, the flex-menu dialog rules, the stages, the commands, the canonical terms, the guardrails — then 2) p2gift://examples/default.md (Example 1, the clean dialog) and p2gift://examples/annotated.md (Example 2, the same run with the server log lines). The image assets under examples/assets/ are presentation links: fetch one only when you need to show it to the user; the text resources carry the rules. Then send the connect prompt's first stage as your first reply: '# Select A Source' — the Connected line and the flex menu (PPT 2 gift · Pitch 2 gift · Remove this). The dialog: every stage reply is a # Stage Title plus a minimal telegram-style body; bounded picks are flex-menu taps in the dialog; links are view-only. The wizard behind it: the server holds the session; you hold only the session_id. Start with start_session once the pitch candidates are drafted locally from the user's source. Each stage locks before the next opens — approve_pitch (the pitch locks verbatim — no fit check, no reshape), select_gift (the pick formed from the user's tap, in the 'I pick N — …' shape), approve_layout (returns ARTWORK_SPECS), approve_artwork (the user-approved file, parked as-is), prepare_checkout (the signed link; no order-details stage — the user pays on the store page and Stripe collects the email, delivery address and card; this store's OAuth gate is off, so the payment is the signing; the card never passes through you). set_order_details stays available for a quantity the user gives in the dialog, but checkout never requires it. The run ends with the # Order Status message from get_order_status; lookup_order serves later status checks. Never invent pitch wording, quantity, recipient, or price.",
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
        note: "The product page URL is issued by approve_pitch at the pitch lock as view-only reference — the gift pick itself happens in the dialog, from the live items listed here.",
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
    if (url.pathname === "/health") return handleHealthRequest(env);
    if (url.pathname === "/inventory") return handleInventoryRequest(env);
    if (url.pathname === "/connect") {
      return Response.redirect(new URL("/", request.url), 301);
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    return handleMcpRequest(request, env);
  },
};
