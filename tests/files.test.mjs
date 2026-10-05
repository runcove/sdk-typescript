// `client.vms.files`: stat (HEAD), download (GET, a stream checked against
// its Content-Length) and upload (PUT, a body of known size) on
// /api/vms/{name}/files, against a fake fetch. The wire rules come from the
// contract (`sdk/openapi.yaml`): the `path` query is percent-encoded with
// `+` meaning a literal `+`; an upload needs a `Content-Length`; a download
// body shorter than its `Content-Length` is a failed download.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  CoveClient,
  CoveConnectionError,
  CoveError,
  DownloadTruncatedError,
  FileNotRegularError,
  FilePathDeniedError,
  FileTooLargeError,
  NotFoundError,
  PayloadTooLargeError,
  PermissionDeniedError,
  ServerError,
  UnavailableError,
  ValidationError,
  VmFileNotFoundError,
} from "../dist/index.js";

function fakeFetch(...responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return next(init);
  };
  return { calls, impl };
}

const makeClient = (fetchImpl, extra = {}) =>
  new CoveClient({ baseUrl: "https://cove.test/", token: "cvk_x", fetch: fetchImpl, ...extra });

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A 200 file response; `chunks` are sent as they are, whatever `size` claims. */
const fileResponse = (chunks, { size, mode = "0644", head = false } = {}) => () => {
  const total = size ?? chunks.reduce((n, c) => n + enc.encode(c).length, 0);
  const headers = { "Content-Length": String(total), "X-Cove-File-Mode": mode };
  if (head) return new Response(null, { status: 200, headers });
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers });
};

const apiError = (status, code, message = "m") => () =>
  new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const bare = (status) => () => new Response(null, { status });

const json = (body) => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const uploaded = { path: "/root/a b.txt", size: 5, mode: 420, sha256: "ab".repeat(32) };

