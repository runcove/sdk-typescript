/**
 * Internal request helper shared by every resource group on `CoveClient`.
 * Not part of the public API surface, with one exception: {@link RequestOverrides}
 * is re-exported from `index.ts`, being the last parameter of every public
 * resource method.
 */

import type { CoveAuth } from "./auth.js";
import {
  CoveAPIError,
  CoveConfigError,
  CoveConnectionError,
  CoveError,
  CoveTimeoutError,
} from "./errors.js";
import { COVE_API_VERSION } from "./generated/api-version.gen.js";

export type QueryValue = string | number | boolean | undefined | null | string[];
export type QueryParams = Record<string, QueryValue>;

/**
 * Client API version advertised to the server, generated from the contract's
 * `info.version` (`sdk/openapi.yaml`). The Warpgate-fronted main listener
 * refuses a missing or too-low value with `426`
 * (`api_version.rs::check_api_version`); the external bearer listener refuses a
 * *declared* too-low value the same way and admits a request that declares none
 * (`api_version.rs::reject_downlevel_api_version`). This is protocol
 * negotiation, deliberately kept out of the auth strategy.
 */
export { COVE_API_VERSION };

/**
 * URL-encode one path segment, rejecting the three values that would silently
 * retarget the request instead of being sent: `""`, `"."`, and `".."`.
 *
 * Encoding is not a defence here — `new URL()` percent-decodes before it applies
 * RFC 3986 dot-segment removal, so `%2e%2e` collapses just like `..`. Only
 * rejection works. Left unguarded, `vms.delete("..")` issues `DELETE /api/` and
 * `secrets.vm("..").list()` reads the caller's own user-scoped secrets — both
 * reachable from model-supplied input via the MCP bridge example.
 */
export function encodeSegment(value: string | number): string {
  const segment = String(value);
  if (segment === "" || segment === "." || segment === "..") {
    throw new CoveError(
      `Invalid path segment ${JSON.stringify(segment)}: empty and dot segments retarget the request`,
    );
  }
  return encodeURIComponent(segment);
}

/**
 * Tagged template that URL-encodes every interpolated value, so resource
 * methods can never forget to encode a path segment:
 *
 * ```ts
 * apiPath`/api/vms/${name}/tags/${key}`  // "/api/vms/a%20b/tags/env"
 * ```
 */
export function apiPath(
  strings: TemplateStringsArray,
  ...values: Array<string | number>
): string {
  let out = strings[0] ?? "";
  for (const [i, value] of values.entries()) {
    out += encodeSegment(value) + (strings[i + 1] ?? "");
  }
  return out;
}

const LOOPBACK_V4 = /^127(\.\d{1,3}){3}$/;

function assertSecureBaseUrl(baseUrl: string, allowInsecure: boolean): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new CoveConfigError(`invalid baseUrl ${JSON.stringify(baseUrl)}`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new CoveConfigError(
      `baseUrl must be an http(s) URL with a host, got ${JSON.stringify(baseUrl)}`,
    );
  }
  if (url.protocol !== "http:" || allowInsecure) return;
  const host = url.hostname;
  if (host === "localhost" || host === "[::1]" || LOOPBACK_V4.test(host)) return;
  throw new CoveConfigError(
    `Refusing http:// baseUrl ${url.origin} — the credential would travel in cleartext. Use https://, a loopback address, or allowInsecureHttp: true.`,
  );
}

export interface CoveHttpOptions {
  baseUrl: string;
  /** Credential strategy. See {@link CoveAuth} and `resolveAuth`. */
  auth: CoveAuth;
  /** Custom fetch implementation (defaults to global `fetch`). */
  fetch?: typeof fetch;
  /**
   * Deadline in milliseconds for a non-streaming request, overridable per call
   * via {@link RequestOverrides.timeoutMs}. For a stream it bounds the wait for
   * the response headers, and an error response's body — see
   * {@link CoveHttp.requestSSE}.
   */
  timeoutMs?: number;
  /**
   * Allow an `http://` `baseUrl` to a non-loopback host. Off by default: the
   * credential would travel in cleartext. Loopback (`localhost`, `127.0.0.0/8`,
   * `[::1]`) is always allowed.
   */
  allowInsecureHttp?: boolean;
  /**
   * Called once per client, on the first response whose `x-cove-api-version`
   * differs from {@link COVE_API_VERSION}. `undefined` installs
   * {@link defaultVersionSkewHook}; `null` disables it.
   */
  onVersionSkew?: VersionSkewHook | null;
}

