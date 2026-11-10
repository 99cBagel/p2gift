// p2gift order workflow — enforced state machine.
// Steps are taken from the Connect example (Muse Chat Log — Example2).
// The example is one case only; no case pitch, gift item, or price is
// wired into this service — every order supplies its own pitch.
// No step can be skipped, and no step advances without an explicit
// user confirmation. The Worker is stateless: the session object is
// returned to the assistant, which presents it back on the next call.
// The Worker validates the step order on every call and rejects
// out-of-order calls instead of guessing.
//
// Steps:
//   1 pitch      — propose the pitch, user confirms it as-is
//   2 gift       — three concepts from that pitch, user picks 1/2/3
//   3 mockup     — mockup, fix text errors, layout, 3 layout
//                  examples, user picks A/B/C, confirms proceed
//   4 artwork    — record the chosen prototype, prepare print-ready
//                  artwork, user reviews and approves it
//   5 checkout   — quantity + recipient/address + price, draft the
//                  order for confirmation. No price is ever invented.
//                  Checkout itself is the minshop module (see README).

export const STEPS = ["pitch", "gift", "mockup", "artwork", "checkout"];

export function startOrder({ pitchProposal, customer }) {
  return {
    session_id: `p2g-${Date.now().toString(36)}`,
    step: "pitch",
    // Who placed the order: the signed-in user from the OAuth token
    // ({ userId, email, name, provider }). Travels with the session so the
    // checkout draft and the store order carry that identity.
    customer: customer ?? null,
    pitch_proposal: pitchProposal ?? null,
    pitch: null,
    concepts: [],
    gift_item: null,
    layout: null,
    mockup_approved: false,
    artwork_approved: false,
    record: [],
  };
}

export function nextStep(session) {
  const idx = STEPS.indexOf(session.step);
  return {
    step: session.step,
    step_number: idx + 1,
    total_steps: STEPS.length,
    needs: {
      pitch: "User confirms the pitch, as-is, or as the title to build from.",
      gift: "User picks one of the suggested gift items.",
      mockup: "User approves the mockup and picks a layout: A, B, or C.",
      artwork: "User reviews the Final Print Artwork and approves it.",
      checkout: "Quantity, recipient name + delivery address, and a price to confirm.",
    }[session.step],
  };
}

// confirmStep advances exactly one step, and only with the data
// that step requires. Anything else is rejected with an error
// naming the step that must be completed first.
export function confirmStep(session, { step, data = {} }) {
  if (step !== session.step) {
    return { error: `Complete step "${session.step}" first. Cannot confirm "${step}" yet.` };
  }
  const next = { ...session, record: [...session.record, { step, data }] };
  switch (step) {
    case "pitch":
      if (!data.pitch) return { error: "pitch step needs data.pitch, the confirmed pitch text." };
      next.pitch = data.pitch;
      next.step = "gift";
      break;
    case "gift":
      if (!data.gift_item) return { error: "gift step needs data.gift_item, the chosen gift item id." };
      next.gift_item = data.gift_item;
      next.concepts = data.concepts ?? next.concepts;
      next.step = "mockup";
      break;
    case "mockup":
      if (!data.layout) return { error: "mockup step needs data.layout, A, B, or C." };
      next.layout = data.layout;
      next.mockup_approved = true;
      next.step = "artwork";
      break;
    case "artwork":
      if (data.approved !== true) return { error: "artwork step needs data.approved === true." };
      next.artwork_approved = true;
      next.step = "checkout";
      break;
    case "checkout":
      if (!data.quantity || !data.recipient || !data.price) {
        return { error: "checkout step needs data.quantity, data.recipient (name + address), and data.price — none may be invented." };
      }
      next.checkout_draft = data;
      next.step = "done";
      break;
    default:
      return { error: `Unknown step: ${step}` };
  }
  return { session: next, next_step: next.step === "done" ? null : nextStep(next) };
}
