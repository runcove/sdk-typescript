// `client.events`: the three server event streams as async iterators that
// reconnect across the server's clean 300 s close. Every response here is a
// fake: a finite SSE body ends the way the server's deadline ends a stream (a
// clean end of body), and a hanging one is ended only by the caller's signal.
// No real network, no real timers beyond the pacing test's one-second wait.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CoveClient, CoveError, NotFoundError } from "../dist/index.js";

const enc = new TextEncoder();

/** A finite SSE body: the frames, then a clean end (the server's 300 s close). */
const sse = (text) => () =>
  new Response(enc.encode(text), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });

/** An SSE body that sends `text` and then stays open until the request's signal aborts. */
const hanging = (text) => (init) =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(text));
        init.signal.addEventListener("abort", () => c.error(init.signal.reason), { once: true });
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

const json = (body, status) => () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Fake fetch replaying `responses` in order; it fails the test if called more often. */
function fakeFetch(...responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, at: performance.now() });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch #${calls.length} to ${url}`);
    return next(init);
  };
  return { calls, impl };
}

const makeClient = (fetchImpl) =>
  new CoveClient({ baseUrl: "https://cove.test/", token: "cvk_x", fetch: fetchImpl });

const lifecycleFrame = (kind, id) =>
  `event: connected\ndata: {}\n\n` +
  `event: lifecycle\nid: ${id}\ndata: ${JSON.stringify({
    kind,
    vm_id: "0190-vm",
    vm_name: "vm-a",
    actor: { kind: "user", username: "alice", source: "ssh" },
    at: "2026-10-01T10:00:00+00:00",
    payload: { added: ["k=v"] },
  })}\n\n`;

/** Take `n` items from an async iterator, then leave it (as a consumer's `break` would). */
async function take(iter, n) {
  const out = [];
  for await (const item of iter) {
    out.push(item);
    if (out.length === n) break;
  }
  return out;
}

test("reconnects after a clean close, then yields a `reconnected` marker", async () => {
  const { calls, impl } = fakeFetch(
    sse(lifecycleFrame("vm.created", "e-1")),
    sse(lifecycleFrame("vm.tags.changed", "e-2")),
  );
  const out = await take(makeClient(impl).events.lifecycle({ reconnectMinIntervalMs: 0 }), 3);
  assert.deepEqual(
    out.map((e) => e.kind),
    ["lifecycle", "reconnected", "lifecycle"],
  );
  assert.equal(out[0].event.kind, "vm.created");
  assert.equal(out[0].event.vm_name, "vm-a");
  assert.deepEqual(out[0].event.actor, { kind: "user", username: "alice", source: "ssh" });
  assert.deepEqual(out[0].event.payload, { added: ["k=v"] });
  assert.equal(out[2].event.kind, "vm.tags.changed");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.init.method, "GET");
    assert.equal(new URL(call.url).pathname, "/api/lifecycle-events");
    assert.equal(new Headers(call.init.headers).get("accept"), "text/event-stream");
  }
});

test("`reconnect: false` ends the iterator at the clean close", async () => {
  const { calls, impl } = fakeFetch(sse(lifecycleFrame("vm.created", "e-1")));
  const out = [];
  for await (const e of makeClient(impl).events.lifecycle({ reconnect: false })) out.push(e);
  assert.deepEqual(
    out.map((e) => e.kind),
    ["lifecycle"],
  );
  assert.equal(calls.length, 1);
});

test("a non-2xx on reconnect throws the typed error and stops", async () => {
  const { calls, impl } = fakeFetch(
    sse(`event: state\ndata: {"state":"running","timestamp":"2026-10-01T10:00:00Z"}\n\n`),
    json({ code: "vm_not_found", message: "no such VM" }, 404),
  );
  const seen = [];
  await assert.rejects(
    (async () => {
      for await (const e of makeClient(impl).events.vm("vm-a", { reconnectMinIntervalMs: 0 })) {
        seen.push(e.kind);
      }
    })(),
    NotFoundError,
  );
  // No `reconnected` marker: the reconnect never succeeded.
  assert.deepEqual(seen, ["state"]);
  assert.equal(calls.length, 2);
});