async function readAll(stream) {
  const parts = [];
  for await (const chunk of stream) parts.push(chunk);
  return dec.decode(Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// The request line
// ---------------------------------------------------------------------------

test("unit_files_path_query_is_percent_encoded_with_space_as_%20_and_plus_kept_literal", async () => {
  const { calls, impl } = fakeFetch(fileResponse([], { head: true, size: 0 }));
  await makeClient(impl).vms.files.stat("my vm", "/root/a b+c&d=é.txt");
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/vms/my%20vm/files");
  // Never `+` for a space: the server reads `+` as a literal plus.
  assert.equal(url.search, "?path=%2Froot%2Fa%20b%2Bc%26d%3D%C3%A9.txt");
});

test("unit_files_name_is_a_guarded_path_segment", async () => {
  const { calls, impl } = fakeFetch(json({}));
  const client = makeClient(impl);
  for (const bad of ["", ".", ".."]) {
    await assert.rejects(async () => client.vms.files.stat(bad, "/a"), CoveError);
    await assert.rejects(async () => client.vms.files.downloadBytes(bad, "/a"), CoveError);
    await assert.rejects(async () => client.vms.files.upload(bad, "/a", "x"), CoveError);
  }
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// stat
// ---------------------------------------------------------------------------

test("unit_files_stat_sends_HEAD_and_reads_size_and_mode", async () => {
  const { calls, impl } = fakeFetch(fileResponse([], { head: true, size: 1234, mode: "0755" }));
  const st = await makeClient(impl).vms.files.stat("v", "/usr/bin/tool");
  assert.equal(calls[0].init.method, "HEAD");
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(st, { size: 1234, mode: 0o755, mtime: undefined });
});

test("unit_files_stat_leaves_mode_undefined_when_the_header_is_hidden", async () => {
  const { impl } = fakeFetch(() => new Response(null, { status: 200, headers: { "Content-Length": "3" } }));
  assert.deepEqual(await makeClient(impl).vms.files.stat("v", "/a"), { size: 3, mode: undefined, mtime: undefined });
});

test("unit_files_stat_reads_mtime_from_last_modified", async () => {
  const { impl } = fakeFetch(
    () =>
      new Response(null, {
        status: 200,
        headers: { "Content-Length": "3", "Last-Modified": "Tue, 14 Nov 2023 22:13:20 GMT" },
      }),
  );
  const st = await makeClient(impl).vms.files.stat("v", "/a");
  assert.ok(st.mtime instanceof Date);
  assert.equal(st.mtime.getTime(), 1_700_000_000_000);
});

test("unit_files_stat_leaves_mtime_undefined_without_a_readable_last_modified", async () => {
  // An older server sends no Last-Modified; a garbled one is not a date.
  for (const lastModified of [undefined, "not a date"]) {
    const headers = { "Content-Length": "3" };
    if (lastModified) headers["Last-Modified"] = lastModified;
    const { impl } = fakeFetch(() => new Response(null, { status: 200, headers }));
    const st = await makeClient(impl).vms.files.stat("v", "/a");
    assert.equal(st.mtime, undefined, String(lastModified));
  }
});

test("unit_files_stat_errors_take_their_code_from_x_cove_error_code", async () => {
  // A HEAD error has no body; the server names its code in a header, so a
  // missing VM and a missing file, or a denied path and a missing scope, are
  // told apart.
  const cases = [
    [404, "vm_not_found", NotFoundError],
    [404, "file_not_found", VmFileNotFoundError],
    [403, "file_path_denied", FilePathDeniedError],
    [403, "scope_denied", PermissionDeniedError],
    [413, "file_too_large", FileTooLargeError],
  ];
  for (const [status, code, Klass] of cases) {
    const { impl } = fakeFetch(
      () => new Response(null, { status, headers: { "X-Cove-Error-Code": code } }),
    );
    const err = await makeClient(impl).vms.files.stat("v", "/a").catch((e) => e);
    assert.equal(err.constructor, Klass, `HEAD ${status} ${code}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
  }
});

test("unit_files_stat_refuses_a_200_without_a_content_length", async () => {
  const { impl } = fakeFetch(() => new Response(null, { status: 200 }));
  await assert.rejects(makeClient(impl).vms.files.stat("v", "/a"), /Content-Length/);
});

test("unit_files_stat_errors_carry_no_body_so_the_status_names_the_file_error", async () => {
  // HEAD error responses have no body: the status alone says what GET would
  // have answered, so the unambiguous ones get their file error class.
  const cases = [
    [413, FileTooLargeError, "file_too_large"],
    [422, FileNotRegularError, "file_not_regular"],
    [503, UnavailableError, "unavailable"],
    // 403 is a deny-listed path OR a key without files:read; 404 a missing
    // VM OR a missing file. Neither can be told apart without a body.
    [403, PermissionDeniedError, undefined],
    [404, NotFoundError, undefined],
  ];
  for (const [status, Klass, code] of cases) {
    const { impl } = fakeFetch(bare(status));
    const err = await makeClient(impl).vms.files.stat("v", "/a").catch((e) => e);
    assert.equal(err.constructor, Klass, `HEAD ${status}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
  }
});

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

test("unit_files_download_streams_the_body_with_size_and_mode", async () => {
  const { calls, impl } = fakeFetch(fileResponse(["hey", "you"], { mode: "0600" }));
  const dl = await makeClient(impl).vms.files.download("v", "/etc/motd");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.get("Accept"), "application/octet-stream");
  // A content-encoded body would not match Content-Length.
  assert.equal(calls[0].init.headers.get("Accept-Encoding"), "identity");
  assert.equal(dl.size, 6);
  assert.equal(dl.mode, 0o600);
  assert.ok(dl.body instanceof ReadableStream);
  assert.equal(await readAll(dl.body), "heyyou");
});

test("unit_files_a_content_encoded_download_is_refused_not_miscounted", async () => {
  const { impl } = fakeFetch(
    () => new Response("x", { status: 200, headers: { "Content-Length": "1", "Content-Encoding": "gzip" } }),
  );
  await assert.rejects(makeClient(impl).vms.files.downloadBytes("v", "/a"), /Content-Encoding gzip/);
});

test("unit_files_downloadBytes_returns_the_whole_file", async () => {
  const { impl } = fakeFetch(fileResponse(["ab", "cd", "e"]));
  const bytes = await makeClient(impl).vms.files.downloadBytes("v", "/a");
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(dec.decode(bytes), "abcde");
});

test("unit_files_downloadBytes_of_an_empty_file_is_empty", async () => {
  const { impl } = fakeFetch(fileResponse([], { size: 0 }));
  const bytes = await makeClient(impl).vms.files.downloadBytes("v", "/empty");
  assert.equal(bytes.length, 0);
});

test("unit_files_a_body_shorter_than_content_length_is_a_failed_download", async () => {
  const { impl } = fakeFetch(fileResponse(["abc"], { size: 10 }));
  const err = await makeClient(impl).vms.files.downloadBytes("v", "/a").catch((e) => e);
  assert.ok(err instanceof DownloadTruncatedError, String(err));
  assert.ok(err instanceof CoveError);
  assert.equal(err.expectedBytes, 10);
  assert.equal(err.receivedBytes, 3);

  // The stream form fails the same way: never a clean end with fewer bytes.
  const { impl: impl2 } = fakeFetch(fileResponse(["abc"], { size: 10 }));
  const dl = await makeClient(impl2).vms.files.download("v", "/a");
  await assert.rejects(readAll(dl.body), DownloadTruncatedError);
});

test("unit_files_a_body_longer_than_content_length_is_refused", async () => {
  const { impl } = fakeFetch(fileResponse(["abcdef"], { size: 2 }));
  await assert.rejects(makeClient(impl).vms.files.downloadBytes("v", "/a"), DownloadTruncatedError);
});

test("unit_files_a_connection_lost_mid_body_is_a_failed_download", async () => {
  const { impl } = fakeFetch(() => {
    let sent = false;
    const body = new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(enc.encode("abc"));
        } else {
          controller.error(new TypeError("terminated"));
        }
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Length": "10" } });
  });
  const err = await makeClient(impl).vms.files.downloadBytes("v", "/a").catch((e) => e);
  assert.ok(err instanceof DownloadTruncatedError, String(err));
  assert.equal(err.receivedBytes, 3);
  assert.equal(err.cause?.message, "terminated");
});

test("unit_files_a_caller_abort_mid_body_passes_through_unwrapped", async () => {
  const controller = new AbortController();
  const { impl } = fakeFetch((init) => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode("abc"));
        init.signal.addEventListener("abort", () => c.error(init.signal.reason));
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Length": "10" } });
  });
  const dl = await makeClient(impl).vms.files.download("v", "/a", { signal: controller.signal });
  const reader = dl.body.getReader();
  await reader.read();
  controller.abort(new DOMException("stop", "AbortError"));
  const err = await reader.read().catch((e) => e);
  assert.equal(err.name, "AbortError");
});

test("unit_files_download_timeout_bounds_the_headers_not_the_body", async () => {
  // The body arrives after the client's whole deadline; a streaming download
  // must not be cut by it once the headers are in.
  const { impl } = fakeFetch((init) => {
    const body = new ReadableStream({
      async pull(c) {
        await new Promise((r) => setTimeout(r, 60));
        if (init.signal?.aborted) return c.error(init.signal.reason);
        c.enqueue(enc.encode("ok"));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Length": "2" } });
  });
  const bytes = await makeClient(impl, { timeoutMs: 20 }).vms.files.downloadBytes("v", "/a");
  assert.equal(dec.decode(bytes), "ok");
});

test("unit_files_download_errors_map_to_file_error_classes_by_code", async () => {
  const cases = [
    [413, "file_too_large", FileTooLargeError],
    [403, "file_path_denied", FilePathDeniedError],
    [403, "scope_denied", PermissionDeniedError],
    [422, "file_not_regular", FileNotRegularError],
    [404, "file_not_found", VmFileNotFoundError],
    [404, "vm_not_found", NotFoundError],
    [503, "unavailable", UnavailableError],
  ];
  for (const [status, code, Klass] of cases) {
    const { impl } = fakeFetch(apiError(status, code));
    const err = await makeClient(impl).vms.files.download("v", "/a").catch((e) => e);
    assert.equal(err.constructor, Klass, `${status} ${code}`);
    assert.equal(err.code, code);
  }
});

test("unit_files_error_classes_extend_their_status_class", () => {
  assert.ok(new FileTooLargeError(413, "m") instanceof PayloadTooLargeError);
  assert.ok(new FilePathDeniedError(403, "m") instanceof PermissionDeniedError);
  assert.ok(new FileNotRegularError(422, "m") instanceof ValidationError);
  assert.ok(new VmFileNotFoundError(404, "m") instanceof NotFoundError);
  assert.ok(new UnavailableError(503, "m") instanceof ServerError);
});

// ---------------------------------------------------------------------------
// upload
// ---------------------------------------------------------------------------

test("unit_files_upload_puts_bytes_with_content_type_and_returns_the_commit", async () => {
  const { calls, impl } = fakeFetch(json(uploaded));
  const out = await makeClient(impl).vms.files.upload("v", "/root/a b.txt", enc.encode("hello"));
  const { init, url } = calls[0];
  assert.equal(init.method, "PUT");
  assert.equal(new URL(url).search, "?path=%2Froot%2Fa%20b.txt");
  assert.equal(init.headers.get("Content-Type"), "application/octet-stream");
  assert.equal(init.headers.get("Accept"), "application/json");
  assert.equal(dec.decode(init.body), "hello");
  assert.deepEqual(out, uploaded);
});

test("unit_files_upload_accepts_a_string_a_blob_and_an_ArrayBuffer", async () => {
  for (const data of ["héllo", new Blob(["héllo"]), enc.encode("héllo").buffer]) {
    const { calls, impl } = fakeFetch(json(uploaded));
    await makeClient(impl).vms.files.upload("v", "/a", data);
    const sent = await new Response(calls[0].init.body).text();
    assert.equal(sent, "héllo");
  }
});

test("unit_files_upload_mode_is_sent_as_four_octal_digits", async () => {
  for (const [mode, wire] of [
    [0o755, "0755"],
    [0o4, "0004"],
    ["0600", "0600"],
  ]) {
    const { calls, impl } = fakeFetch(json(uploaded));
    await makeClient(impl).vms.files.upload("v", "/a", "x", { mode });
    assert.equal(new URL(calls[0].url).search, `?path=%2Fa&mode=${wire}`);
  }
});

test("unit_files_upload_refuses_a_mode_outside_0777", async () => {
  const client = makeClient(fakeFetch(json(uploaded)).impl);
  for (const mode of [0o1000, -1, 1.5, "rwx", "01777"]) {
    await assert.rejects(client.vms.files.upload("v", "/a", "x", { mode }), CoveError, String(mode));
  }
});

test("unit_files_upload_streams_a_ReadableStream_with_its_declared_size", async () => {
  const { calls, impl } = fakeFetch(json(uploaded));
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode("hey"));
      c.enqueue(enc.encode("you"));
      c.close();
    },
  });
  await makeClient(impl).vms.files.upload("v", "/a", stream, { size: 6 });
  const { init } = calls[0];
  assert.equal(init.headers.get("Content-Length"), "6");
  assert.equal(init.duplex, "half");
  assert.equal(await new Response(init.body).text(), "heyyou");
});

