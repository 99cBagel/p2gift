import { describe, it, expect } from 'vitest';
import {
  validateItemFileUpload,
  uploadMime,
  itemFileKey,
  formatFileSize,
  MAX_ITEM_FILE_BYTES,
} from './itemFiles';

describe('validateItemFileUpload', () => {
  it('accepts a PNG artwork under the cap', () => {
    expect(
      validateItemFileUpload({ kind: 'artwork', fileName: 'a.png', mime: 'image/png', sizeBytes: 1234 }),
    ).toEqual({ ok: true, kind: 'artwork' });
  });

  it('rejects a non-PNG artwork (the print file is PNG by rule)', () => {
    const r = validateItemFileUpload({
      kind: 'artwork',
      fileName: 'a.jpg',
      mime: 'image/jpeg',
      sizeBytes: 1234,
    });
    expect(r.ok).toBe(false);
  });

  it('accepts a PDF proof but not an executable-shaped other', () => {
    expect(
      validateItemFileUpload({ kind: 'proof', fileName: 'p.pdf', mime: 'application/pdf', sizeBytes: 10 }).ok,
    ).toBe(true);
    expect(
      validateItemFileUpload({ kind: 'other', fileName: 'x.zip', mime: 'application/zip', sizeBytes: 10 }).ok,
    ).toBe(false);
  });

  it('rejects empty and oversized files and unknown kinds', () => {
    expect(
      validateItemFileUpload({ kind: 'artwork', fileName: 'a.png', mime: 'image/png', sizeBytes: 0 }).ok,
    ).toBe(false);
    expect(
      validateItemFileUpload({
        kind: 'artwork',
        fileName: 'a.png',
        mime: 'image/png',
        sizeBytes: MAX_ITEM_FILE_BYTES + 1,
      }).ok,
    ).toBe(false);
    expect(
      validateItemFileUpload({ kind: 'video', fileName: 'a.png', mime: 'image/png', sizeBytes: 10 }).ok,
    ).toBe(false);
  });
});

describe('uploadMime', () => {
  it('trusts the browser mime, falls back to the extension', () => {
    expect(uploadMime('a.png', 'image/png')).toBe('image/png');
    expect(uploadMime('a.png', '')).toBe('image/png');
    expect(uploadMime('a.pdf', 'application/octet-stream')).toBe('application/pdf');
    expect(uploadMime('a.bin', '')).toBe(null);
  });
});

describe('itemFileKey', () => {
  it('scopes the key by item and file id and sanitizes the name', () => {
    expect(itemFileKey('itm_abc', 'file_xyz', 'My Art (final).PNG')).toBe(
      'order-files/itm_abc/file_xyz-My-Art-final-.PNG',
    );
    expect(itemFileKey('itm_abc', 'file_xyz', '../evil.png')).toBe(
      'order-files/itm_abc/file_xyz-evil.png',
    );
  });
});

describe('formatFileSize', () => {
  it('formats bytes, KB, and MB', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(47946)).toBe('47 KB');
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(formatFileSize(null)).toBe('—');
  });
});
