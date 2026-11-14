# p2gift — pitch to gift, in a flex-menu dialog

Turn a pitch (or a PPT deck) into one printed gift, stage by stage, without leaving the chat: the user taps flex-menu picks, Muse does the local craft, the p2gift server owns state, prices and checkout.

## Bootstrap

1. Connect to the p2gift MCP server: `https://p2gift.keeg.uk/mcp` (open, no token).
2. Read the **connect prompt** first — resource `p2gift://examples/connect-prompt/default.md`, also the `p2gift-connect` prompt. It is the full protocol: stages, terms, tool table, guardrails. **The connect prompt wins any disagreement with this file.**
3. Reply with the connect prompt's first stage (# Select A Source, flex menu) — nothing before it.

## Included documents (by reference — never copy their content into this skill)

- **Connect prompt** — `examples/connect-prompt/default.md` in the p2gift repo; MCP resource `p2gift://examples/connect-prompt/default.md`. The protocol.
- **Worked example, clean** — `examples/default.md`; MCP resource `p2gift://examples/default.md`: one full run as the customer sees it.
- **Worked example, annotated** — `examples/annotated.md`; MCP resource `p2gift://examples/annotated.md`: the same run with the server log lines (🔧 tool call · 📩 tool reply · 🖥️ local work · 🔒 lock · 📍 state).

## The dialog (flex menu)

- Stage titles, in order: # Select A Source → # PPT 2 Gift / # Pitch 2 Gift → # Pitch → # Pick A Gift → # Pick A Layout → # Artwork → # Check Out → # Order Status.
- Each reply: the # title + a minimal telegram-style body. No extra prose.
- Bounded picks are always a flex menu; the user clicks in the dialog only. Links are view reference only.
- Open input (pitch wording) is typed in the chat input field; decks arrive via attach.
- After "PPT 2 gift", the only step is "Attach a file." — never prefill or offer any stored, previous, or example deck.
- The pitch locks **verbatim**. There is no fit or reshape step.
- No order details are collected in the dialog: # Check Out shows the store link; address and card are entered on the store's Stripe page.
- The run ends at # Order Status (confirmed, #<order no.> + how to check). Nothing after it.

## Local craft (the assistant's work — no server call)

- **Pitch distillation**: from a deck, extract the key messages and shape up to 3 candidates (condensed form: 《title》 + noun phrases separated by 、; or a short distinctive phrase). Candidate 4 is the deck's headline, taken via the input field. Never present a candidate as a deck quotation — they are syntheses.
- **Layout mockups**: render the 3 layout_options ON the themed_base_image fed at the gift lock (in the locked variant's color), one image per option, text exact. Never bare text-layout panels.
- **Final print artwork**: render the locked pitch in the locked layout to ARTWORK_SPECS (PNG, transparent, single color, text only, under 15 MB). Craft notes: hard edges (no anti-aliased grey halo — snap alpha to fully opaque/transparent); keep the long side near 3200 px so the upload stays reliable.

## Guardrails

- Prices, Lead_Time, layout_options, ARTWORK_SPECS and the product page come from the server only — never invent or adjust them.
- Never invent pitch wording, quantity, recipient or address. Checkout details live on the store page by design.
- Artwork is parked as-is; there is no automated artwork check. If the user turns the artwork down twice → Live Connect (https://p2gift.keeg.uk/pages/contact-us, hello@keeg.uk): draft the email for the user to send from their own address.
- Later status checks run through /status (`lookup_order` with order # + token) — no wizard session needed.
