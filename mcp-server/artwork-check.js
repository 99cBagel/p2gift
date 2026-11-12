// The Final Print Artwork shape check, used by prepare_checkout.
//
// Deterministic file rules: exactly one file (the submission itself),
// PNG only, under 15 MB, transparent background, single color only.
// The visual side (text as printed vs the confirmed Pitch Text, the
// picked layout, no logo, the item's print area) is covered by the
// user's own artwork approval at workflow step 4. A Workers AI visual
// layer used to run here as well; it failed closed whenever the model
// answered unreadably and blocked good orders, so the owner removed
// it (2026-11-12).

import { isPng, isJpeg, analyzePng } from "./png.js";

export const MAX_ARTWORK_BYTES = 15 * 1024 * 1024; // "under 15 MB"

export async function checkArtworkL1(bytes) {
  const reasons = [];
  const facts = { size_bytes: bytes?.length ?? 0 };
  if (!bytes || bytes.length === 0) {
    return { pass: false, reasons: ["No artwork file was submitted."], facts };
  }
  if (bytes.length >= MAX_ARTWORK_BYTES) {
    reasons.push(
      `The file is ${(bytes.length / 1048576).toFixed(1)} MB — the limit is under 15 MB.`,
    );
    return { pass: false, reasons, facts };
  }
  if (!isPng(bytes)) {
    reasons.push(
      isJpeg(bytes)
        ? "The file is a JPEG — the Final Print Artwork must be a PNG (JPEG carries no transparency)."
        : "The file is not a PNG — the Final Print Artwork must be a PNG.",
    );
    return { pass: false, reasons, facts };
  }
  let info;
  try {
    info = await analyzePng(bytes);
  } catch (err) {
    return { pass: false, reasons: [`The PNG could not be read: ${err.message}`], facts };
  }
  facts.width = info.width;
  facts.height = info.height;
  facts.ink_color = info.dominantColor;
  facts.transparent_ratio = Number(info.transparentRatio.toFixed(3));

  if (!info.hasAlpha) {
    reasons.push("The PNG has no transparency at all — the background must be transparent.");
  } else {
    const cornerMax = Math.max(info.corners.tl ?? 255, info.corners.tr ?? 255, info.corners.bl ?? 255, info.corners.br ?? 255);
    if (cornerMax > 15) {
      reasons.push("The background is not transparent — the image corners are opaque (a filled background).");
    } else if (info.transparentRatio < 0.5) {
      reasons.push(
        `Only ${(info.transparentRatio * 100).toFixed(0)}% of the artwork is transparent — the design should sit on a mostly transparent background.`,
      );
    }
  }
  if (info.opaquePixels === 0) {
    reasons.push("The artwork contains no visible design — every pixel is transparent.");
  } else if (info.dominantShare < 0.97) {
    reasons.push(
      `The artwork is not single-color: the main color ${info.dominantColor} covers only ${(info.dominantShare * 100).toFixed(0)}% of the design. Use one ink color on transparency.`,
    );
  }
  return { pass: reasons.length === 0, reasons, facts };
}
