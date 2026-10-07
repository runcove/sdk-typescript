// `keys.revokeByToken` — revoke a key by presenting it (`POST
// /api/api-keys/revoke`, body `{ token }`). The server answers 202 with no body
// whatever the token was, and the SDK resolves to undefined on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CoveClient } from "../dist/index.js";

test("revokeByToken POSTs the token as JSON and resolves on 202", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    return new Response(null, { status: 202 });
  };
  const c = new CoveClient({ baseUrl: "https://cove.test", token: "cvk_mine", fetch });
  assert.equal(await c.keys.revokeByToken("cvk_leaked"), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "https://cove.test/api/api-keys/revoke");
  assert.deepEqual(JSON.parse(calls[0].body), { token: "cvk_leaked" });
});
