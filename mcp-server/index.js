// p2gift MCP service — JSON-RPC + public routes, zero dependencies.
// Implements the JSON-RPC surface MCP clients need: initialize,
// notifications/initialized, tools/list, tools/call, resources/list,
// resources/read, prompts/list, prompts/get, ping.
// Auth (v0.2.0): OAuth 2.1. The /mcp endpoint is served by the merged
// Worker behind an OAuth resource server (see src/features/auth/oauth.ts):
// a request only reaches this module after its bearer token was validated,
// and the signed-in user's identity arrives as `authProps`
// ({ userId, email, name, provider }). /health and /inventory stay public.
// R2 binding P2GIFT_BUCKET (bucket "p2gift") serves the learning
// examples at examples/ — the Worker reads them from R2, it
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
import { suggestGifts } from "./gifts.js";
import { loadInventory } from "./inventory.js";
import { STEPS, startOrder, nextStep, confirmStep } from "./workflow.js";
import { prepareCheckout } from "./prepare-checkout.js";

const SERVER = { name: "p2gift", version: "0.2.0" };


// Worked examples for few-shot (N-shot) learning, stored in R2 under
// examples/. One Markdown file per example, slug-named; "default" is
// Example 1 (xDrive PPT run). The same Markdown is rendered for humans
// at /example/<slug> (HTML in a browser, raw Markdown with ?format=md).
// Adding an example = add its files here and sync them to R2.
const EXAMPLE_FILES = [
  { key: "examples/connect-prompt/default.md", mimeType: "text/markdown", name: "Connect Prompt — p2gift overview for the connected Agent", description: "Read first on connect: what p2gift (PPT-to-Gift) is, why it exists, the canonical terms, the 5-step workflow, the resources, and the tools." },
  { key: "examples/default.md", mimeType: "text/markdown", name: "Example 1 (default) — Muse Chat Log, xDrive PPT run", description: "Default worked example: PPT in, pitch confirmed as-is, gift pick via [view catalog], mockup fixes, 3 layouts, artwork approval, checkout gating on quantity + recipient + price." },
  { key: "examples/assets/themed-base.webp", mimeType: "image/webp", name: "Example asset — themed-base (Tumbler mockup)", description: "Stainless Tumbler mockup, white pitch text on matte black, no period." },
  { key: "examples/assets/layout-a.webp", mimeType: "image/webp", name: "Example asset — Layout A", description: "Layout A: centered, 3 lines, large." },
  { key: "examples/assets/layout-b.webp", mimeType: "image/webp", name: "Example asset — Layout B", description: "Layout B, chosen: small top line, rule, large name." },
  { key: "examples/assets/layout-c.webp", mimeType: "image/webp", name: "Example asset — Layout C", description: "Layout C: 2 lines, em dash kept." },
  { key: "examples/assets/layout-3choices.webp", mimeType: "image/webp", name: "Example asset — Layouts A, B, C in one image", description: "The three print layout designs side by side in one strip — A left, B middle, C right; the combined image shown in the default workflow example." },
  { key: "examples/assets/final_print_artwork.png", mimeType: "image/png", name: "Example asset — Final Print Artwork, Layout B", description: "Final Print Artwork, Layout B, white text on black." },
  { key: "examples/print-layout-example.md", mimeType: "text/markdown", name: "Print Layout Design examples", description: "The three Print Layout Designs (A, B, C) with example images — the designs the suggest_print_layout tool returns." },
  { key: "examples/inventory/inventory.json", mimeType: "application/json", name: "Live gift item inventory", description: "The available gift items, aligned with the store Product Page — the source suggest_gifts picks from." },
];
const EXAMPLE_RESOURCES = EXAMPLE_FILES.map((f) => ({
  uri: `p2gift://${f.key}`,
  name: f.name,
  description: f.description,
  mimeType: f.mimeType,
}));
const ALL_RESOURCE_FILES = [...EXAMPLE_FILES];

// The ONE pick flow, taught identically to agents and users: after the
// pitch is confirmed, present the 3 concepts together with a
// [view catalog] link to the Product Page, and the user picks by
// pasting `I pick N — <gift item name> <image link>` — the same message
// the Product Page's "Pick N — Paste message to Muse" button copies.
const CATALOG_URL = "https://p2gift.keeg.uk/";
// Only these two gift items are store catalog products with a Product
// Page image. Every other gift item gets image_url: null and a pick
// message without a link — NEVER invent an image link.
const CATALOG_IMAGE_URLS = {
  "stainless-tumbler-20oz": "https://p2gift.keeg.uk/images/catalog/b0fjlskf6v.jpg",
  "stainless-cups-5pack-12oz": "https://p2gift.keeg.uk/images/catalog/b0gtzp2ddw.jpg",
};

