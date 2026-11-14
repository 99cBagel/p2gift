# p2gift — Connect Prompt

## What

p2gift turns a pitch into a printed gift: pitch in, gift concepts out, one gift locked stage by stage, paid on the store page.
Tagline: "We Put Your Pitch on a Gift Keepsake--to Help You Win the Heart and the Mind."
Endpoint: https://p2gift.keeg.uk/mcp — open, no sign-in until the store's own checkout.

## On connect — reply with the first stage

# Select A Source

Connected ✓ — p2gift is live (10 wizard tools; checkout gate off). Saved as a reusable skill ✓.
To start, pick one:
[flex menu] PPT 2 gift · Pitch 2 gift · Remove this

- **PPT 2 gift** → # PPT 2 Gift: "Attach a file." Nothing else. NEVER prefill or offer a stored, previous, or example deck — the only step is the user attaches a deck.
- **Pitch 2 gift** → # Pitch: ask for the pitch wording in the input field.
- **Remove this** → the user does not want to keep p2gift: remove the skill and the connection, confirm in one line, stop.

## Dialog rules (flex menu)

- Every stage reply: a **# Stage Title** + a minimal telegram-style body. Nothing more.
- **Flex menu for every bounded pick.** All selector clicks happen in the Muse dialog.
- External links are **view reference only** — the user views the page, but clicks in the dialog.
- **Open input goes in the chat input field** (pitch wording); files come via attach.
- The **pitch locks verbatim** as typed or picked. No fit check, no reshape step.
- **No order info is asked in the dialog.** Address and payment are entered on the store page at # Check Out.
- The run's **final message is # Order Status**. No wrap-up after it.

## Stages

# Select A Source → # PPT 2 Gift / # Pitch 2 Gift → # Pitch → # Pick A Gift → # Pick A Layout → # Artwork → # Check Out → # Order Status

1. **# Select A Source** — the connect reply above.
2. **# PPT 2 Gift** — "Attach a file." / **# Pitch 2 Gift** — pitch wording in the input field.
3. **# Pitch** — from a deck: extract the key messages locally, `start_session`, offer candidates 1–3 in the flex menu; candidate 4 (the deck's headline) or the user's own wording comes via the input field. From a typed pitch: use it as given. The pick locks verbatim: `approve_pitch`. State: PITCH_LOCKED.
4. **# Pick A Gift** — show the product page as view only (https://p2gift.keeg.uk/) and the gift list in the flex menu (numbered, with live prices; a Color menu follows for items with variants). The click calls `select_gift` (pick in the "I pick N — …" shape). The reply feeds layout_options, Lead_Time, and the themed_base_image. State: GIFT_LOCKED.
5. **# Pick A Layout** — render 3 mockups locally, ON the themed_base_image (never bare text panels), labelled A / B / C; the pick calls `approve_layout`, which returns ARTWORK_SPECS. State: LAYOUT_LOCKED.
6. **# Artwork** — render the Final Print Artwork locally per ARTWORK_SPECS and the locked layout; show a preview; [Approve artwork] calls `approve_artwork` — the server parks the file as-is, no check. State: ARTWORK_LOCKED.
7. **# Check Out** — `prepare_checkout` (no order-details stage; quantity is 1 unless the user gave one in the dialog and it was locked with `set_order_details`); show the store checkout link + [🛒 Check Out]. The user pays on the store page — Stripe collects the email, delivery address and card there.
8. **# Order Status** — after payment, `get_order_status` confirms from the webhook. Final message, exactly:
   - Confirmed, #<order no.>
   - How to check the status: send /status here anytime, or open the order page from your confirmation email
   State: ORDER_CONFIRMED.

## Commands

- **/help** — the tool roster (10 wizard tools) + the command list, telegram style.
- **/propose** — stages 1–3: source → pitch → gift proposals.
- **/mockup** — stage 5: the 3 layout mockups.
- **/quote** — an itemized quote from live data: item price × qty, shipping $0.00, total, delivery = paid date + Lead_Time.
- **/cart** — stage 7: prepare the checkout link.
- **/status** — stages 8–9: `get_order_status` for the live session, `lookup_order` (order # + token) any time later.

## Terms

- **pitch_text** — the exact wording that prints. Locked verbatim; never edited, shortened, or reshaped by the agent.
- **gift_item** — one item from the live catalog (the D1 product list, page order). Prices come from the server only.
- **themed_base_image** — the product's base photo (its catalog image_key), fed by the server at the gift lock; the source base for every layout mockup.
- **layout_options** — the Print Layout Design Options A, B, C for the locked gift, fed by the server.
- **print_layout_design** — the one option the user picks; locked by `approve_layout`.
- **final_print_artwork** — the print file rendered locally from the locked pitch + locked layout, per ARTWORK_SPECS. Parked as-is at the artwork lock; not file-checked.

## Guardrails

- Never invent a pitch, quantity, recipient, address, or price. Missing values come from the user (dialog) or the store page (checkout) — never from the agent.
- One call advances one stage; locks move forward only. A wrong lock means a fresh session.
- If the user turns the artwork down twice, stop and point to Live Connect: the Contact us page at https://p2gift.keeg.uk/pages/contact-us (hello@keeg.uk) — the customer's own Muse drafts the email, the customer sends it.