test("abort ends it without an error of the SDK's own: the AbortError passes through, no further call", async () => {
  const ac = new AbortController();
  const { calls, impl } = fakeFetch(
    sse(lifecycleFrame("vm.created", "e-1")),
    hanging(lifecycleFrame("vm.started", "e-2")),
  );
  const seen = [];
  await assert.rejects(
    (async () => {
      for await (const e of makeClient(impl).events.lifecycle({
        signal: ac.signal,
        reconnectMinIntervalMs: 0,
      })) {
        seen.push(e.kind);
        if (seen.length === 3) ac.abort();
      }
    })(),
    (err) => err.name === "AbortError",
  );
  assert.deepEqual(seen, ["lifecycle", "reconnected", "lifecycle"]);
  assert.equal(calls.length, 2);
});

test("abort during the pacing wait ends it before the next connect", async () => {
  const ac = new AbortController();
  const { calls, impl } = fakeFetch(sse(lifecycleFrame("vm.created", "e-1")));
  const started = performance.now();
  await assert.rejects(
    (async () => {
      for await (const e of makeClient(impl).events.lifecycle({
        signal: ac.signal,
        reconnectMinIntervalMs: 60_000,
      })) {
        assert.equal(e.kind, "lifecycle");
        setTimeout(() => ac.abort(), 20);
      }
    })(),
    (err) => err.name === "AbortError",
  );
  assert.equal(calls.length, 1);
  assert.ok(performance.now() - started < 5_000, "the wait did not end on abort");
});

test("`lagged` frames are yielded as {kind: \"lagged\", skipped}", async () => {
  const { impl } = fakeFetch(
    sse(
      `event: connected\ndata: {"vm_count":2}\n\n` +
        `event: lagged\ndata: {"skipped":7}\n\n` +
        `event: vm-update\ndata: {"vm_name":"vm-a","state":"stopped","event_type":"vm-update"}\n\n`,
    ),
  );
  const out = [];
  for await (const e of makeClient(impl).events.all({ reconnect: false })) out.push(e);
  assert.deepEqual(out, [
    { kind: "lagged", skipped: 7 },
    { kind: "vm-update", vm_name: "vm-a", state: "stopped", event_type: "vm-update" },
  ]);
});

test("events.all maps each VM frame, and reads /api/vms/events", async () => {
  const { calls, impl } = fakeFetch(
    sse(
      `event: vm-created\ndata: {"vm_name":"vm-b","state":"running","event_type":"vm-created"}\n\n` +
        `event: vm-deleted\ndata: {"vm_name":"vm-c","state":"deleted","event_type":"vm-deleted"}\n\n` +
        `: keep-alive\n\n`,
    ),
  );
  const out = [];
  for await (const e of makeClient(impl).events.all({ reconnect: false })) out.push(e);
  assert.deepEqual(out, [
    { kind: "vm-created", vm_name: "vm-b", state: "running", event_type: "vm-created" },
    { kind: "vm-deleted", vm_name: "vm-c", state: "deleted", event_type: "vm-deleted" },
  ]);
  assert.equal(new URL(calls[0].url).pathname, "/api/vms/events");
});

test("events.vm maps state, progress and error, and encodes the VM name", async () => {
  const { calls, impl } = fakeFetch(
    sse(
      `event: state\ndata: {"state":"creating","timestamp":"2026-10-01T10:00:00Z"}\n\n` +
        `event: progress\ndata: {"stage":"booting","message":"booting"}\n\n` +
        `event: error\ndata: {"stage":"Failed","message":"no capacity"}\n\n`,
    ),
  );
  const out = [];
  for await (const e of makeClient(impl).events.vm("a b", { reconnect: false })) out.push(e);
  assert.deepEqual(out, [
    { kind: "state", state: "creating", timestamp: "2026-10-01T10:00:00Z" },
    { kind: "progress", stage: "booting", message: "booting" },
    { kind: "error", stage: "Failed", message: "no capacity" },
  ]);
  assert.equal(new URL(calls[0].url).pathname, "/api/vms/a%20b/events");
});

