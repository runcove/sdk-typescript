// End-to-end client behavior against a fake fetch: URL building, headers,
// query serialization, empty-body handling, error mapping, secrets scopes,
// and exec stream collection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ConflictError,
  CoveClient,
  EXEC_STDIN_MIN_API_VERSION,
  CoveConnectionError,
  CoveError,
  CoveTimeoutError,
} from "../dist/index.js";

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

const json = (body, status = 200) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const empty = (status = 204) => () => new Response(null, { status });
const sse = (text) => () =>
  new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });

function makeClient(fetchImpl, extra = {}) {
  return new CoveClient({ baseUrl: "https://cove.test/", token: "cvk_x", fetch: fetchImpl, ...extra });
}

test("builds URL against baseUrl (trailing slash stripped) and sets standard headers", async () => {
  const { calls, impl } = fakeFetch(json([]));
  await makeClient(impl).vms.list();
  assert.equal(calls[0].url, "https://cove.test/api/vms");
  const headers = calls[0].init.headers;
  assert.equal(headers.get("Authorization"), "Bearer cvk_x");
  assert.equal(headers.get("X-Cove-Api-Version"), "8");
  assert.equal(headers.get("Accept"), "application/json");
});

test("serializes query params, dropping undefined and repeating arrays", async () => {
  const { calls, impl } = fakeFetch(json([]));
  await makeClient(impl).vms.list({ state: "running", tag: ["a=1", "b=2"] });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("state"), "running");
  assert.deepEqual(url.searchParams.getAll("tag"), ["a=1", "b=2"]);
  assert.equal(url.searchParams.has("limit"), false);
});

test("keys.list({ service: true }) lists service keys", async () => {
  // The first call reads the server's version header (service keys need 6).
  const whoami = () =>
    new Response(JSON.stringify({ username: "admin" }), {
      status: 200,
      headers: { "Content-Type": "application/json", "x-cove-api-version": "6" },
    });
  const { calls, impl } = fakeFetch(whoami, json([]));
  await makeClient(impl).keys.list({ service: true });
  assert.equal(new URL(calls[0].url).pathname, "/api/whoami");
  const url = new URL(calls[1].url);
  assert.equal(url.pathname, "/api/api-keys");
  assert.equal(url.searchParams.get("service"), "true");
  assert.equal(url.searchParams.has("team"), false);
});

test("URL-encodes path segments", async () => {
  const { calls, impl } = fakeFetch(empty());
  await makeClient(impl).vms.delete("a b/c");
  assert.equal(calls[0].url, "https://cove.test/api/vms/a%20b%2Fc");
});

test("JSON body sets Content-Type and method", async () => {
  const { calls, impl } = fakeFetch(json({ name: "x" }, 202));
  await makeClient(impl).vms.create({ image: "ubuntu" });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.get("Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), { image: "ubuntu" });
});

test("empty 204 body resolves to undefined", async () => {
  const { impl } = fakeFetch(empty());
  assert.equal(await makeClient(impl).vms.stop("web-1"), undefined);
});

test("addPort resolves to the port, whether new (201) or already published (200)", async () => {
  const port = { port: 80, public: true, is_primary: true, url: "https://web-1.test/" };
  for (const status of [201, 200]) {
    const { calls, impl } = fakeFetch(json(port, status));
    assert.deepEqual(await makeClient(impl).vms.addPort("web-1", { port: 80 }), port);
    assert.equal(calls[0].init.method, "POST");
  }
});

test("addPort against a server older than API version 7 (empty 201) resolves to undefined", async () => {
  const { calls, impl } = fakeFetch(empty(201));
  assert.equal(await makeClient(impl).vms.addPort("web-1", { port: 80 }), undefined);
  assert.equal(calls[0].init.method, "POST");
});

test("removePort and tags.delete resolve to whether the thing existed", async () => {
  for (const existed of [true, false]) {
    const { calls, impl } = fakeFetch(json({ existed }));
    const client = makeClient(impl);
    assert.deepEqual(await client.vms.removePort("web-1", 8080), { existed });
    assert.deepEqual(await client.tags.delete("web-1", "env"), { existed });
    assert.equal(calls[0].url, "https://cove.test/api/vms/web-1/ports/8080");
    assert.equal(calls[1].url, "https://cove.test/api/vms/web-1/tags/env");
  }
  // A server older than API version 7 answers an empty 204: undefined.
  const { impl } = fakeFetch(empty());
  assert.equal(await makeClient(impl).tags.delete("web-1", "env"), undefined);
});

test("error response maps to typed error with code and body", async () => {
  const { impl } = fakeFetch(json({ code: "vm_name_taken", message: "taken" }, 409));
  await assert.rejects(
    makeClient(impl).vms.create({ name: "web-1" }),
    (err) => err instanceof ConflictError && err.code === "vm_name_taken" && err.status === 409,
  );
});

test("network failure wraps in CoveConnectionError", async () => {
  const impl = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(makeClient(impl).vms.list(), CoveConnectionError);
});

test("caller abort passes through unwrapped", async () => {
  const impl = async () => {
    const err = new Error("This operation was aborted");
    err.name = "AbortError";
    throw err;
  };
  await assert.rejects(makeClient(impl).vms.list(), { name: "AbortError" });
});

test("secrets VM scope hits /api/vms/<name>/secrets/<key>", async () => {
  const { calls, impl } = fakeFetch(empty(201));
  await makeClient(impl).secrets.vm("a b").set("API KEY", { value_b64: "eA==" });
  assert.equal(calls[0].url, "https://cove.test/api/vms/a%20b/secrets/API%20KEY");
  assert.equal(calls[0].init.method, "POST");
});

test("secrets envelope scopes hit their own prefixes", async () => {
  const { calls, impl } = fakeFetch(json([]));
  const client = makeClient(impl);
  await client.secrets.user("mehdi").list();
  await client.secrets.team("infra").list();
  await client.secrets.project("p1").list();
  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname),
    ["/api/users/mehdi/secrets", "/api/teams/infra/secrets", "/api/projects/p1/secrets"],
  );
});

