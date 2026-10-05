// Version skew and typed refusals: the `x-cove-api-version`
// response header, the `onVersionSkew` hook, `UpgradeRequiredError` on a 426
// `CLI_TOO_OLD`, and `ConflictError.createConflict()` on a `createVm` 409.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConflictError, CoveAPIError, CoveClient, UpgradeRequiredError } from "../dist/index.js";
import { COVE_API_VERSION } from "../dist/generated/api-version.gen.js";

/** Fake fetch that records calls and replays queued responses (last one sticks). */
function fakeFetch(...responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return next();
  };
  return { calls, impl };
}

/** A JSON response that advertises server API version `v` (omit `v` for no header). */
const withVersion = (v, body = {}, status = 200) => () => {
  const headers = { "Content-Type": "application/json" };
  if (v !== undefined) headers["x-cove-api-version"] = v;
  return new Response(JSON.stringify(body), { status, headers });
};

const client = (fetchImpl, extra = {}) =>
  new CoveClient({ baseUrl: "https://cove.test", token: "cvk_x", fetch: fetchImpl, ...extra });

/** Swap `process.emitWarning` for a recorder for the length of `fn`. */
async function withWarnings(fn) {
  const saved = process.emitWarning;
  const warnings = [];
  process.emitWarning = (...args) => warnings.push(args);
  try {
    await fn(warnings);
  } finally {
    process.emitWarning = saved;
  }
}

test("onVersionSkew fires once per client, with both versions", async () => {
  const seen = [];
  const other = String(Number(COVE_API_VERSION) + 1);
  const { impl } = fakeFetch(withVersion(other));
  const c = client(impl, { onVersionSkew: (i) => seen.push(i) });
  assert.equal(c.serverApiVersion, undefined, "nothing seen before the first response");
  await c.meta.health();
  await c.meta.health();
  assert.deepEqual(seen, [{ client: COVE_API_VERSION, server: other }]);
  assert.equal(c.serverApiVersion, Number(other));
});

test("the latch is per client: a second client reports again", async () => {
  const seen = [];
  const { impl } = fakeFetch(withVersion("99"));
  await client(impl, { onVersionSkew: (i) => seen.push(i.server) }).meta.health();
  await client(impl, { onVersionSkew: (i) => seen.push(i.server) }).meta.health();
  assert.deepEqual(seen, ["99", "99"]);
});

test("the header is read before the status check, so an error response still reports skew", async () => {
  const seen = [];
  const { impl } = fakeFetch(withVersion("99", { code: "resource_not_found", message: "no" }, 404));
  const c = client(impl, { onVersionSkew: (i) => seen.push(i.server) });
  await assert.rejects(c.meta.health());
  assert.deepEqual(seen, ["99"]);
  assert.equal(c.serverApiVersion, 99);
});

test("serverApiVersion tracks the last value seen; a missing or non-integer header leaves it alone", async () => {
  const { impl } = fakeFetch(withVersion(COVE_API_VERSION), withVersion(undefined), withVersion("5a"));
  const c = client(impl, { onVersionSkew: () => assert.fail("no skew was advertised") });
  await c.meta.health();
  assert.equal(c.serverApiVersion, Number(COVE_API_VERSION));
  await c.meta.health();
  assert.equal(c.serverApiVersion, Number(COVE_API_VERSION));
  await c.meta.health();
  assert.equal(c.serverApiVersion, Number(COVE_API_VERSION));
});

test("no skew, no call; null silences the default; the default warns once", async () => {
  let n = 0;
  await client(fakeFetch(withVersion(COVE_API_VERSION)).impl, { onVersionSkew: () => n++ }).meta.health();
  assert.equal(n, 0);
  await withWarnings(async (warnings) => {
    const quiet = client(fakeFetch(withVersion("99")).impl, { onVersionSkew: null });
    await quiet.meta.health();
    assert.equal(warnings.length, 0);
    assert.equal(quiet.serverApiVersion, 99, "null silences the hook, not the tracking");
    const loud = client(fakeFetch(withVersion("99")).impl);
    await loud.meta.health();
    await loud.meta.health();
    assert.equal(warnings.length, 1, "default hook warns once through process.emitWarning");
    assert.deepEqual(warnings[0], [
      `Cove server speaks API version 99; this SDK speaks ${COVE_API_VERSION}`,
      "CoveApiVersionWarning",
    ]);
  });
});

test("the default hook is silent where process.emitWarning does not exist (browsers)", async () => {
  // Stub only emitWarning: the node:test runner itself reads `process`.
  const saved = process.emitWarning;
  process.emitWarning = undefined;
  try {
    const c = client(fakeFetch(withVersion("99")).impl);
    await c.meta.health(); // must not throw
    assert.equal(c.serverApiVersion, 99, "positive control: the skew was seen");
  } finally {
    process.emitWarning = saved;
  }
});

test("the SDK never writes to the console itself", async () => {
  const saved = { warn: console.warn, log: console.log, error: console.error };
  let calls = 0;
  console.warn = console.log = console.error = () => calls++;
  try {
    await withWarnings(async (warnings) => {
      await client(fakeFetch(withVersion("99")).impl).meta.health();
      assert.equal(warnings.length, 1, "positive control: the default hook ran");
    });
  } finally {
    Object.assign(console, saved);
  }
  assert.equal(calls, 0);
});

