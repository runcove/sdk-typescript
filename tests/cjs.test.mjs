import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// The CJS build must be loadable with require() and expose the same surface
// as the ESM entry (dual ESM+CJS is an acceptance criterion of this SDK).
const require = createRequire(import.meta.url);

test("dist/cjs is require()-able and exports the public surface", async () => {
  const cjs = require("@runcove/sdk");
  const esm = await import("@runcove/sdk");
  for (const name of ["CoveClient", "BearerAuth", "TicketAuth", "parseSSE", "verifyWebhookSignature", "NotFoundError"]) {
    assert.equal(typeof cjs[name], typeof esm[name], `${name} differs between builds`);
    assert.ok(cjs[name], `${name} missing from CJS build`);
  }
});

// Known vector shared with the server's signer test; `toleranceSecs: 0` because
// its ce-time is frozen (see tests/webhook.test.mjs).
const VECTOR = {
  secret: "whsec_test_secret",
  headers: {
    "ce-id": "0192f000-0000-7000-8000-000000000001",
    "ce-time": "2026-05-09T12:34:56.789Z",
    "Cove-Signature": "v1,7fc7064942271bda82b1f5ccf056e865c3ddfed4dd4b81a976722a6dc0d3acb6",
  },
  body: '{"kind":"vm.created"}',
  toleranceSecs: 0,
};

/** Run `fn` with no `crypto` global, the way Node 18 presents itself. */
async function withoutCryptoGlobal(fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  try {
    return await fn();
  } finally {
    if (saved) Object.defineProperty(globalThis, "crypto", saved);
    else delete globalThis.crypto;
  }
}

test("the Node 18 WebCrypto fallback still resolves in both builds", async () => {
  // The `node:crypto` specifier is assembled at runtime so browser bundlers
  // don't try to resolve it; that must not cost Node 18 its fallback. The CJS
  // build reaches it through a transpiled `require`, the ESM build through a
  // real dynamic import.
  const cjs = require("@runcove/sdk");
  const esm = await import("@runcove/sdk");
  await withoutCryptoGlobal(async () => {
    assert.equal(await cjs.verifyWebhookSignature(VECTOR), true);
    assert.equal(await esm.verifyWebhookSignature(VECTOR), true);
  });
});