// The three Print Layout Designs (see p2gift://examples/print-layout-example.md).
// The example images are the feed assets under examples/assets/, served
// by the storefront /images route once the R2 sync has run.
const PRINT_LAYOUTS = [
  { layout: "A", name: "Centered — 3 lines, large", description: "Pitch Text centered on 3 lines, large type. Line breaks take the place of dashes and other separators.", image_url: "https://p2gift.keeg.uk/images/examples/assets/layout-a.webp" },
  { layout: "B", name: "Hierarchy — small top line, rule, large name", description: "Small top line, a rule, then the name large. The design picked in the default workflow example.", image_url: "https://p2gift.keeg.uk/images/examples/assets/layout-b.webp" },
  { layout: "C", name: "2 lines — em dash kept", description: "Pitch Text on 2 lines, with separators such as the em dash kept.", image_url: "https://p2gift.keeg.uk/images/examples/assets/layout-c.webp" },
];

function catalogImageUrl(giftItemId) {
  return CATALOG_IMAGE_URLS[giftItemId] ?? null;
}

function pickMessage(rank, giftItem) {
  const imageUrl = catalogImageUrl(giftItem?.id);
  return imageUrl
    ? `I pick ${rank} — ${giftItem.name} ${imageUrl}`
    : `I pick ${rank} — ${giftItem.name}`;
}

// User-facing instruction the agent can show with the concepts: the
// [view catalog] link plus each concept's ready pick message.
function pickInstruction(concepts) {
  const list = concepts.map((c) => `${c.rank}. ${c.gift_item.name}\n   Paste: \`${c.pick_message}\``).join("\n");
  return [
    "Present these picks to the user together with a [view catalog] link to the Product Page. The user picks by pasting a message in this shape: `I pick N — <gift item name> <image link>`, where the image link is that gift item's image on the Product Page.",
    "",
    `Click to view the available gift items: [view catalog](${CATALOG_URL})`,
    "",
    list,
    "",
    "Which one will you pick?",
  ].join("\n");
}

