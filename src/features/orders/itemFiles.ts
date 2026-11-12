import type { D1Database } from '@cloudflare/workers-types';
import { generatePublicId } from '../ids/publicId';

/**
 * The files parked on an order item (migration 0043): the Final Print
 * Artwork the agent submitted at checkout, plus anything the operator
 * adds later — a corrected artwork, a maker proof. One row per file in
 * `order_item_files`; the objects themselves live in the private FILES
 * bucket and this module only moves pointers.
 *
 * Exactly one file per item is `is_current` — the print file. Setting a
 * file current also mirrors it onto order_items.file_* in the same
 * batch, because that inline copy is what existing readers use (the
 * customer download route above all). The list is the history; the
 * inline copy is the headline.
 */

export const FILE_KINDS = ['artwork', 'proof', 'other'] as const;
export type ItemFileKind = (typeof FILE_KINDS)[number];

/** Same cap the artwork rules have always used for a print file. */
export const MAX_ITEM_FILE_BYTES = 15 * 1024 * 1024;

export interface OrderItemFile {
  id: number;
  public_id: string | null;
  order_item_id: number;
  file_key: string;
  file_name: string | null;
  file_mime: string | null;
  file_size_bytes: number | null;
  kind: string;
  is_current: number;
  downloads: number;
  uploaded_by: string | null;
  created_at: string;
}

export interface OrderItemFileWithItem extends OrderItemFile {
  order_item_public_id: string | null;
  item_name: string;
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const OTHER_MIMES = new Set([...IMAGE_MIMES, 'application/pdf']);

function mimeFromName(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return null;
}

/** The mime to trust for an upload: the browser's, else the extension's. */
export function uploadMime(fileName: string, browserMime: string | null | undefined): string | null {
  const fromBrowser = (browserMime ?? '').trim().toLowerCase();
  if (fromBrowser && fromBrowser !== 'application/octet-stream') return fromBrowser;
  return mimeFromName(fileName);
}

/**
 * Gate an operator upload. The print file is a PNG by the artwork rules,
 * so `artwork` accepts PNG only; proofs and other attachments may also
 * be JPEG/WebP/PDF. Pure — unit-tested.
 */
export function validateItemFileUpload(input: {
  kind: string;
  fileName: string;
  mime: string | null;
  sizeBytes: number;
}): { ok: true; kind: ItemFileKind } | { ok: false; error: string } {
  const kind = (FILE_KINDS as readonly string[]).includes(input.kind)
    ? (input.kind as ItemFileKind)
    : null;
  if (!kind) return { ok: false, error: 'Choose a file kind: artwork, proof, or other.' };
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
    return { ok: false, error: 'That file is empty.' };
  }
  if (input.sizeBytes > MAX_ITEM_FILE_BYTES) {
    return { ok: false, error: 'That file is over the 15 MB limit.' };
  }
  if (!input.mime) return { ok: false, error: 'That file type is not supported.' };
  if (kind === 'artwork' && input.mime !== 'image/png') {
    return { ok: false, error: 'The print artwork must be a PNG file.' };
  }
  if (kind !== 'artwork' && !OTHER_MIMES.has(input.mime)) {
    return { ok: false, error: 'Files must be PNG, JPEG, WebP, or PDF.' };
  }
  return { ok: true, kind };
}

/** Storage key for an operator-parked file (FILES bucket, never public). */
export function itemFileKey(itemPublicId: string, filePublicId: string, fileName: string): string {
  const safe =
    (fileName || 'file')
      .split(/[\\/]/)
      .pop()!
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(-60) || 'file';
  return `order-files/${itemPublicId}/${filePublicId}-${safe}`;
}

/** Human size for the admin list: "47 KB", "1.2 MB". */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Every parked file for an order, grouped-ready (item order, current first). */
export async function listFilesForOrder(
  db: D1Database,
  orderId: number,
): Promise<OrderItemFileWithItem[]> {
  const { results } = await db
    .prepare(
      `SELECT f.*, oi.public_id AS order_item_public_id, oi.name AS item_name
         FROM order_item_files f
         JOIN order_items oi ON oi.id = f.order_item_id
        WHERE oi.order_id = ?
        ORDER BY oi.id, f.is_current DESC, f.id`,
    )
    .bind(orderId)
    .all<OrderItemFileWithItem>();
  return results ?? [];
}

