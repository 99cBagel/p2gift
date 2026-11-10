import { env } from 'cloudflare:workers';
import { renderMarkdown } from '../../features/pages/markdown';

// Shared renderer for the worked p2gift examples, published from ONE
// Markdown source stored in R2 at examples/<slug>.md:
//   - browsers get an HTML rendering of the Markdown;
//   - ?format=md (or an Accept: text/markdown request) returns the raw
//     Markdown — the same bytes the MCP resource p2gift://examples/<slug>
//     serves to agents for few-shot learning.
// Assets referenced as examples/assets/<file> (or ./assets/<file>) in the
// Markdown are served by the /images route from the same bucket.

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function pageHtml(title: string, slug: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — p2gift</title>
<link rel="icon" href="/favicon.ico">
<style>
  body { margin: 0; background: #f6f4ef; color: #171a1f; font: 16px/1.65 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 28px 20px 56px; }
  header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  header img { width: 34px; height: 34px; border-radius: 8px; }
  header .brand { font-size: 20px; font-weight: 700; }
  header .kind { margin-left: auto; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: #8a8378; }
  main img { max-width: 100%; height: auto; border-radius: 10px; }
  pre { background: #fffdf8; border: 1px solid #e4ded2; border-radius: 10px; padding: 14px 16px; overflow-x: auto; font-size: 14px; line-height: 1.6; }
  code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e4ded2; font-size: 13.5px; color: #6f6a5f; }
  footer a { color: #0f766e; }
</style>
</head>
<body>
<div class="wrap">
<header><img src="/p2gift-icon.png" alt=""><span class="brand">p2gift</span><span class="kind">Example</span></header>
<main>
${bodyHtml}
</main>
<footer>Agents read this same example as Markdown via the p2gift MCP resource <code>p2gift://examples/${escapeHtml(slug)}</code> — or fetch it here: <a href="/example/${escapeHtml(slug)}?format=md">?format=md</a>.</footer>
</div>
</body>
</html>`;
}

export async function renderExample(
  slug: string,
  url: URL,
  request: Request,
): Promise<Response> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return new Response('Not found', { status: 404 });
  }
  const obj = await env.BUCKET.get(`examples/${slug}.md`);
  if (!obj) return new Response('Not found', { status: 404 });
  const md = await obj.text();

  const wantsMd =
    url.searchParams.get('format') === 'md' ||
    (request.headers.get('accept') ?? '').includes('text/markdown');
  if (wantsMd) {
    return new Response(md, {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'cache-control': 'public, max-age=300',
      },
    });
  }

  const title = md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? `Example — ${slug}`;
  // Point the Markdown's repo-relative asset links at the /images route,
  // which serves the same bucket keys.
  const bodyHtml = renderMarkdown(
    md
      .replaceAll('](examples/assets/', '](/images/examples/assets/')
      .replaceAll('](./assets/', '](/images/examples/assets/'),
  );
  return new Response(pageHtml(title, slug, bodyHtml), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}
