// Gift item pool — the FALLBACK pool, the original 6 items. Used only
// when the live R2 inventory (examples/inventory/inventory.json) is
// missing or empty; at run time the picks come from R2, never from
// this list directly. No prices here: pricing is confirmed per order,
// never invented.
export const GIFT_POOL = [
  { id: "tote-bag", name: "Tote Bag", surface: "full", note: "Printed pitch or presentation-inspired artwork on a reusable tote." },
  { id: "leather-notebook-set", name: "Leather Notebook Set", surface: "full", note: "Embossed or printed Pitch Text on a leather notebook set." },
  { id: "stainless-cups-5pack-12oz", name: "5-Pack Stainless Cups (12 oz)", surface: "short", note: "Food-grade 304 stainless steel, poly-coated finish, engraved pitch." },
  { id: "stainless-tumbler-20oz", name: "Stainless Tumbler (20 oz)", surface: "condensed", note: "Engraved or printed pitch on a wrap surface, best for a condensed pitch." },
  { id: "custom-pint-glass-16oz", name: "Custom Pint Glass (16 oz)", surface: "full", note: "Printed full-colour wraparound pitch around the glass." },
  { id: "walnut-peanut-plate", name: "Walnut Peanut Plate", surface: "short", note: "Engraved short phrase, name, or monogram on walnut wood; best for a short pitch message." },
];

// Dual-Criteria Pick Rule (p2gift-wiki): recipient profile first
// (only with permission), otherwise topic category. Surface check
// always applies: the object must bear the pitch text.
// `pool` is the available inventory, loaded from R2 — never the
// hardcoded pool directly. Up to three picks, in pool order.
export function suggestGifts({ pitch, recipientProfile = null, topicCategory = null, pool = GIFT_POOL }) {
  const basis = recipientProfile ? "profile" : "topic";
  const full = pool.filter((k) => k.surface === "full");
  const condensed = pool.filter((k) => k.surface === "condensed");
  const short = pool.filter((k) => k.surface === "short");
  // Preserve the original variety: first two full-surface items,
  // then the first condensed item. Fill any missing slot from the
  // pool in order (e.g. if fewer than 2 full items are available).
  const picked = [];
  for (const k of [full[0], full[1], condensed[0], ...pool, ...short]) {
    if (picked.length >= 3) break;
    if (k && !picked.includes(k)) picked.push(k);
  }
  return {
    pitch,
    selection_basis: basis,
    recipient_profile: recipientProfile,
    topic_category: topicCategory,
    concepts: picked.map((k, i) => ({
      rank: i + 1,
      gift_item: k,
      pitch_text: pitch,
      fit: k.surface === "full" ? "Full pitch fits." : k.surface === "condensed" ? "Condensed pitch only — surface fits a shortened pitch." : "Short phrase only — surface fits a short pitch message.",
    })),
  };
}
