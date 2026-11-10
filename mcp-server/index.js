// p2gift MCP service — JSON-RPC + public routes, zero dependencies.
// Implements the JSON-RPC surface MCP clients need: initialize,
// notifications/initialized, tools/list, tools/call, resources/list,
// resources/read, prompts/list, prompts/get, ping.
// Auth (v0.2.0): OAuth 2.1. The /mcp endpoint is served by the merged
// Worker behind an OAuth resource server (see src/features/auth/oauth.ts):
// a request only reaches this module after its bearer token was validated,
// and the signed-in user's identity arrives as `authProps`
// ({ userId, email, name, provider }). /health and /inventory stay public.
// R2 binding P2GIFT_BUCKET (bucket "p2gift") serves the Connect-stage
// learning example at connect-examples/ — the Worker reads it from R2, it
// does not embed the images in code.
//
// This module is transport-agnostic: the named handlers below take a
// Request and an env (with P2GIFT_BUCKET) and return a Response. The Astro
// routes in src/pages/inventory.ts, src/pages/connect.ts and
// src/pages/health.ts call them, and /mcp is routed by the Worker entry
// (src/worker.ts) through the OAuth resource server, so the MCP service has
// exactly one implementation. The default export is the standalone Worker
// entry (the pre-merge shape), kept for local use: there the Connect Guide
// is the landing page at / and /connect redirects to it. In the merged
// Worker the storefront owns / and the guide is served at /connect
// instead — same handler, different route.
import { KI_POOL, suggestKeepsakes } from "./keepsakes.js";
import { loadInventory } from "./inventory.js";
import { STEPS, startOrder, nextStep, confirmStep } from "./workflow.js";

const SERVER = { name: "p2gift", version: "0.2.0" };

// Connect-stage learning example, stored in R2 bucket "p2gift"
// under connect-examples/. The agent reads the markdown first,
// then views all 5 images in order, before starting step 1.
const CONNECT_FILES = [
  { key: "connect-examples/connect-example.md", mimeType: "text/markdown", name: "Connect example — Muse Chat Log, Example2 (streamlined)", description: "Streamlined example run: pitch, 3 concepts, mockup fixes, 3 layouts, artwork, checkout gating." },
  { key: "connect-examples/mockup-tumbler.webp", mimeType: "image/webp", name: "Tumbler mockup", description: "Stainless Tumbler mockup, white pitch text on matte black, no period." },
  { key: "connect-examples/layout-a.webp", mimeType: "image/webp", name: "Layout A — centered, 3 lines", description: "Layout A: centered, 3 lines, large." },
  { key: "connect-examples/layout-b.webp", mimeType: "image/webp", name: "Layout B — hierarchy", description: "Layout B, chosen: small top line, rule, large name." },
  { key: "connect-examples/layout-c.webp", mimeType: "image/webp", name: "Layout C — 2 lines, em dash", description: "Layout C: 2 lines, em dash kept." },
  { key: "connect-examples/artwork-layout-b.png", mimeType: "image/png", name: "Print artwork — Layout B", description: "Print-ready artwork, Layout B, white text on black, 3600x2400 px, 300 DPI." },
];
const CONNECT_RESOURCES = CONNECT_FILES.map((f) => ({
  uri: `p2gift://${f.key}`,
  name: f.name,
  description: f.description,
  mimeType: f.mimeType,
}));

// The ONE pick flow, taught identically to agents and users: after the
// pitch is confirmed, present the 3 concepts together with a
// [view catalog] link to the Product Page, and the user picks by
// pasting `I pick N — <keepsake name> <image link>` — the same message
// the Product Page's "Pick N — Paste message to Muse" button copies.
const CATALOG_URL = "https://p2gift.keeg.uk/";
// Only these two keepsakes are store catalog products with a Product
// Page image. Every other keepsake gets image_url: null and a pick
// message without a link — NEVER invent an image link.
const CATALOG_IMAGE_URLS = {
  "stainless-tumbler-20oz": "https://p2gift.keeg.uk/images/catalog/b0fjlskf6v.jpg",
  "stainless-cups-5pack-12oz": "https://p2gift.keeg.uk/images/catalog/b0gtzp2ddw.jpg",
};

function catalogImageUrl(keepsakeId) {
  return CATALOG_IMAGE_URLS[keepsakeId] ?? null;
}

function pickMessage(rank, keepsake) {
  const imageUrl = catalogImageUrl(keepsake?.id);
  return imageUrl
    ? `I pick ${rank} — ${keepsake.name} ${imageUrl}`
    : `I pick ${rank} — ${keepsake.name}`;
}

