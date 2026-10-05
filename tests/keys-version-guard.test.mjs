// Service keys need a server at API version 6 (`SERVICE_KEYS_MIN_API_VERSION`).
// An older server ignores `service`, `member` and `?service=true`: it would mint
// a team key, or a personal key acting as the caller, and list the caller's own
// keys. So `keys.create` with a service option and `keys.list({ service: true })`
// read the server's version first and refuse, sending nothing, below 6.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CoveClient, CoveError, SERVICE_KEYS_MIN_API_VERSION } from "../dist/index.js";

function fakeFetch(...responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return next();
  };
  return { calls, impl };
}
const json = (body, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
// The version probe: `GET /api/whoami`, whose `x-cove-api-version` header (on
// every successful server response) is the server's API version.
const probe = (api_version) => () =>
  new Response(JSON.stringify({ username: "admin" }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...(api_version === undefined ? {} : { "x-cove-api-version": String(api_version) }),
    },
  });
const client = (impl) => new CoveClient({ baseUrl: "https://cove.test", token: "cvk_x", fetch: impl });

const serviceCalls = {
  "create --team": (c) => c.keys.create({ label: "l", service: "ci", team: "eng", expires_in_secs: 60 }),
  "create --member": (c) => c.keys.create({ label: "l", service: "ci", member: "alice", expires_in_secs: 60 }),
  // `member` alone: an older server ignores it and mints a personal key acting as
  // the caller, so it is refused too, not only when `service` is set.
  "create member alone": (c) => c.keys.create({ label: "l", member: "alice", expires_in_secs: 60 }),
  "list --service": (c) => c.keys.list({ service: true }),
};

test("SERVICE_KEYS_MIN_API_VERSION is 6", () => {
  assert.equal(SERVICE_KEYS_MIN_API_VERSION, 6);
});

for (const [name, call] of Object.entries(serviceCalls)) {
  for (const [why, reply] of [
    ["version 5", probe(5)],
    ["version 0", probe(0)],
    ["no version", probe(undefined)],
    ["the probe fails", json({ code: "internal", message: "x" }, 500)],
  ]) {
    test(`${name} is refused against a server with ${why}, and nothing is sent`, async () => {
      const { calls, impl } = fakeFetch(reply, json({}));
      await assert.rejects(call(client(impl)), (err) => {
        assert.ok(err instanceof CoveError, `got ${err}`);
        assert.match(err.message, /service keys/);
        assert.match(err.message, /API version 6/);
        return true;
      });
      assert.deepEqual(
        calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
        ["GET /api/whoami"],
      );
    });
  }

  test(`${name} is refused when the server cannot be reached`, async () => {
    const calls = [];
    const impl = async (url) => {
      calls.push(url);
      throw new TypeError("connection refused");
    };
    await assert.rejects(call(client(impl)), /service keys/);
    assert.equal(calls.length, 1);
  });

  test(`${name} goes through against a version 6 server`, async () => {
    const { calls, impl } = fakeFetch(probe(6), json(name.startsWith("list") ? [] : {}));
    await call(client(impl));
    const sent = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    assert.deepEqual(sent, [
      "GET /api/whoami",
      name.startsWith("list") ? "GET /api/api-keys" : "POST /api/api-keys",
    ]);
  });
}

test("a key that is not a service key never asks the server's version", async () => {
  for (const call of [
    (c) => c.keys.create({ label: "l" }),
    (c) => c.keys.create({ label: "l", team: "eng", expires_in_secs: 60 }),
    (c) => c.keys.list(),
    (c) => c.keys.list({ team: "eng" }),
  ]) {
    const { calls, impl } = fakeFetch(json([]));
    await call(client(impl));
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).pathname, "/api/api-keys");
  }
});

test("the version probe works on the main listener, which serves no /api/health", async () => {
  // The main (ticket) listener serves `/health` at the root only and
  // `/api/health` not at all; `/api/whoami` and its version header are on
  // every listener.
  const calls = [];
  const impl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/health") return json({ code: "not_found", message: "x" }, 404)();
    if (path === "/api/whoami") return probe(6)();
    return json({})();
  };
  await client(impl).keys.create({ label: "l", service: "ci", team: "eng", expires_in_secs: 60 });
  assert.deepEqual(calls, ["GET /api/whoami", "POST /api/api-keys"]);
});

test("the version comes from the probe's own response, not an earlier one", async () => {
  // An earlier call saw version 6; a whoami reply with no header proves
  // nothing about this server, so the service call is still refused.
  const { calls, impl } = fakeFetch(probe(6), probe(undefined), json({}));
  const c = client(impl);
  await c.meta.whoami();
  assert.equal(c.serverApiVersion, 6);
  await assert.rejects(
    c.keys.create({ label: "l", service: "ci", team: "eng", expires_in_secs: 60 }),
    /API version unknown/,
  );
  assert.deepEqual(
    calls.map((x) => `${x.method} ${new URL(x.url).pathname}`),
    ["GET /api/whoami", "GET /api/whoami"],
  );
});
