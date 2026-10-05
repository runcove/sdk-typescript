import { CoveError, DownloadTruncatedError } from "../errors.js";
import { apiPath, type CoveHttp, type RequestOverrides } from "../http.js";
import type { FileUploaded } from "../types.js";

/**
 * What `vms.files.stat` answers: the file's size, and its permission bits and
 * modification time when visible.
 */
export interface VmFileStat {
  /** The file's size in bytes (`Content-Length`). */
  size: number;
  /**
   * The file's permission bits as a number (`0o644` is `420`, as in
   * `FileUploaded.mode`), from `X-Cove-File-Mode`. `undefined` when the
   * header is not readable: a browser sees it cross-origin only if the
   * server exposes it (CORS `Access-Control-Expose-Headers`).
   */
  mode: number | undefined;
  /**
   * The file's modification time, from `Last-Modified` (whole seconds).
   * `undefined` when the header is absent (an older server). `Last-Modified`
   * is CORS-safelisted, so a browser reads it cross-origin without the
   * server exposing it.
   */
  mtime: Date | undefined;
}

/** A download in flight: the file's size and mode, and its bytes as a stream. */
export interface VmFileDownload extends VmFileStat {
  /**
   * The file's bytes. The stream errors with `DownloadTruncatedError` when it
   * ends before `size` bytes (or runs past them): a transfer that fails after
   * the server sent `200` can only end the body early, so a short body is a
   * failed download, never a complete one. Read it to the end, or cancel it
   * to release the transfer.
   */
  body: ReadableStream<Uint8Array>;
}

/**
 * What `vms.files.upload` sends. A `Uint8Array`, `ArrayBuffer`, `Blob` or
 * string (sent as UTF-8) has a known size. A `ReadableStream` or an async
 * iterable of `Uint8Array` chunks (a Node `Readable` is one) is streamed and
 * needs `size`.
 */
export type VmFileUploadBody =
  | Uint8Array
  | ArrayBuffer
  | Blob
  | string
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

export interface VmFileUploadOptions {
  /**
   * Permission bits for the file, within `0o777`: a number (`0o755`) or the
   * octal string the server takes (`"0755"`). Omitted, the server keeps the
   * replaced file's bits, or uses `0644` for a new file.
   */
  mode?: number | string;
  /**
   * The body's length in bytes. Required for a stream: the server needs the
   * size before the upload starts and refuses a chunked body (411). For a
   * sized body it is optional and must match.
   */
  size?: number;
}

/**
 * The `path` query for a file operation. Encoded by hand, never through
 * `URLSearchParams`, which writes a space as `+`: the server only
 * percent-decodes, so it would read that `+` as a literal plus.
 */
function fileQuery(path: string, mode?: string): string {
  if (typeof path !== "string") throw new CoveError("A file path must be a string");
  let encoded: string;
  try {
    encoded = encodeURIComponent(path);
  } catch {
    // URIError: a lone surrogate has no UTF-8 form, so no request can name this path.
    throw new CoveError("A file path must be valid Unicode (it has a lone surrogate)");
  }
  let query = `?path=${encoded}`;
  if (mode !== undefined) query += `&mode=${encodeURIComponent(mode)}`;
  return query;
}

/** `mode` as the server's four octal digits, refusing anything outside `0o777`. */
function wireMode(mode: number | string): string {
  if (typeof mode === "number") {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
      throw new CoveError(`A file mode must be an integer within 0o777, got ${mode}`);
    }
    return mode.toString(8).padStart(4, "0");
  }
  if (typeof mode !== "string" || !/^0?[0-7]{1,3}$/.test(mode)) {
    throw new CoveError(
      `A file mode must be octal permission bits within 0777, got ${JSON.stringify(mode)}`,
    );
  }
  return mode;
}

