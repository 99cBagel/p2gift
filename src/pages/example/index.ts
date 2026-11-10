import type { APIRoute } from 'astro';
import { renderExample } from './render';

export const prerender = false;

// GET /example — mapped to the default workflow-log example
// (examples/default.md): the human info page a reader lands on after
// /connect. Rendered directly here, no redirect; /example/default
// serves the same source.
export const GET: APIRoute = async ({ url, request }) => {
  return renderExample('default', url, request);
};
