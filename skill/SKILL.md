# PPT-to-Gift orders with p2gift

A bootstrap and a local-craft companion for the p2gift lock-stage
wizard. This skill is **not** the flow: the connect prompt is.

## Connect, then defer to the connect prompt

- Connect through the p2gift connector at `~/workspace/custom-connectors/custom.p2gift/CONNECTOR.md`. No sign-in or key is needed to connect.

## Included documents — by reference, read on the service

These two ship with the service and version with it. They are
included here by reference, never copied into this skill — a copy
would drift.

1. **Connect prompt** — `examples/connect-prompt/default.md`,
   resource `p2gift://examples/connect-prompt/default.md`.
   Read it first, before the first order step. It is the single
   authority for the wizard: the stages, the tools, the locks,
   the checkout rule (OAuth sign-in inside checkout only), and
   Stages 8–9 (Confirmation, Order Lookup). If this skill and
   the connect prompt ever disagree, the connect prompt wins.
2. **Worked example** — `examples/default.md`,
   resource `p2gift://examples/default.md`.
   Read it when the user wants to see how a run goes. Its log is
   the shape of a good run — 🔧 your tool calls, 📩 the server's
   replies, 🖥️ your local work, 🔒 locks, 📍 session state.

## Your local work (🖥️) — what the server cannot do for you

The wizard locks state on the server, but three jobs are yours,
done locally. Craft notes for each:

### Extract the pitch

- From a deck, distill: its title, its closing ask, and its one memorable claim.
- Draft the pitch options for the user to pick or edit. What the user settles becomes the `pitch_text` submitted for locking — and the locked text prints exactly, character for character, so wording is settled at the pitch stage, not later.

### Render the layout mockups

- Render the three Print Layout Designs (A, B, C) locally, from the **locked** `pitch_text` only.
- Only the arrangement changes between them — never the words, never the punctuation.

### Render the Final Print Artwork

- Render locally, to the `ARTWORK_SPECS` the server issued at the layout lock, and the picked `gift_item`'s catalog treatment and print area.
- File rules: PNG only, transparent background, a single color, no logo, one file, under 15 MB.
- Render with hard edges. Anti-aliased or blurred edges print as a grey halo and wash out the single color — snap every pixel to fully opaque ink or fully transparent. No automated check runs on the file; clean edges are a print-quality matter, and yours to get right.
- Keep the artwork near 3200 px on its long side — far beyond print resolution for these items, and very large files (around 25 megapixels) risk failing the upload itself.
- The user's approval carries the visual check. No AI gate runs on the artwork.

## Guardrails

- Never invent: `pitch_text`, quantity, recipient, price. If it isn't locked, in a 📩, or straight from the user, you don't have it.
- If the user turns down the artwork twice, stop guessing. Draft a Live Connect email to hello@keeg.uk for the user to send from their own mailbox — session reference, `gift_item`, the block, and the question.
- The run does not end at the checkout link: it ends with the store's confirmation (connect prompt, Stage 8). Later status checks use the `p2gift-order-lookup` skill, not a new wizard run.

## Available connectors

- [p2gift](~/workspace/custom-connectors/custom.p2gift/CONNECTOR.md) for the MCP client commands, the operation list, and recovery.
