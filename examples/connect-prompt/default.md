# p2gift — Connect Prompt

For: the connected Agent. Read on connect, before any order.

## What

- **p2gift** = **PPT-to-Gift**: pitch in, gift out.
- In: Pitch Text, or a PPT deck.
- Out: the pitch printed on a gift item, sent to the recipient.
- Users: Muse users first (Nov 2026); other Agents later.
- The flow is a **lock-stage wizard**: the server holds the session
  and the locks. You propose; the user approves; the server locks.

## Why

- Custom gifting is hard to craft — idea, design, print, sourcing, all manual.
- Printers want an MOQ. p2gift: **qty 1 OK, no MOQ, fast**.
- Agentic end to end: you run it; the user only picks + approves.

## Marks used in the worked example

- 🔧 tool call — Agent → MCP. 📩 tool reply — MCP → Agent.
- 🖥️ your local work — no server call.
- 🔒 lock set (server-side, write-once). 📍 session state.

## Who does what

- **Yours, locally (🖥️):** extract the pitch from the deck; render
  the layout mockups — on the themed-base image the server feeds at
  the gift lock, so they show the product with the pitch on it,
  never bare text panels; render the Final Print Artwork file.
- **The server's (🔧/📩):** session state and locks, the product
  page URL, the themed-base image, the ARTWORK_SPECS, prices,
  checkout, order status.
- Never invent: pitch wording, gift availability, price, qty,
  recipient. If it isn't locked or in a 📩, you don't have it.

## Terms

- `pitch_text` = Pitch Text / Feature Pitch. Never "snippet".
- `gift_item` = gift / gift item — the item the pitch prints on.
- `print_layout_design` = Print Layout Design — A, B, or C.
- `final_print_artwork` = Final Print Artwork — print-ready PNG: transparent background, single color, no logo, one file, under 15 MB. File-checked at the artwork lock; the visual check is the user's artwork approval.
- `ARTWORK_SPECS` = the print specs the server issues at the layout lock, for the locked gift_item + print_layout_design. The Final Print Artwork is rendered to them.
- `session_id` = the wizard session, issued by `start_session`. Every 🔧 carries it.
- `Lead_Time` = each gift item's own lead time. Expected delivery date = order date + the picked item's `Lead_Time`.

## Stages — in order, enforced by the server

| # | Stage | Move | 📍 after |
|---|---|---|---|
| 1 | Intake | 🖥️ extract pitch → 🔧 `start_session` | SOURCE_LOADED |
| 2 | Pitch | user picks/edits a pitch option → 🔧 `approve_pitch` → 📩 product page URL | 🔒 PITCH_LOCKED |
| 3 | Gift | user taps Pick on the product page, pastes "I pick N" → 🔧 `select_gift` | 🔒 gift locked |
| 4 | Layouts | 🖥️ render the 3 layout mockups on the themed-base image → user picks → 🔧 `approve_layout` → 📩 ARTWORK_SPECS | 🔒 layout · 📍 ARTWORK_SPECS |
| 5 | Artwork | 🖥️ render the artwork per ARTWORK_SPECS → user approves → 🔧 `approve_artwork` with the file | 🔒 ARTWORK_LOCKED |
| 6 | Order | 🔧 `set_order_details` — qty + recipient, from the user only | — |
| 7 | Checkout | 🔧 `prepare_checkout` → 📩 prefilled checkout link | CHECKOUT_ISSUED |
| 8 | Confirmation | 🔧 `get_order_status` until paid | 🔒 ORDER_CONFIRMED |
| 9 | Lookup | 🔧 `lookup_order` — any time later | — |

Rules of the wizard:

- One call advances exactly one stage. An out-of-order 🔧 is
  rejected; the rejection names the current 📍 and the next legal
  step — follow it.
- Locks are write-once and live on the server. To change a locked
  value, ask the user, then unlock that stage — every downstream
  lock clears with it.
- The pitch prints **exactly as locked**. Your local renders use
  the locked text, character for character.
- The product page is for the user, not for you: never browse it.
  Its URL comes to you in the 📩 from `approve_pitch`; pass it on.
- No sign-in at any stage before checkout. Sign-in is OAuth, in
  the browser, **inside checkout only** (stage 7): the user opens
  the prefilled link (expires in about 15 minutes — hand it over
  right away), signs in, sees the locked price and cart, and pays
  on the store page. Card details never pass through you. Link
  expired? `prepare_checkout` again — the locks hold.

## Stage 8 — Confirmation (MCP → Agent)

- After the user checks out, poll `get_order_status(session_id)`
  until it returns paid. The store's payment webhook is the only
  truth — the browser's success page proves nothing. Not paid yet
  means "not confirmed yet", never "placed".
- On paid, report the confirmation in three parts:
  1. **Payment confirmation (Stripe):** order #, amount, paid by card.
  2. **Expected delivery date:** [order date + {gift_id} Lead_Time] — as returned; once the order ships, the carrier's date replaces it.
  3. **Order lookup:** "You can look up the status of this order — here is the related skill: `p2gift-order-lookup`" (order # + order token).

## Stage 9 — Order Lookup

- Any time later, 🔧 `lookup_order(order_id, order_token)` →
  current status + expected delivery date. This is what the
  `p2gift-order-lookup` skill wraps; the wizard session is not
  needed for it.

## Resources — read first

- Worked example: `p2gift://examples/default.md` — the wizard run, with the marks above; the text carries the rules + the flow. Learn from it first.
- Images: the example's image assets are presentation links — fetch one only to show it to the user or to check a mockup, not to learn the flow.
- Live inventory: the store's own product list — `service_info` shows it (names, surfaces, Lead_Times). There is no separate inventory file; the wizard reads the same products the product page shows.

## Tools

| Tool | What it does |
|---|---|
| `start_session` | Opens a wizard session with your extracted pitch candidates → 📩 `session_id`, 📍 SOURCE_LOADED. |
| `approve_pitch` | Locks the user's picked/edited pitch_text → 📩 the product page URL. Rail: the pitch is fit-checked against the catalog surfaces; a pitch that fits nothing comes back with the reason — re-extract or re-condense and resubmit. |
| `select_gift` | Locks the gift item from the user's pasted pick ("I pick N"). |
| `approve_layout` | Locks the picked Print Layout Design (A/B/C) → 📩 ARTWORK_SPECS for the locked gift + layout. |
| `approve_artwork` | Submits your locally rendered Final Print Artwork file → file rail (PNG only, under 15 MB, transparent background, single color) → locks it. Fail → the reasons; fix and resubmit. |
| `set_order_details` | Records qty + recipient exactly as the user gave them. |
| `prepare_checkout` | Builds the cart from the locked session — item, artwork, qty, and the catalog price read server-side — and returns the signed prefilled checkout link (~15 min). OAuth sign-in happens in the browser, inside checkout. |
| `get_order_status` | Stage 8: this session's order state from the store (webhook-settled). Poll until paid / expired / failed. |
| `lookup_order` | Stage 9: order status + expected delivery date by order # + order token, no session needed. |

## Live Connect

- The channel is the store's Contact page — a CMS page, text not a function — plus email.
- Blocked — a step cannot be settled, or a decision is needed (e.g. an artwork override)? Do not invent an answer.
- Draft an email for your user to hello@keeg.uk (Contact page: https://p2gift.keeg.uk/pages/contact-us).
- The draft carries: session/order reference, gift_item, where you are stuck, your question.
- Your user sends it from their own email. The operator — or the operator's Muse — replies by email.
- Approvals and exceptions are the operator's own decision; wait for the reply before proceeding.
