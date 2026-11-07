# p2gift — code repo

PPT-to-Gift Service Worker. MCP-enabled gifting service: a customer
submits a pitch (or a PPT), the Worker returns three gift concepts
from the same message, and the selected proposal is fulfilled manually.

**This repo is code only.** The work plan, service design, keepsake
pool, contractor list, and reference material live in
[99cBagel/p2gift-wiki](https://github.com/99cBagel/p2gift-wiki).

## Architecture

```
Customer pitch / PPT
  → trusted AI assistant (Muse or Claude)
  → MCP, Streamable HTTP, https://p2gift.keeg.uk/mcp
  → p2gift Worker (Cloudflare)
  → three gift concepts (Pitch Snippets + Keepsake Item)
  → customer picks one → checkout → manual fulfilment
```

No database in v1. Pitch in, three concepts out. No price is ever
invented — price, quantity, and delivery are confirmed per order.

## Workflow (enforced)

The order workflow is a state machine, taken from
`Muse Chat Log — Example2` (one example case only — no case pitch,
keepsake, or price is wired into the service; every order supplies
its own pitch). No step can be skipped,
and no step advances without an explicit user confirmation.

```
1 pitch     propose the pitch → user confirms it, as-is
2 gift      three concepts from that pitch → user picks 1, 2, or 3
3 mockup    mockup → fix text errors → layout → 3 layout examples
            → user picks A, B, or C, confirms proceed
4 artwork   record the chosen prototype → prepare print-ready
            artwork (3600×2400 px, 300 DPI) → user reviews, approves
5 checkout  quantity + recipient name/address + price → draft the
            order for confirmation. No price is ever invented.
```

Enforcement, in `src/workflow.js`:

- `start_order` opens a session at step 1 (pitch).
- `get_next_step` says what the current step needs.
- `confirm_step` advances exactly one step, and only with that
  step's data — pitch text, keepsake id, layout A/B/C, artwork
  approval, or checkout quantity/recipient/price. Anything else,
  including an out-of-order confirmation, is rejected with an
  error naming the step that must be completed first.
- The Worker is stateless: the session object is returned to the
  assistant, which presents it back on the next call. The Worker
  validates the step order on every call. It keeps no order record
  itself — the assistant keeps the record, and the chat log is the
  order record until checkout is confirmed.
- Checkout (step 5) does not take payment in this Worker. It hands
  off to the minshop checkout module, below.

## Checkout module — minshop

Checkout is minshop, as a separate module — not merged into this
Worker. This Worker owns concepts; minshop owns products, cart,
payment, shipping, and orders.

```
p2gift Worker (concepts, steps 1–4)
  → step 5: checkout draft (pitch + keepsake + layout + artwork)
  → minshop checkout (own Worker + D1 + R2)
  → customer pays there → order recorded → manual fulfilment
```

- The 6 keepsakes are minshop products, with prices confirmed
  per order (no price is set in this repo).
- The pitch travels with the order as its personalisation — as a
  line-item personalisation / order note. Minshop has no native
  gift-message field, so that capture step is part of the
  minshop module, not this Worker.
- Payment order, as in HappyWife: Demo first, then Stripe test
  mode, live keys only by a separate gated decision.
- Manual fulfilment stays manual: minshop records a paid order,
  a person fulfils it. Nothing is shipped on an unpaid order.

## Endpoint

- MCP (Streamable HTTP): `https://p2gift.keeg.uk/mcp`
- Health / info: `GET /` → `{ service: "p2gift", mcp: "/mcp" }`

## Inventory (mini inventory system)

The keepsake pool is **not hardcoded**. It is loaded at call time
from R2 `inventory/inventory.json` (source file in this repo:
`inventory/inventory.json`, synced by the Sync to R2 workflow).

- `list_inventory` — available items only (`available=true`).
- `list_keepsakes` and `service_info` — same available list.
- `suggest_keepsakes` — picks its 3 concepts only from that
  available list, in pool order (full, then condensed, then short).
- `GET /inventory` — public JSON of the same list, for the
  gift-concept picker page: `{ source, items }`.
- If R2 is missing, unreadable, or empty, the Worker falls back
  to the hardcoded 6-item pool and reports
  `source: "fallback-pool"` — it never shows nothing.
- To change what is offered: edit `inventory/inventory.json`
  (set `available` true/false, add or remove an item) and push
  to `main`. The Sync to R2 workflow uploads it; no Worker
  redeploy is needed for an inventory change.

## Connect-stage learning example (R2)

At connect, the assistant reads the skills and one worked example
first — before starting any order. The example lives in the R2
bucket `p2gift`, folder `connect-examples/`, and is served by the
Worker as MCP resources (not embedded in code):

- `p2gift://connect-examples/connect-example.md` — streamlined
  example run: pitch, 3 concepts, mockup fixes, 3 layouts,
  artwork, checkout gating. Source file in this repo:
  `connect-example.md`.
- `p2gift://connect-examples/mockup-tumbler.webp`
- `p2gift://connect-examples/layout-a.webp`
- `p2gift://connect-examples/layout-b.webp`
- `p2gift://connect-examples/layout-c.webp`
- `p2gift://connect-examples/artwork-layout-b.png` — print artwork,
  3600×2400 px, 300 DPI, white text on black.

Source images in this repo: `examples/assets/`. The Worker exposes
them via `resources/list` / `resources/read`, and the connect prompt
`p2gift-connect` (via `prompts/list` / `prompts/get`) tells the
assistant to read the markdown first, then view all 5 images in
order, then start with `start_order` at step 1 (pitch).

## Tools

- `service_info` — service overview and keepsake pool.
- `list_keepsakes` — the 6-item keepsake pool.
- `suggest_keepsakes` — `pitch` in, three different concepts out.
  Optional `recipient_profile` (only if supplied) and `topic_category`.

## Connect

- **Muse** — connect to the MCP server at `https://p2gift.keeg.uk/mcp`,
  no auth. See `Connect_page_muse.html` in p2gift-wiki.
- **Claude** — connect to the same MCP server at
  `https://p2gift.keeg.uk/mcp`, no auth. See `Connect_page_claude.html`
  in p2gift-wiki.

ChatGPT is not a target assistant for p2gift: PPT processing there
requires a Plus-or-above subscription, and it has no persistent
memory. See p2gift-wiki for the full reasoning.

## MCP APP-targeting for Claude

Claude is the app-targeting client. Where Claude supports MCP apps,
the Worker may return app-targeted content — an interactive keepsake
proposal (pitch, keepsake, mockup) that the customer can inspect and
pick inside Claude, instead of reading a plain text list.

Rules for app-targeting:

- The three concepts are the same as the text tools return — same
  pitch, same keepsake pool, same selection rule. The app is a
  presentation of the concepts, not a second selection path.
- No checkout, payment, or personal data inside the app. Checkout
  stays manual, confirmed in chat.
- If a Claude client does not support MCP apps, it falls back to the
  text tools below. Nothing breaks.

## Text response only MCP — targeting Muse

Muse is the text-response-only client. It uses the MCP tools above
and receives plain text (JSON) only — no app, no interactive UI.

Rules for text-only:

- Every concept is returned as text: keepsake name, pitch text,
  and fit (full / condensed / short). Mockups are generated by the
  assistant in chat, from that text, not by the Worker.
- The assistant keeps the record: pitch, chosen concept, mockup,
  and print file. The Worker is stateless and keeps nothing.
- The chat log is the order record until checkout is confirmed.

## Develop

```sh
npm install -g wrangler   # or npx wrangler
npm run dev               # local dev server, http://localhost:8787
npm run check             # syntax check (no test suite yet)
npm run deploy            # deploy to Cloudflare (owner-run, or CI)
```

## Deploy (CI)

Push to `main` → `.github/workflows/deploy.yml` → `wrangler deploy`.
Required GitHub Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
The custom domain `p2gift.keeg.uk` is attached once in the Cloudflare
dashboard and persists across deploys; CI does not re-attach it, and
does not create D1/R2. The R2 bucket `p2gift` must already exist
(owner-created); the binding in `wrangler.toml` only attaches it.
The `connect-examples/` objects are uploaded to R2 separately —
`wrangler r2 object put p2gift/connect-examples/<file> --file <file>`
— they are not deployed from this repo.
