// Generate a p2gift customer API key and its SHA-256 digest.
// The KEY goes to the customer privately (never publish it).
// The DIGEST is the KV key in the P2GIFT_KEYS namespace.
// Usage: node scripts/issue-key.mjs "Customer Name"
import { randomBytes, createHash } from "node:crypto";

const customer = process.argv[2] || "customer";
const key = "p2g_" + randomBytes(16).toString("hex");
const digest = createHash("sha256").update(key).digest("hex");
console.log(`customer: ${customer}`);
console.log(`key (send privately, never publish): ${key}`);
console.log(`sha256 (KV key in P2GIFT_KEYS): ${digest}`);
console.log(`KV value: ${JSON.stringify({ customer, created: new Date().toISOString().slice(0, 10) })}`);