test("unit_files_upload_streams_an_async_iterable", async () => {
  const { calls, impl } = fakeFetch(json(uploaded));
  async function* chunks() {
    yield enc.encode("hey");
    yield enc.encode("you");
  }
  await makeClient(impl).vms.files.upload("v", "/a", chunks(), { size: 6 });
  assert.equal(calls[0].init.headers.get("Content-Length"), "6");
  assert.equal(await new Response(calls[0].init.body).text(), "heyyou");
});

test("unit_files_a_stream_upload_needs_a_size_because_the_server_refuses_chunked", async () => {
  const { calls, impl } = fakeFetch(json(uploaded));
  const stream = new ReadableStream({ start: (c) => c.close() });
  await assert.rejects(makeClient(impl).vms.files.upload("v", "/a", stream), /size/);
  assert.equal(calls.length, 0, "nothing is sent");
});

test("unit_files_a_stream_that_does_not_match_its_size_fails_the_upload", async () => {
  // The fake fetch drains the body as a real one would; the size check is the
  // SDK's own, so it holds on any fetch, not only undici's.
  for (const [chunks, size] of [
    [["abc"], 5],
    [["abcdef"], 5],
  ]) {
    const { impl } = fakeFetch(async (init) => {
      await new Response(init.body).arrayBuffer();
      return json(uploaded)();
    });
    async function* gen() {
      for (const c of chunks) yield enc.encode(c);
    }
    const err = await makeClient(impl).vms.files.upload("v", "/a", gen(), { size }).catch((e) => e);
    assert.ok(err instanceof CoveError, String(err));
    assert.match(err.message, /declared size/, `${chunks} vs ${size}`);
  }
});

