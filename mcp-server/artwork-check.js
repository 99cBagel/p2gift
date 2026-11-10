// The 2-layer Final Print Artwork shape check, used by prepare_checkout.
//
// Layer 1 (this file, deterministic): the universal file rules —
//   exactly one file (the submission itself), PNG only, under 15 MB,
//   transparent background, single color only.
// Layer 2 (below, product-aware): the gift item's own rules from the
//   inventory (treatment, print area, special notes) plus a Workers AI
//   negative check of the image content — text as printed vs the
//   confirmed Pitch Text, the picked layout, no logo, nothing outside
//   the product's printable area. AI does the seeing; the verdict and
//   its reasons are returned to the agent verbatim for resubmission.

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

const AI_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

export function artworkRulesText(item) {
  const r = item?.artwork_rules || {};
  const lines = [
    `Gift item: ${item?.name || item?.id || "unknown"}`,
    `Treatment: ${r.treatment || item?.treatment || "not specified"}`,
    `Surface: ${r.surface || item?.surface || "not specified"}`,
    `Print area: ${r.print_area || "not specified by the seller"}`,
  ];
  for (const note of r.notes || []) lines.push(`Note: ${note}`);
  return lines.join("\n");
}

export async function checkArtworkL2(env, { base64, pitchText, layout, item }) {
  if (!env?.AI) {
    return { unavailable: true, reason: "The AI check is not configured on this Worker (no AI binding)." };
  }
  const prompt = [
    "You are the artwork checker for a print-on-gift service. Examine the submitted Final Print Artwork image and report ONLY problems, from this checklist:",
    "1. The image must print exactly this Pitch Text, character for character, with no added or missing words or punctuation:",
    `   "${pitchText}"`,
    `2. The arrangement must match Print Layout Design ${layout || "?"} (A = centered lines, B = small top line, rule, then large name lines, C = two lines keeping the em dash).`,
    "3. There must be no logo, brand mark, icon, or any graphic element — text only.",
    "4. The design must respect the gift item's rules:",
    artworkRulesText(item),
    "5. Nothing in the design may look like it would fall outside the item's print area.",
    "",
    'Answer with strict JSON only: {"transcription": "<the exact text you read in the image>", "problems": ["<problem>", ...], "verdict": "pass" or "fail"}.',
    'If there are no problems, problems is [] and verdict is "pass".',
  ].join("\n");

  let raw;
  try {
    const out = await env.AI.run(AI_MODEL, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
          ],
        },
      ],
    });
    raw = typeof out?.response === "string" ? out.response : JSON.stringify(out?.response ?? out ?? "");
  } catch (err) {
    return { unavailable: true, reason: `The AI check could not run: ${err.message}` };
  }
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { unavailable: true, reason: "The AI check returned an unreadable answer." };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { unavailable: true, reason: "The AI check returned an unreadable answer." };
  }
  const problems = Array.isArray(parsed.problems) ? parsed.problems.map(String).filter(Boolean) : [];
  const fail = parsed.verdict === "fail" || problems.length > 0;
  return {
    pass: !fail,
    reasons: problems.map((p) => `AI check: ${p}`),
    transcription: typeof parsed.transcription === "string" ? parsed.transcription : null,
  };
}