// The server ends the per-VM stream on purpose after `state: deleted` and after
// a failed create's `error` (the name is free again, so a later VM under it is
// a different VM). The fake would answer a reconnect with 404, which the old
// behaviour threw as NotFoundError; `fakeFetch` fails the test on any further
// call it was not given a response for.
for (const [what, frame, last] of [
  [
    "a `state` of `deleted`",
    `event: state\ndata: {"state":"deleted","timestamp":"2026-10-01T10:01:00Z"}\n\n`,
    { kind: "state", state: "deleted", timestamp: "2026-10-01T10:01:00Z" },
  ],
  [
    "an `error` (failed create)",
    `event: error\ndata: {"stage":"Failed","message":"no capacity"}\n\n`,
    { kind: "error", stage: "Failed", message: "no capacity" },
  ],
]) {
  test(`events.vm ends after ${what}: no reconnect, nothing thrown`, async () => {
    const { calls, impl } = fakeFetch(
      sse(`event: state\ndata: {"state":"running","timestamp":"2026-10-01T10:00:00Z"}\n\n` + frame),
      json({ error: "not found" }, 404),
    );
    const out = [];
    for await (const e of makeClient(impl).events.vm("web-1", { reconnectMinIntervalMs: 0 })) out.push(e);
    assert.deepEqual(out, [{ kind: "state", state: "running", timestamp: "2026-10-01T10:00:00Z" }, last]);
    assert.equal(calls.length, 1);
  });

  test(`events.vm ends at ${what} even while the body is still open, and cancels it`, async () => {
    let cancelled = false;
    const { calls, impl } = fakeFetch(
      (init) =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode(frame));
              init.signal.addEventListener("abort", () => c.error(init.signal.reason), { once: true });
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    // A referenced timer: if the iterator waited on the open body, this aborts
    // it and fails this test alone, rather than node finding an empty event
    // loop and cancelling the rest of the file.
    const ac = new AbortController();
    const guard = setTimeout(() => ac.abort(new Error("events.vm kept waiting on the open body")), 2000);
    const out = [];
    try {
      for await (const e of makeClient(impl).events.vm("web-1", { reconnectMinIntervalMs: 0, signal: ac.signal })) {
        out.push(e);
      }
    } finally {
      clearTimeout(guard);
    }
    assert.deepEqual(out, [last]);
    assert.equal(calls.length, 1);
    assert.ok(cancelled, "the body was not cancelled");
  });
}

test("events.vm does not end on any other state", async () => {
  const { calls, impl } = fakeFetch(
    sse(`event: state\ndata: {"state":"stopped","timestamp":"2026-10-01T10:00:00Z"}\n\n`),
    sse(`event: state\ndata: {"state":"running","timestamp":"2026-10-01T10:00:01Z"}\n\n`),
  );
  const out = await take(makeClient(impl).events.vm("web-1", { reconnectMinIntervalMs: 0 }), 3);
  assert.deepEqual(
    out.map((e) => e.state ?? e.kind),
    ["stopped", "reconnected", "running"],
  );
  assert.equal(calls.length, 2);
});

// Unlike `events.vm`, which ends at its VM's deletion, the firehose streams
// carry every VM: a deletion is one more event, and the stream goes on.
test("events.all does not end at a `vm-deleted` frame: it reconnects at the clean close", async () => {
  const { calls, impl } = fakeFetch(
    sse(`event: vm-deleted\ndata: {"vm_name":"vm-c","state":"deleted","event_type":"vm-deleted"}\n\n`),
    sse(`event: vm-created\ndata: {"vm_name":"vm-d","state":"running","event_type":"vm-created"}\n\n`),
  );
  const out = await take(makeClient(impl).events.all({ reconnectMinIntervalMs: 0 }), 3);
  assert.deepEqual(out, [
    { kind: "vm-deleted", vm_name: "vm-c", state: "deleted", event_type: "vm-deleted" },
    { kind: "reconnected" },
    { kind: "vm-created", vm_name: "vm-d", state: "running", event_type: "vm-created" },
  ]);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(new URL(call.url).pathname, "/api/vms/events");
});