/**
 * A real HTTP server that, like cove, reads an upload up to its
 * `Content-Length` and commits the file the moment it has every byte, never
 * reading past it. `commits` lists the bodies it committed.
 */
async function committingServer() {
  const commits = [];
  let bytesIn = 0;
  const waiters = new Set();
  const server = createServer((req, res) => {
    const expected = Number(req.headers["content-length"]);
    const parts = [];
    let received = 0;
    const commit = () => {
      commits.push(Buffer.concat(parts).toString());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...uploaded, size: expected }));
    };
    if (expected === 0) return commit();
    req.on("data", (chunk) => {
      parts.push(chunk);
      received += chunk.length;
      bytesIn += chunk.length;
      for (const w of waiters) w();
      if (received >= expected) commit();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new CoveClient({
    baseUrl: `http://127.0.0.1:${server.address().port}/`,
    token: "cvk_x",
  });
  return {
    client,
    commits,
    /** Resolves once the server has read `n` body bytes, or after `ms` if it never does. */
    sawBytes: (n, ms) => until(() => bytesIn >= n, ms),
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };

  function until(ready, ms) {
    return new Promise((resolve) => {
      const done = () => {
        if (!ready()) return;
        waiters.delete(done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        waiters.delete(done);
        resolve();
      }, ms);
      waiters.add(done);
      done();
    });
  }
}

test("unit_files_a_stream_that_runs_past_its_size_at_a_chunk_boundary_never_completes_the_upload", async () => {
  // "hey" + "you" is exactly 6 bytes, so a stream that sent "you" before
  // looking for more would hand the server a whole file it commits, and the
  // "!" past it could no longer fail the upload. The source yields "!" only
  // once the server has read 6 bytes (or 200 ms on, when it never will), so
  // the server is never beaten to its commit.
  const pieces = (srv) => [enc.encode("hey"), enc.encode("you"), () => srv.sawBytes(6, 200)];
  const sources = {
    "async iterable": (srv) =>
      (async function* () {
        for (const p of pieces(srv)) {
          if (typeof p === "function") {
            await p();
            yield enc.encode("!");
          } else yield p;
        }
      })(),
    ReadableStream: (srv) => {
      const queue = pieces(srv);
      return new ReadableStream({
        async pull(c) {
          const p = queue.shift();
          if (p === undefined) return c.close();
          if (typeof p === "function") {
            await p();
            c.enqueue(enc.encode("!"));
          } else c.enqueue(p);
        },
      });
    },
  };
  for (const [kind, source] of Object.entries(sources)) {
    const srv = await committingServer();
    try {
      const err = await srv.client.vms.files
        .upload("v", "/a", source(srv), { size: 6 })
        .catch((e) => e);
      assert.ok(err instanceof CoveError, `${kind}: ${err}`);
      assert.match(err.message, /declared size of 6 bytes \(the body ran past it\)/, kind);
      assert.deepEqual(srv.commits, [], `${kind}: the server committed nothing`);
    } finally {
      await srv.close();
    }
  }
});

test("unit_files_an_upload_source_that_throws_surfaces_its_own_error_not_a_connection_failure", async () => {
  // Real undici reports a body stream that errors as `TypeError: fetch failed`;
  // the source's error is what the caller needs, as it already is for size 0.
  const srv = await committingServer();
  try {
    const boom = new Error("disk read failed");
    async function* gen() {
      yield enc.encode("he");
      throw boom;
    }
    const sources = {
      "async iterable": () => gen(),
      "ReadableStream": () =>
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode("he"));
          },
          pull() {
            throw boom;
          },
        }),
    };
    for (const [kind, source] of Object.entries(sources)) {
      const err = await srv.client.vms.files
        .upload("v", "/a", source(), { size: 6 })
        .catch((e) => e);
      assert.equal(err, boom, `${kind}: ${err}`);
      assert.ok(!(err instanceof CoveConnectionError), kind);
    }
    assert.deepEqual(srv.commits, [], "the server commits nothing");

    // Size 0: the same error, raised before the request.
    async function* early() {
      throw boom;
    }
    const zero = await srv.client.vms.files.upload("v", "/a", early(), { size: 0 }).catch((e) => e);
    assert.equal(zero, boom);
  } finally {
    await srv.close();
  }
});