test("execCollect concatenates chunks verbatim (server sends line + trailing \\n as two data fields)", async () => {
  const { calls, impl } = fakeFetch(
    sse(
      // Wire-faithful: axum encodes the chunk "line1\n" as two data: fields.
      'event: stdout\ndata: line1\ndata: \n\nevent: stderr\ndata: oops\ndata: \n\nevent: exit\ndata: {"code":3}\n\n',
    ),
  );
  const result = await makeClient(impl).vms.execCollect("web-1", { command: ["ls"] });
  assert.deepEqual(result, { stdout: "line1\n", stderr: "oops\n", exitCode: 3, timedOut: false });
  assert.equal(calls[0].init.headers.get("Accept"), "text/event-stream");
});

test("exec and execCollect report a command killed at its deadline as timedOut", async () => {
  const body = 'event: stdout\ndata: started\ndata: \n\nevent: exit\ndata: {"code":124,"timed_out":true}\n\n';
  const events = [];
  for await (const evt of makeClient(fakeFetch(sse(body)).impl).vms.exec("web-1", { command: ["sleep", "60"] })) {
    events.push(evt);
  }
  assert.deepEqual(events.at(-1), { kind: "exit", code: 124, timedOut: true });
  const result = await makeClient(fakeFetch(sse(body)).impl).vms.execCollect("web-1", { command: ["sleep", "60"] });
  assert.deepEqual(result, { stdout: "started\n", stderr: "", exitCode: 124, timedOut: true });
  // A command that exits 124 on its own is not a timeout.
  const own = 'event: exit\ndata: {"code":124,"timed_out":false}\n\n';
  const ownResult = await makeClient(fakeFetch(sse(own)).impl).vms.execCollect("web-1", { command: ["false"] });
  assert.deepEqual(ownResult, { stdout: "", stderr: "", exitCode: 124, timedOut: false });
});

test("exec and execCollect send cwd, env, user and login; a plain exec sends none of them", async () => {
  const exit = 'event: exit\ndata: {"code":0}\n\n';
  const opts = {
    command: ["gh", "--version"],
    timeoutSecs: 10,
    cwd: "/srv/app",
    env: { GH_TOKEN: "t0k", LANG: "C.UTF-8" },
    user: "builder",
    login: true,
  };
  const wire = {
    command: ["gh", "--version"],
    timeout_secs: 10,
    cwd: "/srv/app",
    env: { GH_TOKEN: "t0k", LANG: "C.UTF-8" },
    user: "builder",
    login: true,
  };
  const streamed = fakeFetch(sse(exit));
  for await (const _evt of makeClient(streamed.impl).vms.exec("web-1", opts)) void _evt;
  assert.deepEqual(JSON.parse(streamed.calls[0].init.body), wire);
  const collected = fakeFetch(sse(exit));
  await makeClient(collected.impl).vms.execCollect("web-1", opts);
  assert.deepEqual(JSON.parse(collected.calls[0].init.body), wire);
  // An exec without options keeps the old body, so a pre-v9 guest agent still runs it.
  const plain = fakeFetch(sse(exit));
  await makeClient(plain.impl).vms.execCollect("web-1", { command: ["ls"] });
  assert.deepEqual(JSON.parse(plain.calls[0].init.body), { command: ["ls"] });
  const loginFalse = fakeFetch(sse(exit));
  await makeClient(loginFalse.impl).vms.execCollect("web-1", { command: ["ls"], login: false });
  assert.deepEqual(JSON.parse(loginFalse.calls[0].init.body), { command: ["ls"] });
});

/** A `/api/whoami` answer from a server speaking API `version` (none: no header). */
const whoamiAt = (version) => () =>
  new Response(JSON.stringify({ username: "u" }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(version ? { "x-cove-api-version": version } : {}) },
  });

