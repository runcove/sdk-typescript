// A `timeoutMs` deadline surfaces as `CoveTimeoutError` (a `CoveConnectionError`,
// so a `CoveError`) with the platform `DOMException` as `cause`; a caller's own
// abort stays an `AbortError`; every configuration refusal is one `CoveConfigError`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as sdk from "../dist/index.js";

const { CoveClient, CoveConfigError, CoveConnectionError, CoveError, CoveTimeoutError } = sdk;
const { BearerAuth, TicketAuth, resolveAuth } = sdk;

const hangingFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    const keepAlive = setInterval(() => {}, 1_000);
    const fail = () => {
      clearInterval(keepAlive);
      reject(init.signal.reason);
    };
    if (init.signal.aborted) fail();
    else init.signal.addEventListener("abort", fail, { once: true });
  });

/** Headers arrive at once; the body then hangs until the request signal aborts. */
const hangingBodyFetch = (_url, init) => {
  const body = new ReadableStream({
    start(controller) {
      // Keeps the event loop alive: the SDK's deadline timer is unref'd on purpose.
      const keepAlive = setInterval(() => {}, 1_000);
      init.signal.addEventListener(
        "abort",
        () => {
          clearInterval(keepAlive);
          controller.error(init.signal.reason);
        },
        { once: true },
      );
    },
  });
  return Promise.resolve(
    new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
  );
};

const makeClient = (fetchImpl, extra = {}) =>
  new CoveClient({ baseUrl: "https://cove.test/", token: "cvk_x", fetch: fetchImpl, ...extra });

function isDeadline(err) {
  assert.ok(err instanceof CoveTimeoutError, `CoveTimeoutError, got ${err?.name}`);
  assert.ok(err instanceof CoveConnectionError);
  assert.ok(err instanceof CoveError);
  assert.equal(err.name, "CoveTimeoutError");
  assert.ok(err.cause instanceof DOMException, "cause is the DOMException");
  assert.equal(err.cause.name, "TimeoutError");
  return true;
}

test("unit_ a per-call timeoutMs deadline is a CoveTimeoutError", async () => {
  await assert.rejects(makeClient(hangingFetch).vms.get("web-1", { timeoutMs: 30 }), isDeadline);
});

test("unit_ a client-wide timeoutMs deadline is a CoveTimeoutError", async () => {
  await assert.rejects(makeClient(hangingFetch, { timeoutMs: 30 }).vms.list(), isDeadline);
});

test("unit_ execWithSecrets with a timeoutMs deadline is a CoveTimeoutError", async () => {
  await assert.rejects(
    makeClient(hangingFetch).vms.execWithSecrets(
      "web-1",
      { command: ["sleep", "5"], selector: { kind: "all" } },
      { timeoutMs: 30 },
    ),
    isDeadline,
  );
});

test("unit_ a deadline that fires while the body is read is a CoveTimeoutError", async () => {
  await assert.rejects(makeClient(hangingBodyFetch).vms.get("web-1", { timeoutMs: 30 }), isDeadline);
});

/** A 500 whose body hangs until the request signal aborts. */
const hangingErrorBodyFetch = (url, init) =>
  hangingBodyFetch(url, init).then((r) => new Response(r.body, { status: 500 }));

test("unit_ a deadline that fires while an error body is read is a CoveTimeoutError", async () => {
  await assert.rejects(
    makeClient(hangingErrorBodyFetch).vms.get("web-1", { timeoutMs: 30 }),
    isDeadline,
  );
});

test("unit_ a stream's deadline covers its error body too", async () => {
  await assert.rejects(
    makeClient(hangingErrorBodyFetch).vms.execCollect(
      "web-1",
      { command: ["ls"] },
      { timeoutMs: 30 },
    ),
    isDeadline,
  );
});

