// p2gift Worker — MCP Streamable HTTP at /mcp, zero dependencies.
// Implements the JSON-RPC surface MCP clients need: initialize,
// notifications/initialized, tools/list, tools/call, ping.
// No auth: the published endpoint is public, as documented in
// p2gift-wiki. No D1/R2 in v1 — pitch in, three concepts out.
import { KI_POOL, suggestKeepsakes } from "./keepsakes.js";

const SERVER = { name: "p2gift", version: "0.1.0" };

const TOOLS = [
  {
    name: "service_info",
    description: "PPT-to-Gift service overview and the keepsake item pool.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "suggest_keepsakes",
    description: "From one pitch, return three different gift keepsake concepts.",
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
    name: "list_keepsakes",
    description: "List the current keepsake item pool.",
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

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(JSON.stringify({ service: "p2gift", mcp: "/mcp", version: SERVER.version }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

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
        capabilities: { tools: {} },
        serverInfo: SERVER,
      });
    } else if (method === "ping") {
      payload = result(id, {});
    } else if (method === "tools/list") {
      payload = result(id, { tools: TOOLS });
    } else if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === "service_info") {
        payload = result(id, textResult({ service: "PPT-to-Gift Service Worker", endpoint: "https://p2gift.keeg.uk/mcp", keepsake_pool: KI_POOL }));
      } else if (name === "list_keepsakes") {
        payload = result(id, textResult({ keepsakes: KI_POOL }));
      } else if (name === "suggest_keepsakes") {
        if (!args.pitch) payload = error(id, -32602, "pitch is required");
        else payload = result(id, textResult(suggestKeepsakes({ pitch: args.pitch, recipientProfile: args.recipient_profile ?? null, topicCategory: args.topic_category ?? null })));
      } else {
        payload = error(id, -32602, `Unknown tool: ${name}`);
      }
    } else {
      payload = error(id, -32601, `Method not found: ${method}`);
    }
    return Response.json(payload, {
      headers: { "content-type": "application/json", "mcp-session-id": "p2gift-stateless" },
    });
  },
};