test("exec sends string stdin as text and bytes as base64", async () => {
  // Stdin first reads the server's version from /api/whoami (stdin needs 8).
  const exit = 'event: exit\ndata: {"code":0}\n\n';
  const text = fakeFetch(whoamiAt("8"), sse(exit));
  await makeClient(text.impl).vms.execCollect("web-1", { command: ["python3", "-"], stdin: "print(1+1)" });
  assert.equal(new URL(text.calls[0].url).pathname, "/api/whoami");
  assert.deepEqual(JSON.parse(text.calls[1].init.body), { command: ["python3", "-"], stdin: "print(1+1)" });
  // NUL and bytes that are not UTF-8 survive.
  const bytes = fakeFetch(whoamiAt("8"), sse(exit));
  for await (const _evt of makeClient(bytes.impl).vms.exec("web-1", {
    command: ["sha256sum"],
    stdin: new Uint8Array([0x00, 0xff, 0x80]),
  }))
    void _evt;
  assert.deepEqual(JSON.parse(bytes.calls[1].init.body), { command: ["sha256sum"], stdin_b64: "AP+A" });
  // Larger than one String.fromCharCode slice: decodes back exactly.
  const big = new Uint8Array(100_000).map((_, i) => i % 256);
  const large = fakeFetch(whoamiAt("8"), sse(exit));
  await makeClient(large.impl).vms.execCollect("web-1", { command: ["wc", "-c"], stdin: big });
  const sent = Buffer.from(JSON.parse(large.calls[1].init.body).stdin_b64, "base64");
  assert.deepEqual(new Uint8Array(sent), big);
  // An ArrayBuffer or another byte view is bytes too.
  const view = fakeFetch(whoamiAt("8"), sse(exit));
  await makeClient(view.impl).vms.execCollect("web-1", { command: ["x"], stdin: new Uint8Array([0, 255, 128]).buffer });
  assert.deepEqual(JSON.parse(view.calls[1].init.body), { command: ["x"], stdin_b64: "AP+A" });
  // Anything else is refused, not silently dropped.
  const none = fakeFetch(sse(exit));
  await assert.rejects(
    makeClient(none.impl).vms.execCollect("web-1", { command: ["x"], stdin: 42 }),
    TypeError,
  );
  assert.equal(none.calls.length, 0);
  // `null` is unset, as on every other optional field: no stdin, and no version read.
  const unset = fakeFetch(sse(exit));
  await makeClient(unset.impl).vms.execCollect("web-1", { command: ["x"], stdin: null });
  assert.equal(unset.calls.length, 1);
  assert.deepEqual(JSON.parse(unset.calls[0].init.body), { command: ["x"] });
});

test("exec refuses stdin against a server older than API version 8, sending nothing", async () => {
  // An API 7 server ignores stdin and would run the command on empty input.
  const exit = 'event: exit\ndata: {"code":0}\n\n';
  for (const [version, stdin] of [["7", "print(1)"], ["7", new Uint8Array([1])], [undefined, "x"]]) {
    const old = fakeFetch(whoamiAt(version), sse(exit));
    await assert.rejects(
      makeClient(old.impl).vms.execCollect("web-1", { command: ["python3", "-"], stdin }),
      (err) =>
        err instanceof CoveError &&
        /does not support exec stdin; upgrade the server to API 8 or later/.test(err.message) &&
        (version !== "7" || err.message.includes("this server (API 7) does not support exec stdin")),
    );
    assert.equal(old.calls.length, 1, "only the version read was sent");
    assert.equal(new URL(old.calls[0].url).pathname, "/api/whoami");
  }
  // An exec without stdin reads no version and runs against any server.
  const plain = fakeFetch(sse(exit));
  await makeClient(plain.impl).vms.execCollect("web-1", { command: ["ls"] });
  assert.equal(plain.calls.length, 1);
  assert.equal(EXEC_STDIN_MIN_API_VERSION, 8);
});

test("execCollect preserves partial chunks without inventing newlines", async () => {
  const { impl } = fakeFetch(
    sse('event: stdout\ndata: no-newline\n\nevent: exit\ndata: {"code":0}\n\n'),
  );
  const result = await makeClient(impl).vms.execCollect("web-1", { command: ["ls"] });
  assert.equal(result.stdout, "no-newline");
});

test("execCollect throws CoveError on error event", async () => {
  const { impl } = fakeFetch(sse('event: error\ndata: {"error":"agent gone"}\n\n'));
  await assert.rejects(
    makeClient(impl).vms.execCollect("web-1", { command: ["ls"] }),
    (err) => err instanceof CoveError && /agent gone/.test(err.message),
  );
});

test("audit.iter follows next_cursor across pages", async () => {
  const { calls, impl } = fakeFetch(
    json({ entries: [{ id: 1 }, { id: 2 }], next_cursor: "c2" }),
    json({ entries: [{ id: 3 }], next_cursor: null }),
  );
  const seen = [];
  for await (const entry of makeClient(impl).audit.iter({ limit: 2 })) seen.push(entry.id);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get("cursor"), "c2");
});

