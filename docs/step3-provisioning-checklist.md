# Step 3 — Provision + first deploy (p2gift store, one Worker)

Status: DRAFT (VM only). Nothing here has run yet. Owner-run steps are
marked **Owner**; verification steps are **Muse**. One step at a time,
checkpoint after each. Do not skip a checkpoint.

## What Step 3 does

Give the merged Worker (minshop storefront + p2gift MCP in one Worker,
name `p2gift`, domain `p2gift.keeg.uk`) its real Cloudflare resources,
deploy it, and prove the MCP service still works live afterwards.

## Warnings — read first

- Deploying **replaces the live standalone p2gift Worker** (same Worker
  name, same domain). The MCP endpoint must be re-verified live
  immediately after (step 5). The old standalone code stays in git
  history (`mcp-server/` is the same code, kept in the repo).
- **Do NOT recreate the R2 bucket `p2gift`.** It already exists and
  holds the Connect example, the Connect guide, and the live inventory.
  Provision only: D1 `p2gift-db`, R2 `p2gift-images`, R2 `p2gift-files`.
- Never commit a rendered `wrangler.jsonc` with real ids, and never put
  secrets in the repo. Secrets go via `wrangler secret put` or the Admin
  vault only. Recorded ids live in `.instances/p2gift.env` (gitignored).
- The `provision-cf.sh` bash script needs bash + `openssl`. It failed
  under WSL before, Git Bash is not installed on the owner's Windows
  machine (and not wanted), and `openssl` is not recognised there — so
  the manual PowerShell route below is the expected path, as for
  HappyWife. `npm run deploy` also fails on PowerShell
  (`spawnSync npx ENOENT`); use `npx astro build` + `npx wrangler deploy`.

## Checklist

### 1. Push the merged draft to GitHub — Muse, then Owner confirms
- [ ] Muse stages the Step 1 + Step 2 changes; Owner reviews the diff.
- [ ] Owner confirms the push. Muse pushes to `main` (deploy key) and
      verifies the push in GitHub.
- Checkpoint: GitHub `main` shows the merged tree (minshop app +
  `mcp-server/`, one `wrangler.jsonc`).

### 2. Owner machine setup — Owner
- [ ] On Windows: pull/clone `99cBagel/p2gift`, Node 22, `npm ci`.
- [ ] `npx wrangler login` (already logged in from the p2gift setup —
      verify with `npx wrangler whoami`).
- Checkpoint: `node --version` is v22, wrangler shows the right account.

### 3. Provision D1 + R2 — Owner (PowerShell, manual route)
- [ ] `npx wrangler d1 create p2gift-db` → save the `database_id`.
- [ ] `npx wrangler r2 bucket create p2gift-images`
- [ ] `npx wrangler r2 bucket create p2gift-files`
- [ ] Render the instance config: copy `wrangler.template.jsonc` to
      `wrangler.jsonc`, replacing `__NAME__` → `p2gift`,
      `__DB_NAME__` → `p2gift-db`, `__DB_ID__` → the id from above,
      `__BUCKET__` → `p2gift-images`, `__FILES_BUCKET__` →
      `p2gift-files`. (The `P2GIFT_BUCKET` / `p2gift` lines are already
      in the template — leave them.) Keep the rendered file out of git;
      record the ids in `.instances/p2gift.env`.
- Checkpoint: D1 id recorded; both buckets exist; `wrangler.jsonc`
  has the real ids locally.

### 4. Migrate + build + deploy — Owner
- [ ] `npx wrangler d1 migrations apply DB --remote`
- [ ] `npx astro build`
- [ ] `npx wrangler deploy`
- [ ] Secrets (PowerShell RNG route — no `openssl` on this machine):
      generate two 32-byte base64 secrets and
      `npx wrangler secret put AUTH_SECRET` and
      `npx wrangler secret put SECRETS_KEK` (paste each when prompted).
- Checkpoint: deploy succeeds; `https://p2gift.keeg.uk/` loads the
  storefront. **Do NOT create an OAUTH_KV namespace** — it already
  exists (id `ef0213b1ba124aa8aed1e98f1912b4ac`, already in the config);
  the authorization server stores its grants + tokens there. (The old
  P2GIFT_KEYS API-key store is retired with v0.2.0 — no keys are issued.)

### 5. Setup wizard + live MCP verification — Owner, then Muse
- [ ] Owner: visit `https://p2gift.keeg.uk/admin/setup`, set the admin
      password (owner sets it, never shared), complete setup.
- [ ] Muse verifies live: `POST /mcp` initialize → p2gift 0.2.0
      **with an OAuth token** (no token → 401 challenge is the expected
      negative check); full order pitch → gift → mockup → artwork →
      checkout → done (TEST-ONLY data); `GET /inventory` →
      `r2-inventory`, 6 items; `GET /connect` → the guide, HTTP 200;
      `GET /health` → service JSON; storefront loads.
- Checkpoint: all five checks green. If `/mcp` fails, the deploy is
  rolled back before anything else is done.

### 6. Products + payments — Owner (needs the price decision first)
- [ ] Decide prices for the 6 keepsakes. DEFERRED by the user
      2026-11-07: ignore keepsake prices for now. All keepsake items
      will be reset again, and that reset happens only after minshop
      is ready. No product gets a price invented, and no keepsake
      work until then.
- [ ] Create the 6 keepsake products in Admin with photos, prices,
      and (for the pitch) the personalisation capture step.
- [ ] Demo checkout test (Demo rail, no payment).
- [ ] Stripe test mode: test keys in Admin → Settings → Payments;
      webhook in Stripe pointing at
      `https://p2gift.keeg.uk/api/webhook/stripe` with events
      `checkout.session.completed`,
      `checkout.session.async_payment_succeeded`, `charge.refunded`;
      test checkout with a US address and card `4242 4242 4242 4242`.
- Checkpoint: one Demo order and one Stripe-test order, both verified
  paid before anything is treated as shippable. Live keys are a
  separate gated decision, later.

### 7. CI deploy wiring — later, not blocking Step 3
- [ ] `deploy.yml` currently runs plain `npx wrangler deploy` against
      the placeholder `wrangler.jsonc` — it will fail without a real
      `database_id`. Before CI deploys work, the id must reach CI the
      HappyWife way (GitHub Secrets/Variables rendering the config).
      Until then, deploys are manual from the owner's machine.
- [ ] `verify.yml` (minshop CI) runs on push — expect it to run; keep
      it green.
