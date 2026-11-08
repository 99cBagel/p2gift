import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleConnectRequest } from '../../mcp-server/index.js';

export const prerender = false;

// GET /connect — consolidated Connect guide (Muse + Claude), served
// from R2 (connect/Connect_page_guide.html). Served by this Worker so
// the page stays public even though the repo will go private.
export const GET: APIRoute = async () => {
  return handleConnectRequest(env);
};