test("vms.iter follows next_cursor across pages", async () => {
  const { calls, impl } = fakeFetch(
    json({ vms: [{ name: "a" }, { name: "b" }], next_cursor: "c2" }),
    json({ vms: [{ name: "c" }], next_cursor: null }),
  );
  const seen = [];
  for await (const vm of makeClient(impl).vms.iter({ limit: 2 })) seen.push(vm.name);
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get("cursor"), "c2");
});

// Pinning the shared shape from the client side: `vms`, both checkpoint
// listings and `audit` are paged identically, so one generator shape reads all
// four. A future divergence fails here rather than accreting.
test("every paginated list takes limit/cursor and returns {rows, next_cursor}", async () => {
  const cases = [
    ["/api/vms", "vms", (c) => c.vms.iter({ limit: 1 })],
    ["/api/checkpoints", "checkpoints", (c) => c.checkpoints.iterAll({ limit: 1 })],
    [
      "/api/vms/web-1/checkpoints",
      "checkpoints",
      (c) => c.checkpoints.iterForVm("web-1", { limit: 1 }),
    ],
    ["/api/audit", "entries", (c) => c.audit.iter({ limit: 1 })],
  ];
  for (const [path, rowsField, iterate] of cases) {
    const { calls, impl } = fakeFetch(
      json({ [rowsField]: [{ id: "1" }], next_cursor: "nxt" }),
      json({ [rowsField]: [{ id: "2" }], next_cursor: null }),
    );
    const seen = [];
    for await (const row of iterate(makeClient(impl))) seen.push(row.id);
    assert.deepEqual(seen, ["1", "2"], `${path}: iter must span pages`);
    assert.equal(calls.length, 2, `${path}: expected two requests`);
    const first = new URL(calls[0].url);
    assert.equal(first.pathname, path);
    assert.equal(first.searchParams.get("limit"), "1", `${path}: limit must be sent`);
    assert.equal(first.searchParams.has("cursor"), false, `${path}: first page has no cursor`);
    assert.equal(
      new URL(calls[1].url).searchParams.get("cursor"),
      "nxt",
      `${path}: cursor must be echoed back`,
    );
  }
});

test("vms.list sends cursor, never offset", async () => {
  const { calls, impl } = fakeFetch(json({ vms: [], next_cursor: null }));
  await makeClient(impl).vms.list({ cursor: "abc", limit: 10 });
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("cursor"), "abc");
  assert.equal(url.searchParams.get("limit"), "10");
  assert.equal(
    url.searchParams.has("offset"),
    false,
    "offset pagination is retired — limit/cursor everywhere",
  );
});

test("timeoutMs attaches an abort signal when no explicit signal given", async () => {
  const { calls, impl } = fakeFetch(json([]));
  await makeClient(impl, { timeoutMs: 5000 }).vms.list();
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

/** A fake fetch that never answers — it only ever rejects when aborted. */
// A request that never settles on its own — every caller below ends it with
// either a deadline or an explicit abort. The keep-alive timer matters: the
// SDK unrefs its own deadline timer on purpose (a pending request must never
// be the reason a process stays alive), so without a ref'd handle here the
// event loop would drain and Node would cancel the test before the timeout or
// abort could fire. Cleared the moment the request settles.
const hangingFetch = (url, init) =>
  new Promise((_resolve, reject) => {
    const keepAlive = setInterval(() => {}, 1_000);
    const fail = () => {
      clearInterval(keepAlive);
      reject(init.signal.reason);
    };
    if (init.signal.aborted) fail();
    else init.signal.addEventListener("abort", fail, { once: true });
  });

test("dot and empty path segments are rejected, not sent", async () => {
  // `new URL()` strips dot segments after percent-decoding, so encoding is no
  // defence: `vms.delete("..")` would issue `DELETE /api/`, and
  // `secrets.vm("..").list()` would read the caller's own user-scoped secrets.
  const { calls, impl } = fakeFetch(empty());
  const client = makeClient(impl);
  const invalid = /Invalid path segment/;
  for (const bad of ["..", ".", ""]) {
    await assert.rejects(async () => client.vms.delete(bad), invalid);
    await assert.rejects(async () => client.secrets.vm(bad).list(), invalid);
    await assert.rejects(
      async () => client.secrets.vm("web-1").set(bad, { value_b64: "eA==" }),
      invalid,
    );
    await assert.rejects(async () => client.secrets.vm("web-1").unset(bad), invalid);
    await assert.rejects(
      async () => client.secrets.vm("web-1").rotate(bad, { value_b64: "eA==" }),
      invalid,
    );
  }
  assert.equal(calls.length, 0, "nothing should have reached the network");
});

test("names that only look like dot segments still work", async () => {
  const { calls, impl } = fakeFetch(empty());
  const client = makeClient(impl);
  for (const name of ["a/b", "..a", "..."]) await client.vms.delete(name);
  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname),
    ["/api/vms/a%2Fb", "/api/vms/..a", "/api/vms/..."],
  );
});

test("redirects are refused rather than followed with the credential attached", async () => {
  // Spec-compliant fetch strips a standard `Authorization` header cross-origin,
  // but not a custom `CoveAuth` header — and a caller-supplied fetch need strip
  // nothing. The Cove API never legitimately redirects.
  const { calls, impl } = fakeFetch(json([]));
  await makeClient(impl).vms.list();
  assert.equal(calls[0].init.redirect, "error");
});

