-- 0042: the verified identity captured at the browser checkout gate.
-- Additive.
--
-- In the v0.3.0 model the MCP service is open; the human step is the
-- checkout gate, where the buyer signs in (Google, GitHub, or a US phone
-- code) in the browser right before paying. When that sign-in completes
-- against an open agent prefill, the verified identity is recorded on
-- the prefill row: it is the order's verified contact for the follow-up
-- mail flows (Amazon progress + thank-you), with the email Stripe
-- collects at payment as the fallback. Nullable: prefills prepared
-- before the gate existed, or never gated, simply have no identity.
ALTER TABLE prefill_carts ADD COLUMN gate_user_id TEXT;
ALTER TABLE prefill_carts ADD COLUMN gate_email TEXT;
ALTER TABLE prefill_carts ADD COLUMN gate_provider TEXT;