test("unit_ a stream's header wait deadline is a CoveTimeoutError", async () => {
  await assert.rejects(
    makeClient(hangingFetch).vms.execCollect("web-1", { command: ["ls"] }, { timeoutMs: 30 }),
    isDeadline,
  );
});

test("unit_ a caller abort stays an AbortError, deadline set or not", async () => {
  for (const extra of [{}, { timeoutMs: 10_000 }]) {
    const caller = new AbortController();
    const pending = makeClient(hangingFetch, extra).vms.get("web-1", { signal: caller.signal });
    caller.abort();
    await assert.rejects(pending, (err) => {
      assert.equal(err.name, "AbortError");
      assert.ok(!(err instanceof CoveError));
      return true;
    });
  }
});

test("unit_ a caller's own AbortSignal.timeout is theirs, not the SDK deadline", async () => {
  // Same DOMException name as the SDK deadline; told apart by who fired first.
  await assert.rejects(
    makeClient(hangingFetch, { timeoutMs: 10_000 }).vms.get("web-1", {
      signal: AbortSignal.timeout(30),
    }),
    (err) => err.name === "TimeoutError" && !(err instanceof CoveError),
  );
});

test("unit_ a caller abort during the body read stays an AbortError", async () => {
  const caller = new AbortController();
  const pending = makeClient(hangingBodyFetch, { timeoutMs: 10_000 }).vms.get("web-1", {
    signal: caller.signal,
  });
  setTimeout(() => caller.abort(), 20);
  await assert.rejects(pending, { name: "AbortError" });
});

test("unit_ no credential is a CoveConfigError", () => {
  const f = async () => new Response("[]");
  assert.throws(() => new CoveClient({ baseUrl: "https://cove.test", fetch: f }), (e) => {
    assert.ok(e instanceof CoveConfigError && e instanceof CoveError);
    assert.ok(!(e instanceof CoveConnectionError));
    assert.equal(e.name, "CoveConfigError");
    return true;
  });
  assert.throws(() => resolveAuth({}), CoveConfigError);
});

test("unit_ both token and ticket is a CoveConfigError", () => {
  const f = async () => new Response("[]");
  assert.throws(
    () => new CoveClient({ baseUrl: "https://cove.test", token: "a", ticket: "b", fetch: f }),
    CoveConfigError,
  );
});

test("unit_ a plain-http non-loopback baseUrl is a CoveConfigError", () => {
  const f = async () => new Response("[]");
  assert.throws(
    () => new CoveClient({ baseUrl: "http://cove.example", token: "cvk_x", fetch: f }),
    (e) => e instanceof CoveConfigError && /allowInsecureHttp/.test(e.message),
  );
});

test("unit_ a malformed or non-http(s) baseUrl is a CoveConfigError", () => {
  const f = async () => new Response("[]");
  for (const baseUrl of ["not a url", "", "ftp://cove.example", "localhost:8080", "https://"]) {
    assert.throws(
      () => new CoveClient({ baseUrl, token: "cvk_x", fetch: f }),
      (e) => e instanceof CoveConfigError && /baseUrl/.test(e.message),
      `baseUrl ${JSON.stringify(baseUrl)}`,
    );
  }
});

test("unit_ an empty token or ticket is a CoveConfigError", () => {
  assert.throws(() => new BearerAuth(""), CoveConfigError);
  assert.throws(() => new TicketAuth(""), CoveConfigError);
});

test("unit_ a deadline on the service-key version probe is a CoveTimeoutError", async () => {
  await assert.rejects(
    makeClient(hangingFetch).keys.create(
      { label: "l", service: "ci", team: "eng", expires_in_secs: 60 },
      { timeoutMs: 30 },
    ),
    isDeadline,
  );
});

test("unit_ a caller abort on the service-key version probe stays an AbortError", async () => {
  const caller = new AbortController();
  const pending = makeClient(hangingFetch).keys.create(
    { label: "l", service: "ci", team: "eng", expires_in_secs: 60 },
    { signal: caller.signal },
  );
  caller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