test("timeoutMs is composed with a caller signal, not discarded by it", async () => {
  const caller = new AbortController(); // never fired
  await assert.rejects(
    makeClient(hangingFetch, { timeoutMs: 60 }).vms.list({}, { signal: caller.signal }),
    (err) => err instanceof CoveTimeoutError,
  );
});

test("a caller abort still wins when a timeout is also set", async () => {
  const caller = new AbortController();
  const pending = makeClient(hangingFetch, { timeoutMs: 10_000 }).vms.list(
    {},
    { signal: caller.signal },
  );
  caller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("an already-aborted caller signal fails the request immediately", async () => {
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(
    makeClient(hangingFetch, { timeoutMs: 10_000 }).vms.list({}, { signal: caller.signal }),
    { name: "AbortError" },
  );
});

test("a caller signal aborts a call that sets no deadline at all", async () => {
  const caller = new AbortController();
  const pending = makeClient(hangingFetch).vms.get("web-1", { signal: caller.signal });
  caller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("a per-call timeoutMs overrides the client-wide one", async () => {
  // The client default is long enough that only the override can be what fires.
  await assert.rejects(
    makeClient(hangingFetch, { timeoutMs: 60_000 }).vms.list({}, { timeoutMs: 40 }),
    (err) => err instanceof CoveTimeoutError && /40 ms/.test(err.message),
  );
});

test("a per-call timeoutMs applies when the client sets no default", async () => {
  await assert.rejects(
    makeClient(hangingFetch).vms.get("web-1", { timeoutMs: 40 }),
    (err) => err instanceof CoveTimeoutError,
  );
});

test("caller headers are merged in alongside the method's own params", async () => {
  const { calls, impl } = fakeFetch(json([]));
  await makeClient(impl).vms.list({ state: "running" }, { headers: { "X-Trace-Id": "t-1" } });
  assert.equal(new URL(calls[0].url).searchParams.get("state"), "running");
  assert.equal(calls[0].init.headers.get("X-Trace-Id"), "t-1");
});

test("caller headers cannot displace the SDK's own", async () => {
  // The credential, the API version and the content negotiation are protocol,
  // not caller-tunable — including under a different letter case, since
  // `Headers.set` matches names case-insensitively.
  const { calls, impl } = fakeFetch(json({ name: "x" }, 202));
  await makeClient(impl).vms.create(
    { image: "ubuntu" },
    {
      headers: {
        authorization: "Bearer stolen",
        Accept: "text/plain",
        "content-type": "text/plain",
        "X-Cove-Api-Version": "1",
      },
    },
  );
  const headers = calls[0].init.headers;
  assert.equal(headers.get("Authorization"), "Bearer cvk_x");
  assert.equal(headers.get("Accept"), "application/json");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get("X-Cove-Api-Version"), "8");
});

test("a malformed caller header is refused as a CoveError, not a bare TypeError", async () => {
  const { calls, impl } = fakeFetch(json([]));
  await assert.rejects(
    makeClient(impl).vms.list({}, { headers: { "X Trace": "1" } }),
    (err) => err instanceof CoveError && /Invalid request header "X Trace"/.test(err.message),
  );
  assert.equal(calls.length, 0, "nothing should have reached the network");
});

test("every apiPath template in the SDK is a path (and method) the server publishes", () => {
  // The gap that let two methods die quietly: the SDK had guards for scopes and
  // for error codes, and none for the one thing every call depends on. Two
  // `vms.ts` methods kept sending `/api/vms/{name}/share/invites` for the whole
  // of the route rename — the server had moved to `/vms/{name}/invites` and
  // asserts the old pair 404s on every listener — and all 89 tests passed.
  //
  // Reads the sources rather than calling the methods: a request path is built
  // from a tagged template, so exercising every method would mean constructing
  // every argument list, while the template literal itself is the fact worth
  // pinning.
  //
  // Found in review: the path-only check above this comment was blind to
  // the HTTP verb — `policies.ts` sent `PUT /api/vms/{name}/expiry` for the
  // whole life of the route (a guaranteed 405; the server only ever mounted
  // `POST` there) and this test still passed, because the *path* was right.
  // The method loop below closes that gap by pairing every `apiPath` template
  // that's the target of a `.request(...)` / `.requestSSE(...)` call with the
  // verb literal passed alongside it, and checking that pair against the verbs
  // the contract actually publishes for that exact path.
  const srcDir = fileURLToPath(new URL("../src/resources", import.meta.url));
  const yaml = readFileSync(
    fileURLToPath(new URL("../../openapi.yaml", import.meta.url)),
    "utf8",
  );
  // `paths:` keys -> the set of HTTP methods published under each, normalised
  // to the SDK's `${...}` interpolation form. `paths:` entries are 2-space
  // indented (`  /api/vms/{name}/expiry:`); the verbs nested under one are
  // 4-space indented (`    post:`).
  const methodsByPath = new Map();
  {
    let currentPath = null;
    for (const line of yaml.split("\n")) {
      const pathMatch = line.match(/^ {2}(\/[^\s:]*):$/);
      if (pathMatch) {
        currentPath = pathMatch[1].replace(/\{[^}]+\}/g, "${}");
        if (!methodsByPath.has(currentPath)) methodsByPath.set(currentPath, new Set());
        continue;
      }
      const methodMatch = currentPath && line.match(/^ {4}(get|head|post|put|patch|delete):$/);
      if (methodMatch) methodsByPath.get(currentPath).add(methodMatch[1].toUpperCase());
    }
  }
  const published = new Set(methodsByPath.keys());
  assert.ok(published.size > 100, `only ${published.size} paths parsed out of openapi.yaml`);

  const offenders = [];
  // Matches `.request("METHOD", apiPath`...`` / `.requestSSE(…)` / `.requestRaw(…)`,
  // across both single-line and wrapped-argument call sites (`\s` spans newlines).
  const methodCallPattern =
    /\.request(?:SSE|Raw)?(?:<(?:[^<>]|<[^<>]*>)*>)?\(\s*"(GET|HEAD|POST|PUT|PATCH|DELETE)"\s*,\s*apiPath`([^`]+)`/g;
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(`${srcDir}/${file}`, "utf8");
    for (const m of src.matchAll(/apiPath`([^`]+)`/g)) {
      // `${name}` / `${encodeURIComponent(x)}` → `${}`, and drop any query string.
      const path = m[1].replace(/\$\{[^}]*\}/g, "${}").split("?")[0];
      // Either a published path, or a prefix of one: `secrets.ts` builds a
      // scope base (`/api/users/${}`) and hands it to `SecretsScope`, which
      // appends the rest. A prefix that matches nothing is still an offender.
      const ok =
        published.has(path) ||
        [...published].some((p) => p.startsWith(`${path}/`));
      if (!ok) offenders.push(`${file}: ${m[1]} — path not in contract`);
    }
    for (const m of src.matchAll(methodCallPattern)) {
      const [, method, rawPath] = m;
      const path = rawPath.replace(/\$\{[^}]*\}/g, "${}").split("?")[0];
      const allowed = methodsByPath.get(path);
      // Only checked against an exact path match — a prefix (scope base) never
      // appears directly in a `.request(...)` call, so there is nothing to
      // resolve a verb against.
      if (allowed && !allowed.has(method)) {
        offenders.push(
          `${file}: ${method} ${rawPath} — contract publishes ${[...allowed].sort().join("/")} on this path, not ${method}`,
        );
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these SDK requests don't match the published contract — the route (or " +
      "its method) was renamed or removed and the SDK was not moved with it:\n  " +
      offenders.join("\n  "),
  );
});

