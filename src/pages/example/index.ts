import type { APIRoute } from 'astro';

export const prerender = false;

// GET /example — the examples index for now just forwards to the
// default example; it becomes a list when more examples are added.
export const GET: APIRoute = async () => {
  return new Response(null, {
    status: 302,
    headers: { location: '/example/default' },
  });
};
