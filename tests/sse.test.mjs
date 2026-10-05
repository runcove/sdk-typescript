// Tests run against the built output (dist/) — `npm test` builds first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CoveConnectionError, CoveError, parseSSE } from "../dist/index.js";

function streamOf(...chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

async function collect(stream) {
  const out = [];
  for await (const evt of parseSSE(stream)) out.push(evt);
  return out;
}

test("named event with data", async () => {
  const events = await collect(streamOf("event: stdout\ndata: hello\n\n"));
  assert.deepEqual(events, [{ event: "stdout", data: "hello" }]);
});

test("defaults to 'message' when no event field", async () => {
  const events = await collect(streamOf("data: x\n\n"));
  assert.deepEqual(events, [{ event: "message", data: "x" }]);
});

test("multiple data lines join with newline", async () => {
  const events = await collect(streamOf("data: a\ndata: b\n\n"));
  assert.deepEqual(events, [{ event: "message", data: "a\nb" }]);
});

test("comment lines are ignored", async () => {
  const events = await collect(streamOf(": keepalive\ndata: x\n\n: bye\n"));
  assert.deepEqual(events, [{ event: "message", data: "x" }]);
});

test("CRLF line endings are stripped", async () => {
  const events = await collect(streamOf("event: e\r\ndata: v\r\n\r\n"));
  assert.deepEqual(events, [{ event: "e", data: "v" }]);
});

test("field with no colon and value without leading space", async () => {
  const events = await collect(streamOf("data:tight\n\n"));
  assert.deepEqual(events, [{ event: "message", data: "tight" }]);
});

test("event split across chunks mid-line", async () => {
  const events = await collect(streamOf("event: std", "out\nda", "ta: par", "tial\n\n"));
  assert.deepEqual(events, [{ event: "stdout", data: "partial" }]);
});

test("unterminated final event is flushed", async () => {
  const events = await collect(streamOf("event: exit\ndata: {\"code\":0}"));
  assert.deepEqual(events, [{ event: "exit", data: '{"code":0}' }]);
});

test("multi-byte character straddling chunks", async () => {
  const bytes = new TextEncoder().encode("data: héllo\n\n");
  // Split inside the two-byte é sequence.
  const cut = 8;
  const events = await collect(streamOf(bytes.slice(0, cut), bytes.slice(cut)));
  assert.deepEqual(events, [{ event: "message", data: "héllo" }]);
});

test("multiple events in sequence", async () => {
  const events = await collect(
    streamOf("event: stdout\ndata: one\n\nevent: stdout\ndata: two\n\n"),
  );
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.data), ["one", "two"]);
});

test("a newline-free stream past 16 MiB is cancelled with a CoveError", async () => {
  let cancelled = false;
  const chunk = new TextEncoder().encode("x".repeat(1 << 20));
  let sent = 0;
  const body = new ReadableStream({
    pull(c) { if (sent++ < 20) c.enqueue(chunk); else c.close(); },
    cancel() { cancelled = true; },
  });
  const err = await (async () => { for await (const _ of parseSSE(body)) {} })().catch((e) => e);
  assert.ok(err instanceof CoveError && !(err instanceof CoveConnectionError), String(err));
  assert.match(err.message, /SSE event exceeded 16 MiB/);
  assert.ok(cancelled, "the stream is cancelled");
});

test("many short lines totalling more than 16 MiB are fine", async () => {
  const line = new TextEncoder().encode(`data: ${"y".repeat(1000)}\n\n`);
  let sent = 0;
  const body = new ReadableStream({ pull(c) { if (sent++ < 20_000) c.enqueue(line); else c.close(); } });
  let n = 0; for await (const _ of parseSSE(body)) n++;
  assert.equal(n, 20_000);
});

test("one event built from many short data lines past 16 MiB is refused", async () => {
  const line = new TextEncoder().encode(`data: ${"z".repeat(1000)}\n`);
  let sent = 0;
  const body = new ReadableStream({ pull(c) { if (sent++ < 20_000) c.enqueue(line); else c.close(); } });
  const err = await (async () => { for await (const _ of parseSSE(body)) {} })().catch((e) => e);
  assert.ok(err instanceof CoveError && !(err instanceof CoveConnectionError), String(err));
  assert.match(err.message, /SSE event exceeded 16 MiB/);
});

test("one read of many short complete lines totalling more than 16 MiB is accepted", async () => {
  const line = `data: ${"w".repeat(1000)}\n\n`;
  const one = new TextEncoder().encode(line.repeat(20_000));
  assert.ok(one.length > 16 * 1024 * 1024);
  let n = 0; for await (const _ of parseSSE(streamOf(one))) n++;
  assert.equal(n, 20_000);
});
