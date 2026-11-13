import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleInventoryRequest } from '../../mcp-server/index.js';

export const prerender = false;

// GET /inventory — public JSON of the gift item inventory: the
// store's active products in Product Page order, read from D1 (the
// wizard's direct mapping — no feed file). The picker page and the
// wiki gift items page read this live.
export const GET: APIRoute = async () => {
  return handleInventoryRequest(env);
};