test("SDK request-body field names exist in the published schema", () => {
  // The other half of the same class, in the request direction: `CreateVmRequest`
  // declared `suspend_policy` — with a comment asserting the server still wanted
  // that name — long after the server had moved to `auto_pause_policy`. Because
  // the field is optional with a default on both sides, the request kept
  // succeeding and the caller's policy was silently discarded. Same shape as the
  // `build_info` drop on the Rust side.
  //
  // The request types are generated now (src/generated/types.gen.ts), so this
  // guards the generator: a re-pin of @hey-api/openapi-ts that renames or drops a
  // request field fails here. Checked for the request types only: a response
  // type may legitimately omit fields the client does not use, but a request
  // field the server does not read is always a bug.
  const generated = readFileSync(
    fileURLToPath(new URL("../src/generated/types.gen.ts", import.meta.url)),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, ""); // doc comments may hold braces; drop them first
  const yaml = readFileSync(
    fileURLToPath(new URL("../../openapi.yaml", import.meta.url)),
    "utf8",
  );
  const schemasBlock = yaml.slice(yaml.indexOf("\n  schemas:\n"));
  const requestSchemas = [
    ...schemasBlock.matchAll(/^ {4}(\w*Request):$/gm),
  ].map((m) => m[1]);
  // Top-level fields of `export type <name> = { ... };`, by brace depth: hey-api
  // nests object literals, so a flat regex would stop at the first inner `}`.
  const topLevelFields = (start) => {
    const fields = [];
    let depth = 0;
    for (const line of generated.slice(start).split("\n")) {
      if (depth === 1) {
        const f = line.match(/^\s*(\w+)\??:/);
        if (f) fields.push(f[1]);
      }
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (depth === 0 && line.includes("}")) break;
    }
    return fields;
  };
  const offenders = [];
  const dropped = [];
  let checked = 0;
  for (const m of generated.matchAll(/^export type (\w*Request) = \{$/gm)) {
    const [, name] = m;
    const schema = yaml.match(new RegExp(`\\n {4}${name}:\\n((?: {6,}.*\\n|\\n)*)`));
    if (!schema) continue;
    const props = schema[1].match(/^ {6}properties:\n((?: {8,}.*\n|\n)*)/m);
    const declared = new Set(
      [...(props ? props[1] : "").matchAll(/^ {8}(\w+):$/gm)].map((p) => p[1]),
    );
    const fields = topLevelFields(m.index + m[0].length - 1);
    checked++;
    for (const f of fields) if (!declared.has(f)) offenders.push(`${name}.${f}`);
    for (const d of declared) if (!fields.includes(d)) dropped.push(`${name}.${d}`);
  }
  // Positive control: every `*Request` schema was found and scanned, so an
  // emitter change that stops matching the pattern cannot pass vacuously.
  assert.ok(requestSchemas.length > 0, "no *Request schemas found in sdk/openapi.yaml");
  assert.equal(checked, requestSchemas.length, `scanned ${checked} generated *Request types, contract has ${requestSchemas.length}`);
  assert.deepEqual(
    offenders,
    [],
    "these SDK request fields are not in the published schema — the server " +
      "will ignore them:\n  " + offenders.join("\n  "),
  );
  assert.deepEqual(dropped, [], "these published request fields are missing from the SDK's generated types:\n  " + dropped.join("\n  "));
});

test("streamConsole keeps its own params separate from its overrides", async () => {
  const { calls, impl } = fakeFetch(sse("event: console\ndata: boot\n\n"));
  const caller = new AbortController();
  const lines = [];
  for await (const line of makeClient(impl).vms.streamConsole(
    "web-1",
    { lines: 20 },
    { signal: caller.signal, headers: { "X-Trace-Id": "t-2" } },
  )) {
    lines.push(line);
  }
  assert.deepEqual(lines, ["boot"]);
  assert.equal(new URL(calls[0].url).searchParams.get("lines"), "20");
  assert.equal(calls[0].init.signal, caller.signal);
  assert.equal(calls[0].init.headers.get("X-Trace-Id"), "t-2");
});

test("execWithSecrets posts to /exec-with-secrets with no timeout_secs", async () => {
  const { calls, impl } = fakeFetch(json({ stdout: "ok\n", stderr: "", exit_code: 0 }));
  const out = await makeClient(impl).vms.execWithSecrets("web 1", {
    command: ["./deploy.sh"],
    selector: { kind: "all" },
  });
  assert.deepEqual(out, { stdout: "ok\n", stderr: "", exit_code: 0 });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(new URL(calls[0].url).pathname, "/api/vms/web%201/exec-with-secrets");
  assert.deepEqual(JSON.parse(calls[0].init.body), { command: ["./deploy.sh"], selector: { kind: "all" } });
});

test("execWithSecrets sends timeoutSecs as timeout_secs and returns timed_out", async () => {
  const { calls, impl } = fakeFetch(
    json({ stdout: "started\n", stderr: "", exit_code: 124, timed_out: true }),
  );
  const out = await makeClient(impl).vms.execWithSecrets("web", {
    command: ["sleep", "60"],
    selector: { kind: "all" },
    timeoutSecs: 5,
  });
  assert.equal(out.exit_code, 124);
  assert.equal(out.timed_out, true);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    command: ["sleep", "60"],
    selector: { kind: "all" },
    timeout_secs: 5,
  });
});