// The exact 426 body `cli_too_old_response` sends (`CliTooOldBody` in sdk/openapi.yaml).
const cliTooOld = {
  code: "CLI_TOO_OLD",
  message: "Your CLI is too old. Minimum API version: 5. Run `cove update` to upgrade.",
  min_cli_version: "0.24.0",
};

test("426 CLI_TOO_OLD becomes UpgradeRequiredError with no baseUrl in its message", async () => {
  const c = new CoveClient({
    baseUrl: "https://secret-host.test",
    token: "cvk_x",
    fetch: fakeFetch(withVersion("5", cliTooOld, 426)).impl,
    onVersionSkew: null,
  });
  const err = await c.meta.health().catch((e) => e);
  assert.ok(err instanceof UpgradeRequiredError, `got ${err}`);
  assert.ok(err instanceof CoveAPIError);
  assert.equal(err.name, "UpgradeRequiredError");
  assert.equal(err.status, 426);
  assert.equal(err.code, "CLI_TOO_OLD");
  assert.deepEqual(err.body, cliTooOld);
  assert.equal(err.serverApiVersion, 5);
  assert.equal(err.minCliVersion, "0.24.0");
  assert.match(err.message, new RegExp(`speaks API version ${COVE_API_VERSION}\\b`));
  assert.match(err.message, /server version 5\b/);
  assert.match(err.message, /\/public\/sdk\/index\.json/);
  assert.match(err.message, /Warpgate-fronted/);
  assert.doesNotMatch(err.message, /secret-host/);
});

test("426 CLI_TOO_OLD without the header (the bearer listener's early refusal) still types", async () => {
  const c = client(fakeFetch(withVersion(undefined, cliTooOld, 426)).impl);
  const err = await c.meta.health().catch((e) => e);
  assert.ok(err instanceof UpgradeRequiredError, `got ${err}`);
  assert.equal(err.serverApiVersion, undefined);
  assert.equal(err.minCliVersion, "0.24.0");
  assert.doesNotMatch(err.message, /undefined|NaN/);
  assert.match(err.message, /\/public\/sdk\/index\.json/);
});

test("any other 426 stays a generic CoveAPIError", async () => {
  const c = client(fakeFetch(withVersion("5", { code: "internal_error", message: "x" }, 426)).impl, {
    onVersionSkew: null,
  });
  const err = await c.meta.health().catch((e) => e);
  assert.ok(err instanceof CoveAPIError);
  assert.ok(!(err instanceof UpgradeRequiredError));
  assert.equal(err.message, "HTTP 426: x");
});

// Bodies below are the contract's `VmCreateConflictResponse` branches (sdk/openapi.yaml):
// `VmNameTakenBody` and one `DenyReason` variant, field for field.
const nameTaken = {
  code: "vm_name_taken",
  message: "VM name 'web-1' is in its post-delete cooldown",
  name: "web-1",
  retry_after_secs: 5,
};
const quotaDenied = { code: "user_vcpu_quota_exceeded", limit: 8, requested: 4, used: 6 };

test("createVm 409 narrows to name_taken or a DenyReason", async () => {
  const taken = new ConflictError(409, nameTaken.message, "vm_name_taken", nameTaken);
  assert.deepEqual(taken.createConflict(), { kind: "name_taken", retryAfterSecs: 5 });
  const live = { code: "vm_name_taken", message: "taken", name: "web-1" };
  assert.deepEqual(new ConflictError(409, "taken", "vm_name_taken", live).createConflict(), {
    kind: "name_taken",
    retryAfterSecs: undefined,
  });
  const nulled = { ...live, retry_after_secs: null };
  assert.deepEqual(new ConflictError(409, "taken", "vm_name_taken", nulled).createConflict(), {
    kind: "name_taken",
    retryAfterSecs: undefined,
  });
  const denied = new ConflictError(409, "denied", quotaDenied.code, quotaDenied);
  assert.deepEqual(denied.createConflict(), { kind: "denied", reason: quotaDenied });
});

test("createConflict is undefined for any other 409", () => {
  const other = { code: "invalid_state_transition", message: "VM is stopped" };
  assert.equal(new ConflictError(409, "x", other.code, other).createConflict(), undefined);
  assert.equal(new ConflictError(409, "x", undefined, "plain text").createConflict(), undefined);
  assert.equal(new ConflictError(409, "x", undefined, undefined).createConflict(), undefined);
});

test("a createVm 409 off the wire narrows through the client", async () => {
  const { impl } = fakeFetch(withVersion(COVE_API_VERSION, quotaDenied, 409));
  const err = await client(impl).vms.create({ name: "web-1" }).catch((e) => e);
  assert.ok(err instanceof ConflictError, `got ${err}`);
  assert.deepEqual(err.createConflict(), { kind: "denied", reason: quotaDenied });
});

test("a throwing hook surfaces its error and releases the deadline and the body", async () => {
  let res;
  const { calls, impl } = fakeFetch(() => (res = withVersion("99", { ok: true })()));
  const boom = new Error("hook failed");
  const c = client(impl, { timeoutMs: 30, onVersionSkew: () => { throw boom; } });
  const err = await c.meta.health().catch((e) => e);
  assert.equal(err, boom, "the hook's own error reaches the caller");
  const signal = calls[0].init.signal;
  assert.ok(signal, "positive control: a deadline signal was attached");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(signal.aborted, false, "the timeout lease was disposed, so its timer never fired");
  assert.equal(res.bodyUsed, true, "the unread body was cancelled");
});
