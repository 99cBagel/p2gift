# p2gift — Connect Prompt

For: the connected Agent. Read on connect, before any order.

## What

- **p2gift** = **PPT-to-Gift**: pitch in, gift out.
- In: Pitch Text, or a PPT deck.
- Out: the pitch printed on a gift item, sent to the recipient.
- Users: Muse users first (Nov 2026); other Agents later.

## Why

- Custom gifting is hard to craft — idea, design, print, sourcing, all manual.
- Printers want an MOQ. p2gift: **qty 1 OK, no MOQ, fast**.
- Agentic end to end: you run it; the user only picks + approves.

## Terms

- `pitch_text` = Pitch Text / Feature Pitch. Never "snippet".
- `gift_item` = gift / gift item — the item the pitch prints on.
- `print_layout_design` = Print Layout Design — A, B, or C.
- `final_print_artwork` = Final Print Artwork — print-ready PNG, 3600×2400, 300 DPI.

## Flow — 5 steps, in order, no skipping

1. **pitch** — confirm the Pitch Text as-is.
2. **gift** — suggest gift items; user picks 1.
3. **mockup** — show the pick; Print Layout Designs A/B/C.
4. **artwork** — Final Print Artwork; user approves.
5. **checkout** — qty + recipient + price. Never invent any of them.

## Resources — read first

- Worked example: `p2gift://examples/default.md` — the text carries the rules + the flow; learn from it first.
- Images: the example's 6 image assets are presentation links — fetch one only to show it to the user or to check a mockup, not to learn the flow.
- Layouts: `p2gift://examples/print-layout-example.md`.
- Live inventory: `p2gift://examples/inventory/inventory.json`.

## Tools

| Tool | What it does |
|---|---|
| `service_info` | Live service overview — the runtime companion to this connect prompt: the gift item pool, the catalog link, and how to pick. |
| `list_inventory` | The live gift item inventory from R2 — the source `suggest_gifts` picks from. |
| `suggest_gifts` | Pitch Text in → gift concepts out (up to three), each with its Product Page `image_url`, a ready `pick_message`, and the `catalog_url` for the [view catalog] link. |
| `suggest_print_layout` | Pitch Text in → the three Print Layout Designs (A, B, C) out, each with its example image. |
| `start_order` | Opens an order session and returns step 1 (pitch). |
| `get_next_step` | Returns the current step for a session. |
| `confirm_step` | Confirms the current step and advances exactly one. Rejects out-of-order confirmations. |
