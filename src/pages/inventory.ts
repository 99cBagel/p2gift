import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleInventoryRequest } from '../../mcp-server/index.js';

export const prerender = false;

// GET /inventory — public JSON of the available gift item inventory
// (R2 examples/inventory/inventory.json, available=true only). The picker page
// and the wiki gift items page read this live; when R2 is missing or
// empty the handler falls back to the built-in pool and says so.
export const GET: APIRoute = async () => {
  return handleInventoryRequest(env);
};
