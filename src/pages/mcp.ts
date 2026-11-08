import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleMcpRequest } from '../../mcp-server/index.js';

export const prerender = false;

// POST /mcp — p2gift MCP endpoint (JSON-RPC over Streamable HTTP).
// The handler lives in mcp-server/ so the MCP service has exactly one
// implementation, shared with the standalone Worker entry. Requires a
// per-customer API key (Authorization: Bearer <key>, v0.1.9); the
// handler enforces it. Mounted here so the store and the MCP service
// run in the same Worker on p2gift.keeg.uk.
export const POST: APIRoute = async ({ request }) => {
  return handleMcpRequest(request, env);
};

export const GET: APIRoute = async ({ request }) => {
  return handleMcpRequest(request, env);
};
