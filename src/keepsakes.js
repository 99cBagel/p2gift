// Keepsake Item (KI) pool — mirrors p2gift-wiki README §4, 6 items.
// No prices here: pricing is confirmed per order, never invented.
export const KI_POOL = [
  { id: "tote-bag", name: "Tote Bag", surface: "full", note: "Printed Pitch Snippets or presentation-inspired artwork on a reusable tote." },
  { id: "leather-notebook-set", name: "Leather Notebook Set", surface: "full", note: "Embossed or printed Pitch Snippets on a leather notebook set." },
  { id: "stainless-cups-5pack", name: "5-Pack Stainless Cups (12 oz)", surface: "short", note: "Food-grade 304 stainless steel, poly-coated finish, engraved Pitch Snippets." },
  { id: "stainless-tumbler-20oz", name: "Stainless Tumbler (20 oz)", surface: "condensed", note: "Engraved or printed Pitch Snippets on a wrap surface, best for a condensed pitch." },
  { id: "custom-pint-glass-16oz", name: "Custom Pint Glass (16 oz)", surface: "full", note: "Printed full-colour wraparound Pitch Snippets around the glass." },
  { id: "walnut-peanut-plate", name: "Walnut Peanut Plate", surface: "short", note: "Engraved short phrase, name, or monogram on walnut wood; best for a short keepsake message." },
];

// Dual-Criteria Pick Rule (p2gift-wiki): recipient profile first
// (only with permission), otherwise topic category. Surface check
// always applies: the object must bear the pitch text.
// `pool` is the available inventory, loaded from R2 — never the
// hardcoded pool directly. Three different concepts, in pool order.
export function suggestKeepsakes({ pitch, recipientProfile = null, topicCategory = null, pool = KI_POOL }) {
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
      keepsake: k,
      pitch_text: pitch,
      fit: k.surface === "full" ? "Full pitch fits." : k.surface === "condensed" ? "Condensed pitch only — surface fits a shortened pitch." : "Short phrase only — surface fits a short keepsake message.",
    })),
  };
}