/** A non-negative safe integer from a `Content-Length` header, else `undefined`. */
function parseLength(value: string | null): number | undefined {
  if (value === null || !/^\d{1,16}$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : undefined;
}

function parseMode(value: string | null): number | undefined {
  if (value === null || !/^[0-7]{1,4}$/.test(value.trim())) return undefined;
  return Number.parseInt(value.trim(), 8);
}

/** An HTTP-date from `Last-Modified` as a `Date`, else `undefined`. */
function parseHttpDate(value: string | null): Date | undefined {
  if (value === null) return undefined;
  const ms = Date.parse(value.trim());
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

function statOf(response: Response, method: string): VmFileStat {
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (method === "GET" && encoding && encoding !== "identity") {
    // A browser cannot ask for identity, and a proxy may ignore it: the body is
    // then decoded but Content-Length still counts the encoded bytes.
    throw new CoveError(
      `GET file answered with Content-Encoding ${encoding}, so its Content-Length does not count its bytes`,
    );
  }
  const size = parseLength(response.headers.get("content-length"));
  if (size === undefined) {
    throw new CoveError(
      `${method} file answered 200 without a readable Content-Length, so its size is unknown`,
    );
  }
  return {
    size,
    mode: parseMode(response.headers.get("x-cove-file-mode")),
    mtime: parseHttpDate(response.headers.get("last-modified")),
  };
}

const isAbort = (err: unknown): boolean =>
  err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");

/**
 * `body`, checked against `expected` bytes: it errors with
 * `DownloadTruncatedError` when it ends short, runs long, or the connection
 * breaks. A caller abort passes through as the `AbortError` it is.
 */
function checkedLength(
  body: ReadableStream<Uint8Array>,
  expected: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        controller.error(
          isAbort(err) ? err : new DownloadTruncatedError(expected, received, { cause: err }),
        );
        return;
      }
      if (chunk.done) {
        if (received === expected) controller.close();
        else controller.error(new DownloadTruncatedError(expected, received));
        return;
      }
      received += chunk.value.byteLength;
      if (received > expected) {
        controller.error(new DownloadTruncatedError(expected, received));
        await reader.cancel().catch(() => {});
        return;
      }
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

/** A `ReadableStream` or async iterable upload source as one async iterator. */
function sourceIterator(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncIterator<Uint8Array> {
  return source instanceof ReadableStream
    ? readerIterator(source.getReader())
    : source[Symbol.asyncIterator]();
}

const sizeMismatch = (size: number, got: string): CoveError =>
  new CoveError(`Upload body does not match its declared size of ${size} bytes (${got})`);

/** The next chunk of an upload source, refusing anything that is not a `Uint8Array`. */
async function nextChunk(iterator: AsyncIterator<Uint8Array>): Promise<Uint8Array | undefined> {
  const next = await iterator.next();
  if (next.done) return undefined;
  if (!(next.value instanceof Uint8Array)) {
    await iterator.return?.();
    throw new CoveError("An upload stream must yield Uint8Array chunks");
  }
  return next.value;
}

/**
 * Confirm a source declared as 0 bytes yields none, before the request goes
 * out: with `Content-Length: 0` the server has the whole file once it has the
 * headers.
 */
async function assertEmpty(iterator: AsyncIterator<Uint8Array>): Promise<void> {
  for (;;) {
    const chunk = await nextChunk(iterator);
    if (chunk === undefined) return;
    if (chunk.byteLength > 0) {
      await iterator.return?.();
      throw sizeMismatch(0, "the body ran past it");
    }
  }
}

/**
 * A stream body, counted: it errors with a `CoveError` (also handed to
 * `onFailure`) when the bytes it yields do not add up to `size`, before the
 * server has all `size` bytes. A source that throws is reported the same way,
 * with its own error. The chunk that reaches `size` is held back
 * until the source reports done, since the server commits as soon as it has
 * `Content-Length` bytes and a later chunk could no longer fail the upload.
 */
function sizedStream(
  iterator: AsyncIterator<Uint8Array>,
  size: number,
  onFailure: (err: unknown) => void,
): ReadableStream<Uint8Array> {
  let sent = 0;
  let held: Uint8Array | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Loop until a chunk is enqueued or the stream ends: a pull that does
      // neither is not called again.
      for (;;) {
        let chunk: Uint8Array | undefined;
        try {
          chunk = await nextChunk(iterator);
        } catch (err) {
          // The source's own error too: fetch would report it as a network failure.
          onFailure(err);
          controller.error(err);
          return;
        }
        if (chunk === undefined) {
          if (sent !== size) {
            const err = sizeMismatch(size, `the body ended after ${sent}`);
            onFailure(err);
            controller.error(err);
            return;
          }
          if (held !== undefined) controller.enqueue(held);
          controller.close();
          return;
        }
        if (chunk.byteLength === 0) continue;
        sent += chunk.byteLength;
        if (sent > size) {
          const err = sizeMismatch(size, "the body ran past it");
          onFailure(err);
          controller.error(err);
          await iterator.return?.();
          return;
        }
        if (sent === size) {
          held = chunk;
          continue;
        }
        controller.enqueue(chunk);
        return;
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

function readerIterator(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncIterator<Uint8Array> {
  return {
    async next() {
      const r = await reader.read();
      return r.done ? { done: true, value: undefined } : { done: false, value: r.value };
    },
    async return() {
      await reader.cancel();
      return { done: true, value: undefined };
    },
  };
}

function knownSize(data: VmFileUploadBody): number | undefined {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof Uint8Array) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return undefined;
}

/**
 * `client.vms.files` — move single files in and out of a running VM, over
 * `GET`, `PUT` and `HEAD` on `/api/vms/{name}/files`. `path` is the file's
 * absolute path in the VM. Scopes: `files:read` (stat, download) and
 * `files:write` (upload); both are in a new key's default set. The caller
 * also needs SSH access to the VM. A transfer holds one of the guest's
 * transfer slots while it runs; when they are all taken the server answers
 * 503 `unavailable` (`UnavailableError`): retry.
 *
 * Errors common to all three: 400 `validation_failed` for a path that is not
 * absolute or has an empty, `.` or `..` component; 403 `file_path_denied`
 * (`FilePathDeniedError`) for a deny-listed or pseudo-filesystem path; 404
 * `vm_not_found` (`NotFoundError`) or `file_not_found` (`VmFileNotFoundError`);
 * 409 for a VM that is not running, or whose guest agent predates file
 * transfer (`guest_agent_too_old`: restart the VM); 413 `file_too_large`
 * (`FileTooLargeError`); 422 `file_not_regular` (`FileNotRegularError`) for a
 * directory, a device or a symlink anywhere in the path (symlinks are refused,
 * never followed).
 */
export class VmFilesResource {
  constructor(private readonly http: CoveHttp) {}

  /**
   * Size, mode and modification time of one file, without reading it.
   * Scope: `files:read`. A `HEAD` error carries no body; the server names its
   * code in `X-Cove-Error-Code`, which picks the error class as a `GET`
   * body's `code` would: a 404 is `NotFoundError` (`vm_not_found`) or
   * `VmFileNotFoundError` (`file_not_found`), a 403 `FilePathDeniedError`
   * (`file_path_denied`) or `PermissionDeniedError` (`scope_denied`). Without
   * the header (an older server, or a browser it is not exposed to), the
   * status alone picks: 413 is `FileTooLargeError`, 422
   * `FileNotRegularError`, 503 `UnavailableError`, and a 403 or 404 stays
   * `PermissionDeniedError` / `NotFoundError` with no `code`.
   */
  async stat(name: string, path: string, overrides: RequestOverrides = {}): Promise<VmFileStat> {
    const response = await this.http.requestRaw(
      "HEAD",
      apiPath`/api/vms/${name}/files` + fileQuery(path),
      {
        ...overrides,
        impliedErrorCodes: { 413: "file_too_large", 422: "file_not_regular", 503: "unavailable" },
      },
    );
    await response.body?.cancel().catch(() => {});
    return statOf(response, "HEAD");
  }

  /**
   * Stream one file out of the VM. Scope: `files:read`. Resolves once the
   * headers are in, with the size and mode; `body` then streams the bytes and
   * errors with `DownloadTruncatedError` if they stop short of `size`. The
   * client's `timeoutMs` bounds the wait for the headers only; the caller's
   * `signal` stays live for the body. The server ends a download that runs
   * slower than an average 256 KiB/s (60 s at least), which arrives here as a
   * short body. Use {@link downloadBytes} to get the whole file in memory.
   */
  async download(
    name: string,
    path: string,
    overrides: RequestOverrides = {},
  ): Promise<VmFileDownload> {
    const response = await this.http.requestRaw(
      "GET",
      apiPath`/api/vms/${name}/files` + fileQuery(path),
      {
        ...overrides,
        // identity: Content-Length must count the bytes this download yields. A fetch that
        // asks for gzip decodes transparently but leaves Content-Length at the encoded size.
        headers: { ...overrides.headers, "Accept-Encoding": "identity" },
      },
    );
    let stat: VmFileStat;
    try {
      stat = statOf(response, "GET");
    } catch (err) {
      await response.body?.cancel().catch(() => {});
      throw err;
    }
    const source = response.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    return { ...stat, body: checkedLength(source, stat.size) };
  }

  /**
   * {@link download}, read to the end: the whole file as one `Uint8Array`.
   * Scope: `files:read`. Rejects with `DownloadTruncatedError` rather than
   * return fewer bytes than the file holds.
   */
  async downloadBytes(
    name: string,
    path: string,
    overrides: RequestOverrides = {},
  ): Promise<Uint8Array> {
    const { size, body } = await this.download(name, path, overrides);
    const out = new Uint8Array(size);
    let offset = 0;
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.set(value, offset);
      offset += value.byteLength;
    }
    return out;
  }

  /**
   * Write `data` to one file in the VM, creating it or replacing it whole.
   * Scope: `files:write`, which is as strong as `vms:exec`: a file written as
   * root can run code. The guest renames the file into place only once every
   * byte has arrived, so a failed upload leaves the old file untouched. The
   * file is owned by root, with `options.mode`, else the replaced file's
   * bits, else `0644`.
   *
   * A stream needs `options.size` (the server refuses a chunked body); a
   * stream that yields a different number of bytes fails with `CoveError`
   * before the server commits anything. A source that throws fails the
   * upload with its own error, unwrapped, never a `CoveConnectionError`.
   * Streaming a request body needs a fetch that supports it (Node 18+); in a
   * browser, pass a `Blob`. The client's `timeoutMs` bounds the whole upload:
   * raise it per call for a large file.
   *
   * Statuses beyond those on {@link VmFilesResource}: 400 for a `mode` outside
   * `0777` or a body shorter than its size, 413 `file_too_large` for a file
   * over the host's limit, 503 `unavailable` with a message starting `file
   * transfer too slow` for an upload slower than an average 256 KiB/s, and
   * 507 `guest_disk_full` when it would leave the guest under 128 MiB free.
   */
  async upload(
    name: string,
    path: string,
    data: VmFileUploadBody,
    options: VmFileUploadOptions = {},
    overrides: RequestOverrides = {},
  ): Promise<FileUploaded> {
    const mode = options.mode === undefined ? undefined : wireMode(options.mode);
    const query = fileQuery(path, mode);
    const { size } = options;
    if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) {
      throw new CoveError(`An upload size must be a non-negative integer, got ${size}`);
    }

    const known = knownSize(data);
    let rawBody: Uint8Array | ArrayBuffer | Blob | string | ReadableStream<Uint8Array>;
    let contentLength: number | undefined;
    let failure: { err: unknown } | undefined;
    if (known !== undefined) {
      if (size !== undefined && size !== known) {
        throw new CoveError(`An upload size of ${size} contradicts the body's ${known} bytes`);
      }
      rawBody = data as Uint8Array | ArrayBuffer | Blob | string;
    } else {
      if (size === undefined) {
        throw new CoveError(
          "Uploading a stream needs options.size: the server needs the file's size before the upload starts and refuses a chunked body",
        );
      }
      const iterator = sourceIterator(data as ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>);
      if (size === 0) {
        await assertEmpty(iterator);
        rawBody = new Uint8Array(0);
      } else {
        rawBody = sizedStream(iterator, size, (err) => {
          failure ??= { err };
        });
        contentLength = size;
      }
    }

    try {
      return await this.http.request<FileUploaded>("PUT", apiPath`/api/vms/${name}/files` + query, {
        ...overrides,
        rawBody,
        contentType: "application/octet-stream",
        contentLength,
      });
    } catch (err) {
      // The size check, or the source itself, fails the body mid-send; fetch
      // reports that as its own network error. Report the cause instead.
      if (failure) throw failure.err;
      throw err;
    }
  }
}
