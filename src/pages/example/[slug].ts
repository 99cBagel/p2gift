import type { APIRoute } from 'astro';
import { renderExample } from './render';

export const prerender = false;

// GET /example/<slug> — a worked p2gift example (chat log), rendered
// from the Markdown source in R2 at examples/<slug>.md (see render.ts).
export const GET: APIRoute = async ({ params, url, request }) => {
  return renderExample(params.slug ?? '', url, request);
};
