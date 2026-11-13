import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleHealthRequest } from '../../mcp-server/index.js';

export const prerender = false;

// GET /health — public service JSON (no API key needed). Liveness
// probe: service name, MCP endpoint, version, auth mode.
export const GET: APIRoute = async () => {
  return handleHealthRequest(env);
};