const HOW_TO_PICK = "After the pitch is confirmed, present the picks from suggest_gifts to the user together with a [view catalog] link to the Product Page (https://p2gift.keeg.uk/). The user picks by pasting a message in this shape: `I pick N — <gift item name> <image link>`, where the image link is that gift item's image on the Product Page — e.g. `I pick 3 — Stainless Tumbler (20 oz) https://p2gift.keeg.uk/images/catalog/b0fjlskf6v.jpg`. Only store catalog products have an image link (Stainless Tumbler (20 oz); 5-Pack Stainless Cups (12 oz)); for any other gift item the pick message omits the link — never invent one.";

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
    description: "PPT-to-Gift service overview and the gift item pool.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "suggest_gifts",
    description: "From one pitch, suggest gift items for the user to pick from (up to three). Present the picks to the user together with a [view catalog] link to the Product Page (https://p2gift.keeg.uk/); the user picks by pasting a message in this shape: `I pick N — <gift item name> <image link>`. The result includes catalog_url, a pick_instruction to show the user, and each pick's image_url and ready pick_message.",
    inputSchema: {
      type: "object",
      properties: {
        pitch: { type: "string", description: "Pitch Text text." },
        recipient_profile: { type: ["string", "null"], description: "Recipient profile, only if the customer supplied it." },
        topic_category: { type: ["string", "null"], description: "Topic category, e.g. Professional, Health, Community." },
      },
      required: ["pitch"],
    },
  },
  {
    name: "suggest_print_layout",
    description: "From one Pitch Text, return the three Print Layout Designs (A, B, C) for the chosen gift item, each with its example image. Present all three to the user and ask which one — A, B, or C. Confirm the pick with confirm_step at the mockup step as data.layout.",
    inputSchema: {
      type: "object",
      properties: {
        pitch: { type: "string", description: "Pitch Text — the confirmed pitch to print." },
        gift_item: { type: ["string", "null"], description: "Gift item id or name the layout is for, if already picked." },
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
    name: "list_inventory",
    description: "List the available inventory from R2 examples/inventory/inventory.json — only items with available=true. This is the source suggest_gifts picks from.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "prepare_checkout",
    description: "Prepare the store checkout for a completed workflow session (step done, checkout draft present). Runs the shape checks: cart contents against the live catalog (item, variant, quantity, stock, shipping address, and the quoted price must equal the live catalog total), then the 2-layer Final Print Artwork check (Layer 1: PNG only, under 15 MB, transparent background, single color; Layer 2: the gift item's own print/engraving rules plus an AI negative check — text as printed vs the confirmed Pitch Text, the picked layout, no logo). On any failure it returns the reasons so the artwork or draft can be fixed and resubmitted. On success it stores the artwork with the order-to-be, prefills the cart, and returns checkout_url — the user opens it and pays on the store page; the card never passes through the agent.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "object", description: "The completed workflow session (step done) from confirm_step." },
        artwork_png_base64: { type: "string", description: "The approved Final Print Artwork, PNG, base64-encoded." },
        shipping: {
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
        },
        variant_label: { type: ["string", "null"], description: "Variant label the user picked (e.g. a Color for the cups), if any." },
        quantity: { type: ["integer", "null"], description: "Quantity — defaults to the checkout draft's quantity." },
        price_cents: { type: ["integer", "null"], description: "The quoted order total in cents — must equal the live catalog total or the preparation is rejected." },
        pitch_text: { type: ["string", "null"], description: "Defaults to the session's confirmed pitch." },
        layout: { type: ["string", "null"], description: "Defaults to the session's layout (A, B, or C)." },
        artwork_attempts: { type: ["integer", "null"], description: "How many artwork submissions have already failed for this order — pass the count from the previous rejection." },
      },
      required: ["session", "artwork_png_base64", "shipping"],
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

// GET /health — public service JSON (no key needed).
export function handleHealthRequest() {
  return new Response(JSON.stringify({ service: "p2gift", mcp: "/mcp", version: SERVER.version, auth: "oauth", example: "p2gift://examples/default.md" }), {
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
        description: "Connect to p2gift: read the connect prompt first, then the workflow example, then start an order at step 1 (pitch).",
      }],
    });
  } else if (method === "prompts/get") {
    if (params?.name !== "p2gift-connect") {
      payload = error(id, -32602, `Unknown prompt: ${params?.name}`);
    } else {
      payload = result(id, {
        description: "Connect to p2gift: read the connect prompt first, then the workflow example, then start an order at step 1 (pitch).",
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: "You are connected to p2gift (PPT-to-Gift). Before starting any order, read these resources in order: 1) p2gift://examples/connect-prompt/default.md — the connect prompt: what p2gift is, the canonical terms, the 5-step workflow, the resources and the tools — then 2) p2gift://examples/default.md, the worked example, and 3) know the 6 image assets in the same folder — examples/assets/themed-base.webp, layout-a.webp, layout-b.webp, layout-c.webp, layout-3choices.webp, final_print_artwork.png — as presentation links: fetch one only when you need to show it to the user or check a mockup; the text resources carry the rules, so you do not need to read the images to learn the flow. Also available: the Print Layout Design examples (p2gift://examples/print-layout-example.md) and the live gift item inventory (p2gift://examples/inventory/inventory.json). Learn the flow from that example: pitch confirmed as-is — suggest_gifts returns the gift items to pick from; present the picks to the user together with a [view catalog] link to the Product Page (https://p2gift.keeg.uk/), and the user picks by pasting `I pick N — <gift item name> <image link>` (the image link is that gift item's image on the Product Page) — then mockup fixes, 3 layout examples, pick A/B/C, Final Print Artwork review and approval, then checkout gated on quantity + recipient name/address + price. Never invent a price. Never skip a step — the Worker enforces the order with start_order / get_next_step / confirm_step. Then start with start_order at step 1 (pitch).",
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
      payload = result(id, textResult({ service: "PPT-to-Gift Service Worker", endpoint: "https://p2gift.keeg.uk/mcp", inventory_source: inv.source, gift_items: inv.items, catalog_url: CATALOG_URL, how_to_pick: HOW_TO_PICK }));
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
    } else if (name === "prepare_checkout") {
      if (!args.session || !args.artwork_png_base64 || !args.shipping) {
        payload = error(id, -32602, "session, artwork_png_base64 and shipping are required");
      } else {
        const out = await prepareCheckout(env, authProps, args);
        if (out.error && out.error !== "artwork_check_unavailable") payload = error(id, -32602, out.error);
        else payload = result(id, textResult(out));
      }
    } else if (name === "suggest_print_layout") {
      if (!args.pitch) payload = error(id, -32602, "pitch is required");
      else payload = result(id, textResult({ pitch_text: args.pitch, gift_item: args.gift_item ?? null, layouts: PRINT_LAYOUTS, layout_example: "p2gift://examples/print-layout-example.md", instruction: "Present the three Print Layout Designs (A, B, C) with their example images and ask the user which one. Confirm the pick with confirm_step at the mockup step as data.layout." }));
    } else if (name === "list_inventory") {
      const inv = await loadInventory(env);
      payload = result(id, textResult({ source: inv.source, items: inv.items }));
    } else if (name === "suggest_gifts") {
      if (!args.pitch) payload = error(id, -32602, "pitch is required");
      else {
        const inv = await loadInventory(env);
        const suggestion = suggestGifts({ pitch: args.pitch, recipientProfile: args.recipient_profile ?? null, topicCategory: args.topic_category ?? null, pool: inv.items });
        const concepts = suggestion.concepts.map((c) => ({
          ...c,
          image_url: catalogImageUrl(c.gift_item?.id),
          pick_message: pickMessage(c.rank, c.gift_item),
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
