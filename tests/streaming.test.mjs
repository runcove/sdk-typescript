// Stream lifecycle: a deadline must not cut a stream short, an abandoned stream
// must be cancelled, and a failure mid-stream must stay inside the CoveError
// contract. These are the paths a fake fetch returning a whole body never hits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CoveClient, CoveConnectionError, CoveError, CoveTimeoutError, parseSSE } from "../dist/index.js";

const enc = new TextEncoder();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeClient(fetchImpl, extra = {}) {
  return new CoveClient({
    baseUrl: "https://cove.test",
    token: "cvk_x",
    fetch: fetchImpl,
    ...extra,
  });
}

const sseResponse = (body) =>
  new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });

/** Collect every event a stream yields. */
async function collect(body) {
  const events = [];
  for await (const evt of parseSSE(body)) events.push(evt);
  return events;
}

/**
 * A fake fetch whose body arrives in timed chunks and, like a real one, errors
 * if the request's signal aborts mid-stream.
 */
function drippingFetch(chunks, gapMs) {
  return async (_url, init) => {
    const { signal } = init;
    return sseResponse(
      new ReadableStream({
        async start(controller) {
          for (const chunk of chunks) {
            await delay(gapMs);
            if (signal?.aborted) {
              controller.error(signal.reason ?? new Error("aborted"));
              return;
            }
            controller.enqueue(enc.encode(chunk));
          }
          controller.close();
        },
      }),
    );
  };
}

/** A fake fetch that never answers — it only ever rejects when aborted. */
// Never settles on its own — callers end it with a deadline or an abort. The
// ref'd timer is load-bearing: the SDK unrefs its deadline timer by design (a
// pending request must never keep a process alive), so without a ref'd handle
// the event loop drains and Node cancels the test before the abort lands.
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

test("timeoutMs does not kill a stream that outlives it", async () => {
  // An abort signal stays bound to the response body after the headers arrive,
  // so a whole-request deadline is a wall clock on the stream: with a 30 s
  // timeout, `exec` or streaming commands could not run for 31 s, and
  // `streamConsole` could never tail indefinitely.
  const impl = drippingFetch(
    ["event: stdout\ndata: slow\n\n", 'event: exit\ndata: {"code":0}\n\n'],
    120,
  );
  const result = await makeClient(impl, { timeoutMs: 50 }).vms.execCollect("web-1", {
    command: ["sleep", "1"],
  });
  assert.deepEqual(result, { stdout: "slow", stderr: "", exitCode: 0, timedOut: false });
});

test("timeoutMs still bounds the wait for a stream's headers", async () => {
  await assert.rejects(
    makeClient(hangingFetch, { timeoutMs: 60 }).vms.execCollect("web-1", { command: ["ls"] }),
    (err) => err instanceof CoveTimeoutError,
  );
});

test("a per-call timeoutMs does not kill a stream either", async () => {
  // The disarm-on-headers rule has to hold for an override too, or raising the
  // deadline on one long call would be the thing that severs its stream.
  const impl = drippingFetch(
    ["event: stdout\ndata: slow\n\n", 'event: exit\ndata: {"code":0}\n\n'],
    120,
  );
  const result = await makeClient(impl).vms.execCollect(
    "web-1",
    { command: ["sleep", "1"] },
    { timeoutMs: 50 },
  );
  assert.deepEqual(result, { stdout: "slow", stderr: "", exitCode: 0, timedOut: false });
});

test("a per-call timeoutMs still bounds the wait for a stream's headers", async () => {
  await assert.rejects(
    makeClient(hangingFetch).vms.execCollect("web-1", { command: ["ls"] }, { timeoutMs: 60 }),
    (err) => err instanceof CoveTimeoutError,
  );
});