test("unit_files_a_stream_declared_empty_that_yields_bytes_is_refused_before_the_request", async () => {
  // With Content-Length: 0 the headers alone are the whole file, so a server
  // may commit without reading the body; this fetch does exactly that. Whether
  // a given fetch reads the body before it sends the headers is its own
  // business, so the check must come before fetch is called at all.
  const commitsOnHeaders = () => fakeFetch(json({ ...uploaded, size: 0 }));
  const { calls, impl } = commitsOnHeaders();
  async function* gen() {
    yield new Uint8Array(0);
    yield enc.encode("x");
  }
  const err = await makeClient(impl).vms.files.upload("v", "/a", gen(), { size: 0 }).catch((e) => e);
  assert.ok(err instanceof CoveError, String(err));
  assert.match(err.message, /declared size of 0 bytes/);
  assert.equal(calls.length, 0, "nothing is sent");

  // A stream that really is empty uploads an empty file.
  const ok = commitsOnHeaders();
  async function* empty() {}
  await makeClient(ok.impl).vms.files.upload("v", "/a", empty(), { size: 0 });
  assert.equal(ok.calls.length, 1);
  assert.equal((await new Response(ok.calls[0].init.body).arrayBuffer()).byteLength, 0);
});

test("unit_files_a_stream_that_matches_its_size_uploads_whole_to_a_real_server", async () => {
  // The control for the two tests above: the held-back final chunk is sent.
  const srv = await committingServer();
  try {
    async function* gen() {
      for (const c of ["hey", "", "you"]) yield enc.encode(c);
    }
    await srv.client.vms.files.upload("v", "/a", gen(), { size: 6 });
    assert.deepEqual(srv.commits, ["heyyou"]);
  } finally {
    await srv.close();
  }
});

test("unit_files_a_path_with_a_lone_surrogate_is_a_CoveError", async () => {
  const { calls, impl } = fakeFetch(json(uploaded));
  const files = makeClient(impl).vms.files;
  await assert.rejects(files.stat("v", "/a\ud800"), (e) => e instanceof CoveError && /Unicode/.test(e.message));
  await assert.rejects(files.upload("v", "/a\ud800", "x"), CoveError);
  assert.equal(calls.length, 0);
});

test("unit_files_a_size_that_contradicts_a_sized_body_is_refused", async () => {
  const client = makeClient(fakeFetch(json(uploaded)).impl);
  await assert.rejects(client.vms.files.upload("v", "/a", "abc", { size: 4 }), /size/);
  await assert.rejects(client.vms.files.upload("v", "/a", "abc", { size: -1 }), /size/);
});

test("unit_files_upload_errors_are_typed", async () => {
  const { impl } = fakeFetch(apiError(413, "file_too_large", "over the 1 GiB limit"));
  const err = await makeClient(impl).vms.files.upload("v", "/a", "x").catch((e) => e);
  assert.ok(err instanceof FileTooLargeError);
  assert.match(err.message, /1 GiB/);
});