// User-facing instruction the agent can show with the concepts: the
// [view catalog] link plus each concept's ready pick message.
function pickInstruction(concepts) {
  const list = concepts.map((c) => `${c.rank}. ${c.keepsake.name}\n   Paste: \`${c.pick_message}\``).join("\n");
  return [
    "Present these three concepts to the user together with a [view catalog] link to the Product Page. The user picks by pasting a message in this shape: `I pick N — <keepsake name> <image link>`, where the image link is that keepsake's image on the Product Page.",
    "",
    `Click to view the available Keepsake Items: [view catalog](${CATALOG_URL})`,
    "",
    list,
    "",
    "Which one — 1, 2, or 3?",
  ].join("\n");
}

const HOW_TO_PICK = "After the pitch is confirmed, present the three keepsake concepts to the user together with a [view catalog] link to the Product Page (https://p2gift.keeg.uk/). The user picks by pasting a message in this shape: `I pick N — <keepsake name> <image link>`, where the image link is that keepsake's image on the Product Page — e.g. `I pick 3 — Stainless Tumbler (20 oz) https://p2gift.keeg.uk/images/catalog/b0fjlskf6v.jpg`. Only store catalog products have an image link (Stainless Tumbler (20 oz); 5-Pack Stainless Cups (12 oz)); for any other keepsake the pick message omits the link — never invent one.";

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
    name: "service_info",
    description: "PPT-to-Gift service overview and the keepsake item pool.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "suggest_keepsakes",
    description: "From one pitch, return three different gift keepsake concepts. Present the three concepts to the user together with a [view catalog] link to the Product Page (https://p2gift.keeg.uk/); the user picks by pasting a message in this shape: `I pick N — <keepsake name> <image link>`. The result includes catalog_url, a pick_instruction to show the user, and each concept's image_url and ready pick_message.",
    inputSchema: {
      type: "object",
      properties: {
        pitch: { type: "string", description: "Pitch Snippets text." },
        recipient_profile: { type: ["string", "null"], description: "Recipient profile, only if the customer supplied it." },
        topic_category: { type: ["string", "null"], description: "Topic category, e.g. Professional, Health, Community." },
      },
      required: ["pitch"],
    },
  },
  {
    name: "start_order",
    description: "Start a p2gift order workflow. Returns the session and step 1 (pitch).",
    inputSchema: { type: "object", properties: { pitch_proposal: { type: "string" } } },
  },
  {
    name: "get_next_step",
    description: "Get the current next step for an order session. The session object is passed back as given.",
    inputSchema: { type: "object", properties: { session: { type: "object" } }, required: ["session"] },
  },
  {
    name: "confirm_step",
    description: "Confirm the current workflow step and advance one step. Rejects out-of-order confirmations.",
    inputSchema: {
      type: "object",
      properties: { session: { type: "object" }, step: { type: "string" }, data: { type: "object" } },
      required: ["session", "step"],
    },
  },
  {
    name: "list_keepsakes",
    description: "List the current keepsake item pool.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_inventory",
    description: "List the available inventory from R2 inventory/inventory.json — only items with available=true. This is the source suggest_keepsakes picks from.",
    inputSchema: { type: "object", properties: {} },
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

// GET /health — public service JSON (no key needed).
export function handleHealthRequest() {
  return new Response(JSON.stringify({ service: "p2gift", mcp: "/mcp", version: SERVER.version, auth: "oauth", connect_example: "p2gift://connect-examples/connect-example.md" }), {
    headers: { "content-type": "application/json" },
  });
}

// GET /inventory — public JSON for the picker page and the wiki keepsakes page.
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

// POST /mcp — JSON-RPC over Streamable HTTP (stateless: one request, one reply).
// Auth is enforced BEFORE this handler by the OAuth resource server in the
// merged Worker (src/features/auth/oauth.ts): a request only arrives here
// with a validated token, and `authProps` is the signed-in user
// ({ userId, email, name, provider }). The check below is defense in depth —
// it fails closed if this handler is ever reached without a validated
// identity (e.g. the legacy standalone entry, which has no resource server).
export async function handleMcpRequest(request, env, authProps) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  if (!authProps?.userId) {
    return Response.json(
      error(null, -32001, "Unauthorized: this MCP endpoint needs a validated OAuth sign-in. Connect with your login, not an API key."),
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="p2gift"' } }
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
    payload = result(id, { resources: CONNECT_RESOURCES });
  } else if (method === "resources/read") {
    const uri = params?.uri ?? "";
    const file = CONNECT_FILES.find((f) => `p2gift://${f.key}` === uri);
    if (!file) {
      payload = error(id, -32002, `Resource not found: ${uri}`);
    } else if (!env?.P2GIFT_BUCKET) {
      payload = error(id, -32603, "R2 binding P2GIFT_BUCKET is not configured on this Worker.");
    } else {
      const obj = await env.P2GIFT_BUCKET.get(file.key);
      if (!obj) {
        payload = error(id, -32002, `Resource not found in R2: ${file.key}`);
      } else if (file.mimeType.startsWith("text/")) {
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
        description: "Connect to p2gift: read the skills and the connect example first, then start an order at step 1 (pitch).",
      }],
    });
  } else if (method === "prompts/get") {
    if (params?.name !== "p2gift-connect") {
      payload = error(id, -32602, `Unknown prompt: ${params?.name}`);
    } else {
      payload = result(id, {
        description: "Connect to p2gift: read the skills and the connect example first, then start an order at step 1 (pitch).",
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: "You are connected to p2gift (PPT-to-Gift). Before starting any order, read these resources in order: 1) p2gift://connect-examples/connect-example.md, then 2) the 5 image assets in the same folder — mockup-tumbler.webp, layout-a.webp, layout-b.webp, layout-c.webp, artwork-layout-b.png. Learn the flow from that example: pitch confirmed as-is, 3 concepts — present them to the user together with a [view catalog] link to the Product Page (https://p2gift.keeg.uk/), and the user picks by pasting `I pick N — <keepsake name> <image link>` (the image link is that keepsake's image on the Product Page) — then mockup fixes, 3 layout examples, pick A/B/C, artwork review and approval, then checkout gated on quantity + recipient name/address + price. Never invent a price. Never skip a step — the Worker enforces the order with start_order / get_next_step / confirm_step. Then start with start_order at step 1 (pitch).",
          },
        }],
      });
    }
  } else if (method === "tools/list") {
    payload = result(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === "service_info") {
      const inv = await loadInventory(env);
      payload = result(id, textResult({ service: "PPT-to-Gift Service Worker", endpoint: "https://p2gift.keeg.uk/mcp", inventory_source: inv.source, keepsake_pool: inv.items, catalog_url: CATALOG_URL, how_to_pick: HOW_TO_PICK }));
    } else if (name === "start_order") {
      // The signed-in user travels with the order: the session records who
      // placed it, so the checkout draft and the store order carry that
      // identity (the human still pays in the browser — the token can't pay).
      const session = startOrder({
        pitchProposal: args.pitchProposal,
        customer: {
          userId: authProps.userId,
          email: authProps.email ?? null,
          name: authProps.name ?? null,
          provider: authProps.provider,
        },
      });
      payload = result(id, textResult({ session, next_step: nextStep(session), steps: STEPS }));
    } else if (name === "get_next_step") {
      if (!args.session) payload = error(id, -32602, "session is required");
      else payload = result(id, textResult(nextStep(args.session)));
    } else if (name === "confirm_step") {
      if (!args.session || !args.step) payload = error(id, -32602, "session and step are required");
      else {
        const out = confirmStep(args.session, { step: args.step, data: args.data ?? {} });
        if (out.error) payload = error(id, -32602, out.error);
        else payload = result(id, textResult(out));
      }
    } else if (name === "list_keepsakes") {
      const inv = await loadInventory(env);
      payload = result(id, textResult({ source: inv.source, keepsakes: inv.items }));
    } else if (name === "list_inventory") {
      const inv = await loadInventory(env);
      payload = result(id, textResult({ source: inv.source, items: inv.items }));
    } else if (name === "suggest_keepsakes") {
      if (!args.pitch) payload = error(id, -32602, "pitch is required");
      else {
        const inv = await loadInventory(env);
        const suggestion = suggestKeepsakes({ pitch: args.pitch, recipientProfile: args.recipient_profile ?? null, topicCategory: args.topic_category ?? null, pool: inv.items });
        const concepts = suggestion.concepts.map((c) => ({
          ...c,
          image_url: catalogImageUrl(c.keepsake?.id),
          pick_message: pickMessage(c.rank, c.keepsake),
        }));
        payload = result(id, textResult({ inventory_source: inv.source, ...suggestion, concepts, catalog_url: CATALOG_URL, pick_instruction: pickInstruction(concepts) }));
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
// NOTE (v0.2.0): /mcp here has no OAuth resource server in front of it, so
// handleMcpRequest fails closed (401) without a validated identity. The
// merged Worker (src/worker.ts) is the deployment — this entry is not.
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