/** One parked file, scoped to its order — other orders' files never resolve. */
export async function getItemFile(
  db: D1Database,
  orderId: number,
  filePublicId: string,
): Promise<OrderItemFile | null> {
  return db
    .prepare(
      `SELECT f.* FROM order_item_files f
         JOIN order_items oi ON oi.id = f.order_item_id
        WHERE oi.order_id = ? AND f.public_id = ?`,
    )
    .bind(orderId, filePublicId)
    .first<OrderItemFile>();
}

/** True when the item already has a current print file. */
export async function itemHasCurrentFile(db: D1Database, orderItemId: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM order_item_files WHERE order_item_id = ? AND is_current = 1 LIMIT 1')
    .bind(orderItemId)
    .first<{ id: number }>();
  return row != null;
}

/**
 * Park a new file on an item. With `makeCurrent`, the same batch clears
 * the item's previous current flag and mirrors the new file onto
 * order_items.file_* — the three writes land together or not at all.
 */
export async function addItemFile(
  db: D1Database,
  input: {
    orderItemId: number;
    fileKey: string;
    fileName: string;
    mime: string | null;
    sizeBytes: number;
    kind: ItemFileKind;
    uploadedBy: string;
    makeCurrent: boolean;
    /** Pre-generated when the caller already embedded it in the storage key. */
    publicId?: string;
  },
): Promise<string> {
  const publicId = input.publicId ?? generatePublicId('orderItemFile');
  const insert = db
    .prepare(
      `INSERT INTO order_item_files
         (public_id, order_item_id, file_key, file_name, file_mime, file_size_bytes, kind, is_current, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      publicId,
      input.orderItemId,
      input.fileKey,
      input.fileName,
      input.mime,
      input.sizeBytes,
      input.kind,
      input.makeCurrent ? 1 : 0,
      input.uploadedBy,
    );
  if (!input.makeCurrent) {
    await insert.run();
    return publicId;
  }
  await db.batch([
    db
      .prepare('UPDATE order_item_files SET is_current = 0 WHERE order_item_id = ?')
      .bind(input.orderItemId),
    insert,
    db
      .prepare(
        `UPDATE order_items SET file_key = ?, file_name = ?, file_mime = ?, file_size_bytes = ?
          WHERE id = ?`,
      )
      .bind(input.fileKey, input.fileName, input.mime, input.sizeBytes, input.orderItemId),
  ]);
  return publicId;
}

/** Flag an existing file as the item's current print file (+ mirror it). */
export async function setCurrentItemFile(
  db: D1Database,
  orderItemId: number,
  fileId: number,
): Promise<void> {
  const file = await db
    .prepare('SELECT * FROM order_item_files WHERE id = ? AND order_item_id = ?')
    .bind(fileId, orderItemId)
    .first<OrderItemFile>();
  if (!file) return;
  await db.batch([
    db
      .prepare('UPDATE order_item_files SET is_current = 0 WHERE order_item_id = ?')
      .bind(orderItemId),
    db.prepare('UPDATE order_item_files SET is_current = 1 WHERE id = ?').bind(fileId),
    db
      .prepare(
        `UPDATE order_items SET file_key = ?, file_name = ?, file_mime = ?, file_size_bytes = ?
          WHERE id = ?`,
      )
      .bind(file.file_key, file.file_name, file.file_mime, file.file_size_bytes, orderItemId),
  ]);
}

/** Count a real download (previews do not call this). */
export async function incrementFileDownloads(db: D1Database, fileId: number): Promise<void> {
  await db
    .prepare('UPDATE order_item_files SET downloads = downloads + 1 WHERE id = ?')
    .bind(fileId)
    .run();
}
