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
export function suggestKeepsakes({ pitch, recipientProfile = null, topicCategory = null }) {
  const basis = recipientProfile ? "profile" : "topic";
  const full = KI_POOL.filter((k) => k.surface === "full");
  const condensed = KI_POOL.filter((k) => k.surface === "condensed");
  // Three different concepts from the same pitch, in pool order.
  // No recipient profile was supplied, so this is a topic pick.
  return {
    pitch,
    selection_basis: basis,
    recipient_profile: recipientProfile,
    topic_category: topicCategory,
    concepts: [
      { rank: 1, keepsake: full[0], pitch_text: pitch, fit: "Full pitch fits." },
      { rank: 2, keepsake: full[1], pitch_text: pitch, fit: "Full pitch fits." },
      { rank: 3, keepsake: condensed[0], pitch_text: pitch, fit: "Condensed pitch only — tumbler surface fits a shortened pitch." },
    ],
  };
}