test("events.lifecycle does not end at a `vm.deleted` event: it reconnects at the clean close", async () => {
  const { calls, impl } = fakeFetch(
    sse(lifecycleFrame("vm.deleted", "e-1")),
    sse(lifecycleFrame("vm.created", "e-2")),
  );
  const out = await take(makeClient(impl).events.lifecycle({ reconnectMinIntervalMs: 0 }), 3);
  assert.deepEqual(
    out.map((e) => e.event?.kind ?? e.kind),
    ["vm.deleted", "reconnected", "vm.created"],
  );
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(new URL(call.url).pathname, "/api/lifecycle-events");
});

test("an invalid reconnectMinIntervalMs throws a CoveError at the call, before any connect", () => {
  const { calls, impl } = fakeFetch();
  const client = makeClient(impl);
  for (const bad of [NaN, -1, Infinity, -Infinity, "1000"]) {
    assert.throws(() => client.events.lifecycle({ reconnectMinIntervalMs: bad }), CoveError, String(bad));
    assert.throws(() => client.events.vm("web-1", { reconnectMinIntervalMs: bad }), CoveError, String(bad));
    assert.throws(() => client.events.all({ reconnectMinIntervalMs: bad }), CoveError, String(bad));
  }
  assert.equal(calls.length, 0);
});

test("reconnects are at most one per second by default", { timeout: 5000 }, async () => {
  const { calls, impl } = fakeFetch(
    sse(lifecycleFrame("vm.created", "e-1")),
    sse(lifecycleFrame("vm.started", "e-2")),
  );
  const out = await take(makeClient(impl).events.lifecycle(), 3);
  assert.deepEqual(
    out.map((e) => e.kind),
    ["lifecycle", "reconnected", "lifecycle"],
  );
  assert.equal(calls.length, 2);
  const gap = calls[1].at - calls[0].at;
  // A timer may fire a hair early against performance.now(); 990 ms is the floor.
  assert.ok(gap >= 990, `second connect only ${gap.toFixed(0)} ms after the first`);
});

test("no Last-Event-ID header is sent, on the first connect or a reconnect", async () => {
  const { calls, impl } = fakeFetch(
    sse(lifecycleFrame("vm.created", "e-1")),
    sse(lifecycleFrame("vm.started", "e-2")),
  );
  await take(makeClient(impl).events.lifecycle({ reconnectMinIntervalMs: 0 }), 3);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const h = new Headers(call.init.headers);
    // Positive control: the headers are readable here at all.
    assert.equal(h.get("authorization"), "Bearer cvk_x");
    assert.equal(h.has("last-event-id"), false);
  }
});

test("leaving at the `reconnected` marker cancels the reconnected body", async () => {
  let firstCancelled = false;
  let secondCancelled = false;
  const tracked = (text, onCancel) => () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(text));
        },
        cancel() {
          onCancel();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  const { calls, impl } = fakeFetch(
    sse(lifecycleFrame("vm.created", "e-1")),
    tracked(lifecycleFrame("vm.started", "e-2"), () => {
      secondCancelled = true;
    }),
  );
  const out = await take(makeClient(impl).events.lifecycle({ reconnectMinIntervalMs: 0 }), 2);
  assert.deepEqual(
    out.map((e) => e.kind),
    ["lifecycle", "reconnected"],
  );
  assert.equal(calls.length, 2);
  assert.equal(secondCancelled, true, "the second connection was left open");

  // Positive control, and the other yield point: leaving at a frame of the
  // first connection cancels that body too.
  const { impl: impl2 } = fakeFetch(
    tracked(lifecycleFrame("vm.created", "e-1"), () => {
      firstCancelled = true;
    }),
  );
  await take(makeClient(impl2).events.lifecycle(), 1);
  assert.equal(firstCancelled, true);
});

/**
 * A caller signal that counts the `abort` listeners still attached to it. Each
 * connect composes the caller's signal with the deadline; a listener that is
 * never removed piles up per reconnect on a signal that lives as long as the app.
 */
