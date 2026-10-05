import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import { verifyWebhookSignature } from "../dist/index.js";

// Known vector shared with the server's signer test
// (cove/cove-service/src/webhooks/sign.rs :: unit_sign_hmac_sha256_known_vector).
const SECRET = "whsec_test_secret";
const CE_ID = "0192f000-0000-7000-8000-000000000001";
const CE_TIME = "2026-05-09T12:34:56.789Z";
const BODY = '{"kind":"vm.created"}';
const SIG = "7fc7064942271bda82b1f5ccf056e865c3ddfed4dd4b81a976722a6dc0d3acb6";

const headers = (sig = `v1,${SIG}`) => ({
  "ce-id": CE_ID,
  "ce-time": CE_TIME,
  "Cove-Signature": sig,
});

// The known vector's ce-time is frozen, so every signature test opts out of the
// replay window; the window has its own tests at the bottom of the file.
const verify = (opts) => verifyWebhookSignature({ toleranceSecs: 0, ...opts });

test("verifies the server's known vector", async () => {
  assert.equal(
    await verify({ secret: SECRET, headers: headers(), body: BODY }),
    true,
  );
});

test("accepts a Headers object and Uint8Array body", async () => {
  const h = new Headers(headers());
  const body = new TextEncoder().encode(BODY);
  assert.equal(await verify({ secret: SECRET, headers: h, body }), true);
});

test("header lookup on plain records is case-insensitive", async () => {
  const h = { "Ce-Id": CE_ID, "CE-TIME": CE_TIME, "cove-signature": `v1,${SIG}` };
  assert.equal(await verify({ secret: SECRET, headers: h, body: BODY }), true);
});

test("rotation grace: either space-separated v1 entry verifies", async () => {
  const dual = `v1,${"0".repeat(64)} v1,${SIG}`;
  assert.equal(
    await verify({ secret: SECRET, headers: headers(dual), body: BODY }),
    true,
  );
});

test("rotation grace: any of multiple secrets verifies", async () => {
  assert.equal(
    await verify({
      secret: ["whsec_old_rotated_out", SECRET],
      headers: headers(),
      body: BODY,
    }),
    true,
  );
});

test("rejects a wrong secret and a tampered body", async () => {
  assert.equal(
    await verify({ secret: "whsec_wrong", headers: headers(), body: BODY }),
    false,
  );
  assert.equal(
    await verify({
      secret: SECRET,
      headers: headers(),
      body: '{"kind":"vm.deleted"}',
    }),
    false,
  );
});

test("rejects a header with no v1 entries", async () => {
  assert.equal(
    await verify({ secret: SECRET, headers: headers("v2,abcdef"), body: BODY }),
    false,
  );
});

test("throws on missing headers or empty secret", async () => {
  await assert.rejects(
    verify({ secret: SECRET, headers: { "ce-id": CE_ID }, body: BODY }),
    TypeError,
  );
  await assert.rejects(
    verify({ secret: "", headers: headers(), body: BODY }),
    TypeError,
  );
  await assert.rejects(
    verify({ secret: [], headers: headers(), body: BODY }),
    TypeError,
  );
});

/** Sign a delivery the way the server does, so a fresh `ce-time` can be tested. */
async function signed(ceTime, body = BODY, secret = SECRET) {
  const enc = new TextEncoder();
  const key = await webcrypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await webcrypto.subtle.sign("HMAC", key, enc.encode(`${CE_ID}.${ceTime}.${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { "ce-id": CE_ID, "ce-time": ceTime, "Cove-Signature": `v1,${hex}` };
}

test("a delivery inside the replay window verifies", async () => {
  const h = await signed(new Date().toISOString());
  assert.equal(await verifyWebhookSignature({ secret: SECRET, headers: h, body: BODY }), true);
});

test("an authentic but stale delivery is rejected as a replay", async () => {
  const h = await signed(new Date(Date.now() - 3_600_000).toISOString());
  assert.equal(await verifyWebhookSignature({ secret: SECRET, headers: h, body: BODY }), false);
  // The caller can widen the window, or turn it off for a queue that replays.
  assert.equal(
    await verifyWebhookSignature({
      secret: SECRET,
      headers: h,
      body: BODY,
      toleranceSecs: 7200,
    }),
    true,
  );
  assert.equal(
    await verifyWebhookSignature({ secret: SECRET, headers: h, body: BODY, toleranceSecs: 0 }),
    true,
  );
});

test("a delivery timestamped in the future is rejected too", async () => {
  const h = await signed(new Date(Date.now() + 3_600_000).toISOString());
  assert.equal(await verifyWebhookSignature({ secret: SECRET, headers: h, body: BODY }), false);
});

test("an unparseable ce-time is rejected unless the window is off", async () => {
  const h = await signed("not-a-timestamp");
  assert.equal(await verifyWebhookSignature({ secret: SECRET, headers: h, body: BODY }), false);
  assert.equal(
    await verifyWebhookSignature({ secret: SECRET, headers: h, body: BODY, toleranceSecs: 0 }),
    true,
  );
});

test("a fresh timestamp does not rescue a bad signature", async () => {
  const h = await signed(new Date().toISOString(), '{"kind":"vm.deleted"}');
  assert.equal(await verifyWebhookSignature({ secret: SECRET, headers: h, body: BODY }), false);
});
