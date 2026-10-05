// A browser's native `fetch` throws "Illegal invocation" when it is called
// with a `this` that is neither the global object nor undefined; Node's does
// not check, so the rest of the suite cannot see the difference. These stubs
// enforce the browser rule: `this` must be `globalThis` or `undefined` (WebIDL
// treats an undefined receiver as the global object, so a bare `fetch(...)`
// call is fine; a method call on the SDK's own object is not).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CoveClient, CoveError } from "../dist/index.js";

function browserLikeFetch(seen) {
  return function (url, init) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
    seen.push(String(url));
    return Promise.resolve(
      new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  };
}

test("unit_default_global_fetch_is_called_with_globalThis_receiver", async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = browserLikeFetch(seen);
  try {
    const client = new CoveClient({ baseUrl: "https://cove.test", token: "cvk_x" });
    await client.vms.list();
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen.length, 1);
});

test("unit_supplied_fetch_is_not_called_as_a_method_of_the_sdk", async () => {
  const seen = [];
  const client = new CoveClient({
    baseUrl: "https://cove.test",
    token: "cvk_x",
    fetch: browserLikeFetch(seen),
  });
  await client.vms.list();
  assert.equal(seen.length, 1);
});

test("unit_no_global_fetch_still_refuses_with_a_clear_error", () => {
  const original = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    assert.throws(
      () => new CoveClient({ baseUrl: "https://cove.test", token: "cvk_x" }),
      (e) => e instanceof CoveError && /No fetch implementation/.test(e.message),
    );
  } finally {
    globalThis.fetch = original;
  }
});