/** What {@link CoveHttpOptions.onVersionSkew} receives: both API versions, as decimal strings. */
export interface VersionSkewInfo {
  /** The API version this SDK speaks ({@link COVE_API_VERSION}). */
  client: string;
  /** The API version the server advertised. */
  server: string;
}

export type VersionSkewHook = (info: VersionSkewInfo) => void;

/**
 * The default skew hook: one `process.emitWarning` (Node's suppressible
 * library-warning channel, type `CoveApiVersionWarning`) where that exists,
 * silent elsewhere (browsers). The SDK never writes to the console itself.
 */
export const defaultVersionSkewHook: VersionSkewHook = (i) => {
  const proc = (globalThis as { process?: { emitWarning?: unknown } }).process;
  if (typeof proc?.emitWarning === "function") {
    (proc.emitWarning as (message: string, type: string) => void)(
      `Cove server speaks API version ${i.server}; this SDK speaks ${i.client}`,
      "CoveApiVersionWarning",
    );
  }
};

/** A header value that is a plain non-negative decimal integer, else `undefined`. */
function parseApiVersion(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

/**
 * Per-call transport overrides. Every public resource method takes these as
 * its last parameter, kept separate from that method's own domain options so
 * the two stay legible side by side:
 *
 * ```ts
 * await client.vms.execCollect("web-1", { command: ["make", "test"] }, { timeoutMs: 600_000 });
 * ```
 */
export interface RequestOverrides {
  /** Cancel the call. Composed with `timeoutMs` rather than replaced by it. */
  signal?: AbortSignal;
  /**
   * Deadline in milliseconds for this call, overriding the client-wide
   * `timeoutMs`. It bounds each HTTP request the call makes, so the `iter*`
   * page-draining helpers apply it per page rather than to the whole walk;
   * for a streaming call it bounds the wait for the response headers and an
   * error response's body.
   */
  timeoutMs?: number;
  /**
   * Extra headers merged into this request — trace context, an idempotency
   * key, and the like. The SDK's own headers win: a caller cannot displace
   * `Authorization`, `Accept`, `Content-Type`, or the API version.
   */
  headers?: Record<string, string>;
}

/**
 * {@link RequestOverrides} plus the parts a resource method fills in itself.
 * Resource methods spread the caller's overrides first and set `query`/`body`/
 * `accept` after, so what the method itself sets always wins over the bag.
 */
export interface RequestOptions extends RequestOverrides {
  query?: QueryParams;
  /** A JSON body: sent `JSON.stringify`-ed as `application/json`. */
  body?: unknown;
  /**
   * A bytes body, sent exactly as given and never JSON-encoded, with
   * {@link contentType} (default `application/octet-stream`). Mutually
   * exclusive with {@link body}: passing both throws `CoveError`. A
   * `ReadableStream` is sent as a streaming request body (`duplex: "half"`);
   * give it a {@link contentLength} unless a chunked body is acceptable.
   */
  rawBody?: Blob | ArrayBuffer | Uint8Array | string | ReadableStream<Uint8Array>;
  /** `Content-Type` of a {@link rawBody}. Ignored without one. */
  contentType?: string;
  /**
   * `Content-Length` to declare for a {@link rawBody} whose length `fetch`
   * cannot see (a stream). Set after the caller's headers, so it wins.
   */
  contentLength?: number;
  /**
   * The error `code` an error response implies by its status alone, for a
   * response that carries no body to name it (a `HEAD`). Used only when the
   * body names no code.
   */
  impliedErrorCodes?: Partial<Record<number, string>>;
  /**
   * Called with THIS response's `x-cove-api-version` (`undefined` when it has
   * none or an unparseable one), before the status check, so an error
   * response reports too. {@link CoveHttp.serverApiVersion} is the last value
   * any response carried, which a header-less reply does not overwrite.
   */
  onApiVersion?: (version: number | undefined) => void;
  /** Override the Accept header (default `application/json`). */
  accept?: string;
}

const noop = (): void => {};

export const isAbortLike = (err: unknown): boolean =>
  err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");

/**
 * The abort signal for one in-flight request, plus the hooks that release what
 * composing it allocated (a timer, and a listener on the caller's signal).
 */
interface SignalLease {
  /** Pass to `fetch`. `undefined` when there is neither a timeout nor a caller signal. */
  signal?: AbortSignal;
  /**
   * Map an error a request raised to what the caller sees: the `timeoutMs`
   * deadline becomes a `CoveTimeoutError`; anything else comes back as is.
   * Told apart by who aborted the request first, not by the error's name, so
   * a caller's own `AbortSignal.timeout()` stays the caller's.
   */
  wrap(err: unknown): unknown;
  /** Stop the `timeoutMs` clock — the response headers are in. */
  disarm(): void;
  /** Stop the clock and detach from the caller's signal. */
  dispose(): void;
}

/**
 * Thin wrapper around `fetch` that builds URLs against `baseUrl`, attaches
 * bearer auth, serializes query params (dropping `undefined`, repeating
 * array values as repeated keys), and normalizes error handling.
 */
export class CoveHttp {
  /** ECMAScript private so the credential never serializes — see {@link CoveAuth}. */
  readonly #auth: CoveAuth;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs?: number;
  private readonly onVersionSkew: VersionSkewHook | null;
  /** Set once the skew hook has fired: it reports once per client. */
  #skewReported = false;
  #serverApiVersion: number | undefined;

  constructor(opts: CoveHttpOptions) {
    assertSecureBaseUrl(opts.baseUrl, opts.allowInsecureHttp === true);
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#auth = opts.auth;
    // A browser's native `fetch` throws "Illegal invocation" unless its receiver
    // is the global object (or undefined), and Node does not check. So the
    // default is bound to `globalThis`, and `checkedFetch` calls whichever one it
    // holds as a bare function, never as a method of this object.
    this.fetchImpl = opts.fetch ?? globalThis.fetch?.bind(globalThis);
    this.timeoutMs = opts.timeoutMs;
    this.onVersionSkew =
      opts.onVersionSkew === undefined ? defaultVersionSkewHook : opts.onVersionSkew;
    if (!this.fetchImpl) {
      throw new CoveConfigError(
        "No fetch implementation available; pass one via CoveClient({ fetch })",
      );
    }
  }

  /** The `x-cove-api-version` of the last response that carried a parseable one. */
  get serverApiVersion(): number | undefined {
    return this.#serverApiVersion;
  }

  private buildUrl(path: string, query?: QueryParams): string {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(key, v);
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }
    return url.toString();
  }

  /**
   * Compose the caller's `signal` with the effective deadline into the single
   * signal `fetch` accepts. Both have to be honoured: a caller signal used to
   * discard the timeout outright. `AbortSignal.any` would do this in one line
   * but landed in Node 20.3, and this package supports Node 18.
   *
   * `override` is the call's own `timeoutMs`; omitted, the client-wide one
   * applies.
   */
  private buildSignal(explicit?: AbortSignal, override?: number): SignalLease {
    const timeoutMs = override ?? this.timeoutMs;
    if (timeoutMs === undefined) {
      return { signal: explicit, wrap: (err) => err, disarm: noop, dispose: noop };
    }

    const controller = new AbortController();
    let deadline: DOMException | undefined;
    const timer = setTimeout(() => {
      // Only a deadline that got there first counts: if the caller already
      // aborted, the request ended on their signal and the clock is moot.
      if (controller.signal.aborted) return;
      deadline = new DOMException(`Request timed out after ${timeoutMs} ms`, "TimeoutError");
      controller.abort(deadline);
    }, timeoutMs);
    // A pending deadline must never be the reason a Node process stays alive.
    (timer as unknown as { unref?: () => void }).unref?.();

    let detach = noop;
    if (explicit?.aborted) {
      controller.abort(explicit.reason);
    } else if (explicit) {
      const forward = (): void => controller.abort(explicit.reason);
      explicit.addEventListener("abort", forward, { once: true });
      detach = (): void => explicit.removeEventListener("abort", forward);
    }

    const disarm = (): void => clearTimeout(timer);
    return {
      signal: controller.signal,
      wrap: (err) =>
        deadline !== undefined && controller.signal.reason === deadline && isAbortLike(err)
          ? new CoveTimeoutError(deadline.message, { cause: deadline })
          : err,
      disarm,
      dispose: (): void => {
        disarm();
        detach();
      },
    };
  }

  /**
   * Assemble the request headers. The caller's `extra` go on first so that
   * every SDK-set header below overwrites them — the credential, the API
   * version and the content negotiation are protocol, not caller-tunable.
   * `Headers.set` matches names case-insensitively, so a lowercase
   * `authorization` is displaced just the same.
   */
  private async headers(
    accept: string,
    contentType: string | undefined,
    extra?: Record<string, string>,
  ): Promise<Headers> {
    const headers = new Headers();
    if (extra) {
      for (const [name, value] of Object.entries(extra)) {
        try {
          headers.set(name, value);
        } catch {
          // `Headers.set` throws a bare `TypeError` on a malformed name or
          // value; everything this SDK throws is a `CoveError`.
          throw new CoveError(`Invalid request header ${JSON.stringify(name)}`);
        }
      }
    }
    await this.#auth.apply(headers);
    headers.set("X-Cove-Api-Version", COVE_API_VERSION);
    headers.set("Accept", accept);
    if (contentType !== undefined) headers.set("Content-Type", contentType);
    return headers;
  }

  /**
   * Fetch + status check shared by `request` and `requestSSE`. Throws
   * `CoveAPIError` on >= 400. `streaming` stops the `timeoutMs` clock as soon as
   * a good status is in (an error response's body is still read under it): an
   * abort signal stays bound to the response body, so a whole-request deadline
   * is a wall clock on the stream and kills it mid-flight.
   * The lease comes back so the caller can release it once the body is done.
   */
  private async checkedFetch(
    method: string,
    path: string,
    opts: RequestOptions,
    defaultAccept: string,
    streaming: boolean,
  ): Promise<{ response: Response; lease: SignalLease }> {
    const url = this.buildUrl(path, opts.query);
    const hasBody = opts.body !== undefined;
    const hasRawBody = opts.rawBody !== undefined;
    if (hasBody && hasRawBody) {
      throw new CoveError("A request takes either a JSON body or a rawBody, not both");
    }
    const contentType = hasRawBody
      ? (opts.contentType ?? "application/octet-stream")
      : hasBody
        ? "application/json"
        : undefined;
    // Built before the lease so an async credential refresh doesn't burn the deadline.
    const headers = await this.headers(opts.accept ?? defaultAccept, contentType, opts.headers);
    if (hasRawBody && opts.contentLength !== undefined) {
      headers.set("Content-Length", String(opts.contentLength));
    }
    const lease = this.buildSignal(opts.signal, opts.timeoutMs);
    const init: RequestInit = {
      method,
      headers,
      signal: lease.signal,
      // The Cove API never redirects. Following one replays the caller's
      // credential against whatever origin `Location` names, and only the
      // standard `Authorization` header is stripped cross-origin — a custom
      // `CoveAuth` header, or a caller-supplied `fetch`, need not be.
      redirect: "error",
    };
    if (hasRawBody) {
      init.body = opts.rawBody as BodyInit;
      // A stream body must say it is half-duplex (the fetch standard; Node's
      // fetch refuses one without it). Absent from the DOM `RequestInit` type.
      if (typeof ReadableStream !== "undefined" && opts.rawBody instanceof ReadableStream) {
        (init as RequestInit & { duplex: "half" }).duplex = "half";
      }
    } else if (hasBody) init.body = JSON.stringify(opts.body);

    let response: Response;
    try {
      const doFetch = this.fetchImpl;
      response = await doFetch(url, init);
    } catch (err) {
      lease.dispose();
      // The deadline becomes a CoveTimeoutError; a caller's own abort (or
      // timeout signal) passes through unwrapped.
      const wrapped = lease.wrap(err);
      if (wrapped instanceof CoveTimeoutError || isAbortLike(wrapped)) throw wrapped;
      throw new CoveConnectionError(
        `Failed to reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Before the status check: a refusal (426 included) carries the header too.
    let serverApiVersion: number | undefined;
    try {
      serverApiVersion = this.observeApiVersion(response);
    } catch (err) {
      // The caller's skew hook threw: its error still reaches the caller, but
      // first release the deadline and the unread body, which nothing else will.
      lease.dispose();
      await response.body?.cancel().catch(noop);
      throw err;
    }
    opts.onApiVersion?.(serverApiVersion);
    if (response.status >= 400) {
      // The deadline still covers the error body; release it once read.
      let text: string;
      try {
        text = await response.text();
      } catch (err) {
        throw lease.wrap(err);
      } finally {
        lease.dispose();
      }
      let body: unknown = text || undefined;
      try {
        if (text) body = JSON.parse(text);
      } catch {
        // Some endpoints (profile, system/status) return plain-text bodies.
      }
      throw CoveAPIError.fromResponse(
        response.status,
        body,
        serverApiVersion,
        // A body-less error (HEAD) names its code in a header; failing that,
        // the status may imply one.
        response.headers.get("x-cove-error-code")?.trim() ||
          opts.impliedErrorCodes?.[response.status],
        response.headers.get("retry-after"),
      );
    }
    // A stream outlives the deadline, but only once its status is known good.
    if (streaming) lease.disarm();
    return { response, lease };
  }

  /**
   * Record the response's `x-cove-api-version` and, the first time it differs
   * from {@link COVE_API_VERSION}, call the skew hook. Returns this response's
   * version, `undefined` when it carried none (or an unparseable one).
   */
  private observeApiVersion(response: Response): number | undefined {
    const version = parseApiVersion(response.headers.get("x-cove-api-version"));
    if (version === undefined) return undefined;
    this.#serverApiVersion = version;
    const server = String(version);
    if (server !== COVE_API_VERSION && !this.#skewReported) {
      this.#skewReported = true;
      this.onVersionSkew?.({ client: COVE_API_VERSION, server });
    }
    return version;
  }

  /** Perform a request and return the parsed JSON body (or `undefined` for empty bodies). */
  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const { response, lease } = await this.checkedFetch(
      method,
      path,
      opts,
      "application/json",
      false,
    );
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      throw lease.wrap(err);
    } finally {
      lease.dispose();
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // 202/204 acks sometimes carry incidental non-JSON bodies; anything else must be JSON.
      if (response.status === 202 || response.status === 204) return undefined as T;
      throw new CoveError(`Expected JSON from ${method} ${path}, got: ${text.slice(0, 200)}`);
    }
  }

  /**
   * Perform a request and return the raw `Response` for SSE/streaming
   * consumption. `timeoutMs` bounds the response headers, and an error response's
   * body — a good stream then runs until the server ends it or the caller's own
   * `signal` aborts, which stays live for the body's lifetime.
   *
   * The lease is released when the body ends, fails or is cancelled: its
   * listener on the caller's signal would otherwise outlive the stream, one per
   * call, on a signal that may live as long as the app (every reconnect of
   * `client.events` is a call).
   *
   * The returned Response is rebuilt around the wrapped body, so only `status`,
   * `statusText`, `headers` and `body` carry over; `url`, `type` and `redirected`
   * do not.
   */
  async requestSSE(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const { response, lease } = await this.checkedFetch(
      method,
      path,
      opts,
      "text/event-stream",
      true,
    );
    if (!response.body) {
      lease.dispose();
      return response;
    }
    return new Response(releasingBody(response.body, lease.dispose), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /**
   * Perform a request and return the raw `Response` for a bytes body (a file
   * download), or for its headers alone (a `HEAD`). Same lifetime rules as
   * {@link requestSSE}: `timeoutMs` bounds the response headers, and an error
   * response's body; the caller's `signal` stays live for the body, and the lease is released when
   * the body ends, fails or is cancelled. Accepts `application/octet-stream`
   * unless `opts.accept` says otherwise.
   */
  async requestRaw(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const { response, lease } = await this.checkedFetch(
      method,
      path,
      opts,
      "application/octet-stream",
      true,
    );
    if (!response.body) {
      lease.dispose();
      return response;
    }
    return new Response(releasingBody(response.body, lease.dispose), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}

/**
 * `body`, passed through unchanged, calling `release` once when it closes,
 * errors or is cancelled. Errors pass through as the same object, so an abort
 * still reaches the reader as the `AbortError` it is.
 */
function releasingBody(
  body: ReadableStream<Uint8Array>,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    release();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        releaseOnce();
        controller.error(err);
        return;
      }
      if (chunk.done) {
        releaseOnce();
        controller.close();
      } else {
        controller.enqueue(chunk.value);
      }
    },
    async cancel(reason) {
      releaseOnce();
      await reader.cancel(reason);
    },
  });
}