test("execWithInject is gone (clean removal, no alias)", async () => {
  const client = makeClient(fakeFetch(json({})).impl);
  assert.equal(client.vms.execWithInject, undefined);
});

test("http: baseUrl is refused unless loopback or allowInsecureHttp", () => {
  const f = fakeFetch(json({})).impl;
  assert.throws(() => new CoveClient({ baseUrl: "http://cove.example", token: "cvk_x", fetch: f }), (e) => e instanceof CoveError && /allowInsecureHttp/.test(e.message));
  for (const u of ["http://localhost:8080", "http://127.0.0.1", "http://127.9.9.9:1", "http://[::1]:8090"]) {
    assert.doesNotThrow(() => new CoveClient({ baseUrl: u, token: "cvk_x", fetch: f }), u);
  }
  assert.doesNotThrow(() => new CoveClient({ baseUrl: "http://cove.example", token: "cvk_x", fetch: f, allowInsecureHttp: true }));
  assert.throws(() => new CoveClient({ baseUrl: "http://localhost.evil.test", token: "cvk_x", fetch: f }));
});

test("CoveHttp sends rawBody untouched and never JSON-encodes it", async () => {
  const { CoveHttp } = await import("../dist/http.js");
  const { BearerAuth } = await import("../dist/index.js");
  const { calls, impl } = fakeFetch(json({}));
  const http = new CoveHttp({ baseUrl: "https://cove.test", auth: new BearerAuth("cvk_x"), fetch: impl });
  const blob = new Blob(["abc"]);
  await http.request("POST", "/api/x", {
    rawBody: blob,
    contentType: "application/x-custom",
    // The SDK's own Content-Type wins over a caller header, bytes or JSON.
    headers: { "content-type": "text/plain" },
  });
  assert.equal(calls[0].init.body, blob);
  assert.equal(calls[0].init.headers.get("Content-Type"), "application/x-custom");
});

