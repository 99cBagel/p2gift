// Minimal PNG decoder for the Final Print Artwork shape check.
// Zero-dependency: chunk parsing by hand, IDAT inflated with the
// platform DecompressionStream (zlib format), scanline unfiltering
// implemented for all five PNG filters. Supports color types
// 0 (gray), 2 (RGB), 3 (palette), 4 (gray+alpha), 6 (RGBA) at bit
// depths 8 and 16, plus sub-8-bit palette/gray unpacking.
//
// The decoder does not retain the bitmap: it walks the pixels once
// and accumulates exactly what the artwork rules need — dimensions,
// alpha presence, corner transparency, the transparent-pixel ratio,
// and a quantized color histogram of the opaque pixels.

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes) {
  if (!bytes || bytes.length < 8) return false;
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

export function isJpeg(bytes) {
  return !!bytes && bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function readU32(bytes, off) {
  return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
}

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function paeth(a, b, c) {
  const p = a - b + c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export async function analyzePng(bytes) {
  if (!isPng(bytes)) throw new Error("not a PNG file");
  let off = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let idatLen = 0;
  while (off + 8 <= bytes.length) {
    const len = readU32(bytes, off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const dataStart = off + 8;
    if (type === "IHDR") {
      ihdr = {
        width: readU32(bytes, dataStart),
        height: readU32(bytes, dataStart + 4),
        bitDepth: bytes[dataStart + 8],
        colorType: bytes[dataStart + 9],
        interlace: bytes[dataStart + 12],
      };
    } else if (type === "PLTE") {
      palette = bytes.subarray(dataStart, dataStart + len);
    } else if (type === "tRNS") {
      trns = bytes.subarray(dataStart, dataStart + len);
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(dataStart, dataStart + len));
      idatLen += len;
    } else if (type === "IEND") {
      break;
    }
    off = dataStart + len + 4;
  }
  if (!ihdr) throw new Error("PNG has no IHDR chunk");
  if (ihdr.interlace !== 0) throw new Error("interlaced PNG is not supported by the artwork check");
  const { width, height, bitDepth, colorType } = ihdr;
  if (!CHANNELS[colorType]) throw new Error(`unsupported PNG color type ${colorType}`);
  if (width === 0 || height === 0 || width > 10000 || height > 10000) {
    throw new Error(`PNG dimensions ${width}x${height} are out of range`);
  }

  const idatAll = new Uint8Array(idatLen);
  let p = 0;
  for (const part of idat) { idatAll.set(part, p); p += part.length; }
  const raw = await inflate(idatAll);

  const channels = CHANNELS[colorType];
  const bytesPerPixel = Math.max(1, Math.round((channels * bitDepth) / 8));
  // Row size in bytes as stored (packed for sub-8-bit).
  const rowBits = width * channels * bitDepth;
  const rowBytes = Math.ceil(rowBits / 8);
  const expected = (rowBytes + 1) * height;
  if (raw.length < expected) throw new Error("PNG image data is truncated");

  const hasAlphaChannel = colorType === 4 || colorType === 6;
  const sampleStride = width * height > 2_000_000 ? 2 : 1;

  let sampled = 0;
  let transparent = 0;
  let opaque = 0;
  const histogram = new Map(); // quantized rgb (4 bits/channel) -> count
  const corners = { tl: null, tr: null, bl: null, br: null };

  // Extract one pixel as [r, g, b, a] (0-255 each) from a reconstructed row.
  function pixelAt(row, x) {
    if (bitDepth === 16) {
      const i = x * channels * 2;
      const v = (c) => row[i + c * 2];
      if (colorType === 6) return [v(0), v(1), v(2), v(3)];
      if (colorType === 2) return [v(0), v(1), v(2), 255];
      if (colorType === 4) return [v(0), v(0), v(0), v(1)];
      // gray 16
      let a = 255;
      if (trns && trns.length >= 2) {
        const tv = (trns[0] << 8) | trns[1];
        const gv = (row[i] << 8) | row[i + 1];
        if (gv === tv) a = 0;
      }
      return [v(0), v(0), v(0), a];
    }
    if (bitDepth === 8) {
      const i = x * channels;
      if (colorType === 6) return [row[i], row[i + 1], row[i + 2], row[i + 3]];
      if (colorType === 2) {
        let a = 255;
        if (trns && trns.length >= 6) {
          const r = (trns[0] << 8) | trns[1], g = (trns[2] << 8) | trns[3], b = (trns[4] << 8) | trns[5];
          if (row[i] === r && row[i + 1] === g && row[i + 2] === b) a = 0;
        }
        return [row[i], row[i + 1], row[i + 2], a];
      }
      if (colorType === 4) return [row[i], row[i], row[i], row[i + 1]];
      if (colorType === 3) {
        const idx = row[i];
        const pi = idx * 3;
        const a = trns && idx < trns.length ? trns[idx] : 255;
        return [palette[pi], palette[pi + 1], palette[pi + 2], a];
      }
      // gray 8
      let a = 255;
      if (trns && trns.length >= 2 && row[i] === trns[1]) a = 0;
      return [row[i], row[i], row[i], a];
    }
    // Sub-8-bit: only palette (3) and gray (0) are defined.
    const perByte = 8 / bitDepth;
    const idxInByte = x % perByte;
    const byte = row[Math.floor(x / perByte)];
    const shift = 8 - bitDepth * (idxInByte + 1);
    const val = (byte >> shift) & ((1 << bitDepth) - 1);
    if (colorType === 3) {
      const pi = val * 3;
      const a = trns && val < trns.length ? trns[val] : 255;
      return [palette[pi], palette[pi + 1], palette[pi + 2], a];
    }
    const max = (1 << bitDepth) - 1;
    const gray = Math.round((val / max) * 255);
    let a = 255;
    if (trns && trns.length >= 2 && val === trns[1]) a = 0;
    return [gray, gray, gray, a];
  }

  let prevRow = new Uint8Array(rowBytes);
  let srcOff = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[srcOff++];
    const row = new Uint8Array(rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const v = raw[srcOff + i];
      const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
      const up = prevRow[i];
      const upLeft = i >= bytesPerPixel ? prevRow[i - bytesPerPixel] : 0;
      let out;
      switch (filter) {
        case 0: out = v; break;
        case 1: out = (v + left) & 0xff; break;
        case 2: out = (v + up) & 0xff; break;
        case 3: out = (v + Math.floor((left + up) / 2)) & 0xff; break;
        case 4: out = (v + paeth(left, up, upLeft)) & 0xff; break;
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
      row[i] = out;
    }
    srcOff += rowBytes;

    const isFirst = y === 0, isLast = y === height - 1;
    if (isFirst || isLast) {
      const tl = pixelAt(row, 0), tr = pixelAt(row, width - 1);
      if (isFirst) { corners.tl = tl[3]; corners.tr = tr[3]; }
      if (isLast) { corners.bl = tl[3]; corners.br = tr[3]; }
    }
    for (let x = 0; x < width; x += sampleStride) {
      const [r, g, b, a] = pixelAt(row, x);
      sampled++;
      if (a <= 15) { transparent++; continue; }
      if (a >= 128) {
        opaque++;
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        histogram.set(key, (histogram.get(key) || 0) + 1);
      }
    }
    prevRow = row;
  }

  let dominant = null;
  for (const [key, count] of histogram) {
    if (!dominant || count > dominant.count) dominant = { key, count };
  }
  const dominantHex = dominant
    ? "#" + [((dominant.key >> 8) & 15) * 17, ((dominant.key >> 4) & 15) * 17, (dominant.key & 15) * 17]
        .map((n) => n.toString(16).padStart(2, "0")).join("")
    : null;

  return {
    width,
    height,
    colorType,
    bitDepth,
    hasAlpha: hasAlphaChannel || !!trns,
    corners,
    sampledPixels: sampled,
    transparentRatio: sampled ? transparent / sampled : 0,
    opaquePixels: opaque,
    dominantColor: dominantHex,
    dominantShare: dominant && opaque ? dominant.count / opaque : 0,
    distinctStrongColors: histogram.size,
  };
}