function countedSignal() {
  const ac = new AbortController();
  const live = new Set();
  const add = ac.signal.addEventListener.bind(ac.signal);
  const remove = ac.signal.removeEventListener.bind(ac.signal);
  ac.signal.addEventListener = (type, fn, opts) => {
    if (type === "abort") {
      live.add(fn);
      // A `once` listener detaches itself when it fires.
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

test("reconnects leave no abort listener on the caller's signal, with a timeout set", async () => {
  const connects = 15;
  const { calls, impl } = fakeFetch(
    ...Array.from({ length: connects }, (_, i) => sse(lifecycleFrame("vm.created", `e-${i}`))),
  );
  const client = new CoveClient({
    baseUrl: "https://cove.test/",
    token: "cvk_x",
    fetch: impl,
    timeoutMs: 5000,
  });
  const { ac, live } = countedSignal();
  let lifecycle = 0;
  for await (const evt of client.events.lifecycle({ signal: ac.signal, reconnectMinIntervalMs: 0 })) {
    if (evt.kind === "lifecycle" && ++lifecycle === connects) break;
  }
  assert.equal(calls.length, connects);
  // Positive control: the counter sees the composed signal's listener at all.
  assert.ok(calls.every((c) => c.init.signal !== ac.signal), "the signal was composed per connect");
  assert.equal(live.size, 0, `${live.size} abort listeners left after ${connects} connects`);
});

test("a stream that closes normally leaves no abort listener on the caller's signal", async () => {
  const { impl } = fakeFetch(sse(lifecycleFrame("vm.created", "e-1")));
  const client = new CoveClient({
    baseUrl: "https://cove.test/",
    token: "cvk_x",
    fetch: impl,
    timeoutMs: 5000,
  });
  const { ac, live } = countedSignal();
  const out = [];
  for await (const evt of client.events.lifecycle({ signal: ac.signal, reconnect: false })) {
    out.push(evt);
  }
  assert.deepEqual(
    out.map((e) => e.kind),
    ["lifecycle"],
  );
  assert.equal(live.size, 0);
});

test("with a timeout set, the caller's signal still ends an open stream", async () => {
  const { impl } = fakeFetch(hanging(lifecycleFrame("vm.created", "e-1")));
  const client = new CoveClient({
    baseUrl: "https://cove.test/",
    token: "cvk_x",
    fetch: impl,
    timeoutMs: 50,
  });
  const { ac, live } = countedSignal();
  const iter = client.events.lifecycle({ signal: ac.signal });
  const first = await iter.next();
  assert.equal(first.value.kind, "lifecycle");
  // Past the header deadline: the stream must outlive it.
  await new Promise((r) => setTimeout(r, 100));
  // While the stream is open, the caller's signal is what can end it.
  assert.equal(live.size, 1, "the open stream listens to the caller's signal");
  ac.abort();
  await assert.rejects(iter.next(), { name: "AbortError" });
  assert.equal(live.size, 0);
});

test("leaving a stream that is still open releases the caller's signal", async () => {
  // Two chunks already sent, the stream still open: when the consumer leaves at
  // the first event, the second sits read ahead and no read is pending, so only
  // the cancel itself can release the signal.
  const twoChunks = (init) =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(lifecycleFrame("vm.created", "e-1")));
          c.enqueue(enc.encode(lifecycleFrame("vm.started", "e-2")));
          init.signal.addEventListener("abort", () => c.error(init.signal.reason), { once: true });
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  const { impl } = fakeFetch(twoChunks);
  const client = new CoveClient({
    baseUrl: "https://cove.test/",
    token: "cvk_x",
    fetch: impl,
    timeoutMs: 5000,
  });
  const { ac, live } = countedSignal();
  const out = await take(client.events.lifecycle({ signal: ac.signal }), 1);
  assert.equal(out[0].kind, "lifecycle");
  assert.equal(ac.signal.aborted, false);
  assert.equal(live.size, 0, "the abandoned stream kept its listener");
});