test("an abandoned stream cancels the response body", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      // The server holds the stream open; only a cancel closes the request.
      controller.enqueue(enc.encode("event: stdout\ndata: one\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  for await (const _evt of parseSSE(body)) break;
  assert.equal(cancelled, true);
});

test("exec cancels the body after the terminal event", async () => {
  // `exec` returns on `exit` while the server is still streaming. Without a
  // cancel the server never sees the request close and leaks an SSE task plus a
  // broadcast receiver per call.
  let cancelled = false;
  const impl = async () =>
    sseResponse(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            enc.encode('event: stdout\ndata: hi\n\nevent: exit\ndata: {"code":0}\n\n'),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  const result = await makeClient(impl).vms.execCollect("web-1", { command: ["ls"] });
  assert.equal(result.exitCode, 0);
  assert.equal(cancelled, true);
});

test("a transport failure mid-stream surfaces as a CoveError", async () => {
  // One event, then the socket goes away — `undici` surfaces that as a bare
  // `TypeError: terminated` out of `reader.read()`.
  let reads = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(enc.encode("event: stdout\ndata: partial\n\n"));
      else controller.error(new TypeError("terminated"));
    },
  });
  const seen = [];
  await assert.rejects(
    (async () => {
      for await (const evt of parseSSE(body)) seen.push(evt);
    })(),
    (err) => err instanceof CoveConnectionError && /terminated/.test(err.message),
  );
  assert.deepEqual(seen, [{ event: "stdout", data: "partial" }]);
});

test("an abort mid-stream passes through unwrapped", async () => {
  const aborted = new Error("The operation was aborted");
  aborted.name = "AbortError";
  const body = new ReadableStream({
    start(controller) {
      controller.error(aborted);
    },
  });
  await assert.rejects(collect(body), { name: "AbortError" });
});

test("a truncated terminal event throws a CoveError naming the event", async () => {
  const impl = async () => sseResponse('event: exit\ndata: {"code":');
  await assert.rejects(
    makeClient(impl).vms.execCollect("web-1", { command: ["ls"] }),
    (err) =>
      err instanceof CoveError &&
      /Malformed `exit` event/.test(err.message) &&
      err.message.includes('{"code":'),
  );
});

test("a truncated `paused` event names itself too", async () => {
  const impl = async () => sseResponse("event: paused\ndata: {oops");
  await assert.rejects(
    makeClient(impl).vms.execCollect("web-1", { command: ["ls"] }),
    /Malformed `paused` event/,
  );
});

/** A caller signal that counts the `abort` listeners still attached to it. */
function countedSignal() {
  const ac = new AbortController();
  const live = new Set();
  const add = ac.signal.addEventListener.bind(ac.signal);
  const remove = ac.signal.removeEventListener.bind(ac.signal);
  ac.signal.addEventListener = (type, fn, opts) => {
    if (type === "abort") {
      live.add(fn);
      if (opts?.once) add(type, () => live.delete(fn), { once: true });
    }
    return add(type, fn, opts);
  };
  ac.signal.removeEventListener = (type, fn, opts) => {
    if (type === "abort") live.delete(fn);
    return remove(type, fn, opts);
  };
  return { ac, live };
}

test("exec and streamConsole release the caller's signal when the stream ends", async () => {
  const client = makeClient(
    async () => sseResponse('event: stdout\ndata: hi\n\nevent: exit\ndata: {"code":0}\n\n'),
    { timeoutMs: 5000 },
  );
  const { ac, live } = countedSignal();
  for (let i = 0; i < 5; i++) {
    const result = await client.vms.execCollect("web-1", { command: ["ls"] }, { signal: ac.signal });
    assert.equal(result.stdout, "hi");
  }
  assert.equal(live.size, 0, "exec left abort listeners behind");

  const consoleClient = makeClient(
    async () => sseResponse("event: console\ndata: line 1\n\nevent: console\ndata: line 2\n\n"),
    { timeoutMs: 5000 },
  );
  // Drained to the end, and left early.
  const lines = [];
  for await (const line of consoleClient.vms.streamConsole("web-1", {}, { signal: ac.signal })) {
    lines.push(line);
  }
  assert.deepEqual(lines, ["line 1", "line 2"]);
  for await (const _line of consoleClient.vms.streamConsole("web-1", {}, { signal: ac.signal })) break;
  assert.equal(live.size, 0, "streamConsole left abort listeners behind");
});

test("a stream that fails mid-way releases the caller's signal", async () => {
  const client = makeClient(
    async () =>
      sseResponse(
        new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode("event: stdout\ndata: partial\n\n"));
            controller.error(new TypeError("terminated"));
          },
        }),
      ),
    { timeoutMs: 5000 },
  );
  const { ac, live } = countedSignal();
  await assert.rejects(
    client.vms.execCollect("web-1", { command: ["ls"] }, { signal: ac.signal }),
    (err) => err instanceof CoveConnectionError,
  );
  assert.equal(ac.signal.aborted, false);
  assert.equal(live.size, 0, "the failed stream kept its listener");
});