test("CoveHttp defaults a rawBody's Content-Type to application/octet-stream", async () => {
  const { CoveHttp } = await import("../dist/http.js");
  const { BearerAuth } = await import("../dist/index.js");
  const { calls, impl } = fakeFetch(json({}));
  const http = new CoveHttp({ baseUrl: "https://cove.test", auth: new BearerAuth("cvk_x"), fetch: impl });
  const buf = new Uint8Array([1, 2, 3]).buffer;
  await http.request("POST", "/api/x", { rawBody: buf });
  assert.equal(calls[0].init.body, buf);
  assert.equal(calls[0].init.headers.get("Content-Type"), "application/octet-stream");
  // Positive control: a JSON body still goes out encoded, as application/json.
  await http.request("POST", "/api/x", { body: { a: 1 } });
  assert.equal(calls[1].init.body, '{"a":1}');
  assert.equal(calls[1].init.headers.get("Content-Type"), "application/json");
});

test("CoveHttp refuses body and rawBody together, before any request", async () => {
  const { CoveHttp } = await import("../dist/http.js");
  const { BearerAuth } = await import("../dist/index.js");
  const { calls, impl } = fakeFetch(json({}));
  const http = new CoveHttp({ baseUrl: "https://cove.test", auth: new BearerAuth("cvk_x"), fetch: impl });
  await assert.rejects(
    http.request("POST", "/api/x", { body: {}, rawBody: new Uint8Array([1]) }),
    (err) => err instanceof CoveError && /body.*rawBody|rawBody.*body/.test(err.message),
  );
  assert.equal(calls.length, 0, "nothing should have reached the network");
});

test("a bytes body is sent as-is with application/octet-stream", async () => {
  const { calls, impl } = fakeFetch(json({ updated: 0, failed: 0, results: [] }));
  const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
  await makeClient(impl).admin.updateVmAgents(bytes);
  assert.equal(calls[0].init.headers.get("Content-Type"), "application/octet-stream");
  assert.equal(calls[0].init.body, bytes);
});

test("every request call site builds its path with apiPath", () => {
  // A plain-string path is invisible to the contract scanners above and to
  // `tests/coverage.test.mjs`, which both key on `apiPath`. `SecretsScope`
  // builds its paths from a scope base with a template literal (never a
  // double-quoted string), so this pattern does not reach it.
  const dir = fileURLToPath(new URL("../src/resources", import.meta.url));
  const plain = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const src = readFileSync(`${dir}/${f}`, "utf8");
    for (const m of src.matchAll(/\.request(?:SSE|Raw)?(?:<(?:[^<>]|<[^<>]*>)*>)?\(\s*"[A-Z]+"\s*,\s*"([^"]*)"/g)) {
      plain.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(plain, []);
});

// ---------------------------------------------------------------------------
// Admin and service keys: the CreateKeyRequest fields go
// out under their wire names, with no translation layer.
// ---------------------------------------------------------------------------

const createdKey = {
  id: "01K0KEY",
  label: "ci",
  raw_token: "cvk_new",
  prefix: "cvk_new",
  scopes: ["admin:vms:read"],
  expires_at: "2026-10-31T00:00:00Z",
  created_at: "2026-10-01T00:00:00Z",
  admin_key: true,
};

test("keys.create sends admin_key verbatim, snake_case, and returns the key unchanged", async () => {
  const { calls, impl } = fakeFetch(json(createdKey, 201));
  const req = {
    label: "ci",
    scopes: ["admin:vms:read"],
    expires_in_secs: 7 * 86400,
    admin_key: true,
  };
  const out = await makeClient(impl).keys.create(req);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(new URL(calls[0].url).pathname, "/api/api-keys");
  assert.deepEqual(JSON.parse(calls[0].init.body), req);
  assert.deepEqual(out, createdKey);
});

test("keys.create sends a service key's service, team and member fields verbatim", async () => {
  // A service-key create first reads the server's version from /api/whoami
  // (service keys need 6); only the POSTs carry a body.
  const calls = [];
  const impl = async (url, init) => {
    if (new URL(url).pathname === "/api/whoami") {
      return new Response(JSON.stringify({ username: "admin" }), {
        status: 200,
        headers: { "Content-Type": "application/json", "x-cove-api-version": "6" },
      });
    }
    calls.push({ url, init });
    return json({ ...createdKey, admin_key: false }, 201)();
  };
  const teamBound = {
    label: "svc",
    service: "deployer",
    team: "platform",
    scopes: ["vms:read", "vms:write"],
    expires_in_secs: 30 * 86400,
  };
  await makeClient(impl).keys.create(teamBound);
  assert.deepEqual(JSON.parse(calls[0].init.body), teamBound);

  const memberBound = { label: "svc", service: "deployer", member: "alice", expires_in_secs: 86400 };
  await makeClient(impl).keys.create(memberBound);
  assert.deepEqual(JSON.parse(calls[1].init.body), memberBound);
  // No camelCase twin goes out beside the wire names.
  for (const call of calls) {
    assert.doesNotMatch(call.init.body, /adminKey|expiresInSecs/);
  }
});
