import { test } from "node:test";
import assert from "node:assert/strict";
import { CoveClient, CoveConnectionError, CoveError, CoveTimeoutError } from "../dist/index.js";

const states = (...seq) => { let i = 0; return async () => new Response(JSON.stringify({ name: "a", state: seq[Math.min(i++, seq.length - 1)] }), { status: 200, headers: { "Content-Type": "application/json" } }); };
const client = (fetch) => new CoveClient({ baseUrl: "https://cove.test", token: "cvk_x", fetch });

test("resolves with the VM once it reaches one of the states", async () => {
  const vm = await client(states("creating", "creating", "running")).vms.waitForState("a", ["running"], { intervalMs: 1, timeoutMs: 1000 });
  assert.equal(vm.state, "running");
});

test("throws CoveTimeoutError (no cause) at the deadline, naming the last state", async () => {
  const err = await client(states("creating")).vms.waitForState("a", ["running"], { intervalMs: 5, timeoutMs: 30 }).catch((e) => e);
  assert.ok(err instanceof CoveError);
  assert.ok(err instanceof CoveTimeoutError && err instanceof CoveConnectionError, String(err));
  assert.equal(err.cause, undefined);
  assert.match(err.message, /creating/);
});

test("an abort signal stops it, unwrapped", async () => {
  const ac = new AbortController(); setTimeout(() => ac.abort(), 10);
  const err = await client(states("creating")).vms.waitForState("a", ["running"], { intervalMs: 5, timeoutMs: 10_000, signal: ac.signal }).catch((e) => e);
  assert.equal(err.name, "AbortError");
});

test("the last sleep is clamped to the deadline, so a long interval cannot overshoot timeoutMs", async () => {
  const t0 = Date.now();
  const err = await client(states("creating")).vms.waitForState("a", ["running"], { timeoutMs: 100, intervalMs: 3000 }).catch((e) => e);
  const took = Date.now() - t0;
  assert.ok(err instanceof CoveError && /creating/.test(err.message), String(err));
  assert.ok(took < 1000, `rejected after ${took} ms, expected well under the 3000 ms interval`);
});
