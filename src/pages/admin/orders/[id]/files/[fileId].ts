import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { parseOrderOrLegacyPublicId, parsePublicId } from '../../../../../features/ids/publicId';
import { getOrderByPublicId } from '../../../../../features/orders/db';
import { getItemFile, incrementFileDownloads } from '../../../../../features/orders/itemFiles';
import { getFileStorage } from '../../../../../features/storage';

export const prerender = false;

// GET /admin/orders/:id/files/:fileId — stream one file parked on an
// order item (migration 0043) from the private FILES bucket. Behind the
// admin auth gate like every /admin route; the order+file pair must
// match, so another order's file id never resolves here. Default is an
// inline view (the order page's preview); ?download=1 saves the file
// instead and counts the download on the file's row.

const PRIVATE_HEADERS = {
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export const GET: APIRoute = async ({ params, url }) => {
  const orderPublicId = parseOrderOrLegacyPublicId(params.id, 'order');
  const filePublicId = parsePublicId(params.fileId, 'orderItemFile');
  if (!orderPublicId || !filePublicId) {
    return new Response('Not found', { status: 404, headers: PRIVATE_HEADERS });
  }
  const order = await getOrderByPublicId(env.DB, orderPublicId);
  if (!order) return new Response('Not found', { status: 404, headers: PRIVATE_HEADERS });
  const file = await getItemFile(env.DB, order.id, filePublicId);
  if (!file) return new Response('Not found', { status: 404, headers: PRIVATE_HEADERS });
  const stored = await getFileStorage().get(file.file_key);
  if (!stored) return new Response('File unavailable', { status: 404, headers: PRIVATE_HEADERS });

  const download = url.searchParams.get('download') === '1';
  if (download) await incrementFileDownloads(env.DB, file.id);
  const name = file.file_name ?? 'download';
  return new Response(stored.body, {
    headers: {
      ...PRIVATE_HEADERS,
      'content-type': file.file_mime ?? stored.contentType,
      'content-disposition': contentDisposition(download ? 'attachment' : 'inline', name),
    },
  });
};
