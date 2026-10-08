/** Error types thrown by the Cove SDK. */

import { COVE_API_VERSION } from "./generated/api-version.gen.js";
import type { DenyReason, ErrorCode } from "./generated/types.gen.js";

/** Every `ApiError.code` the server can send, generated from the contract's `ErrorCode` enum. */
export { ERROR_CODES } from "./generated/error-codes.gen.js";

export class CoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The client was configured wrongly: no credential, more than one, an empty
 * one, a malformed `baseUrl`, a `baseUrl` with no host, a non-`http(s)`
 * `baseUrl` scheme, a plain-`http://` `baseUrl` to a non-loopback host, or no
 * `fetch` to use. Thrown by the constructor before any request is made.
 * Mirrors the Python SDK's `CoveConfigError`.
 */
export class CoveConfigError extends CoveError {}

/** The server could not be reached. */
export class CoveConnectionError extends CoveError {}

/**
 * A `timeoutMs` deadline expired (client-wide or per call) before the server
 * answered. `cause` is the platform `DOMException` (`name` `TimeoutError`).
 * A caller's own `AbortSignal` is not this: it surfaces as the `AbortError`
 * the platform raises. Mirrors the Python SDK's `CoveTimeoutError`.
 */
export class CoveTimeoutError extends CoveConnectionError {
  /** The platform `DOMException`; declared so `lib` older than ES2022 type-checks `err.cause`. */
  declare readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options && "cause" in options) {
      // Set by hand: the ES2022 `Error` cause option is newer than this package's ES2020 target.
      Object.defineProperty(this, "cause", { value: options.cause, configurable: true, writable: true });
    }
  }
}

/** The server returned a non-2xx response. */
export class CoveAPIError extends CoveError {
  /** HTTP status code. */
  readonly status: number;
  /**
   * Machine-readable error code from the response body, if present. Typed as the
   * closed `ErrorCode` union so it narrows, but a code this SDK does not know yet
   * still parses: the union is for narrowing, not validation.
   */
  readonly code?: ErrorCode | (string & {});
  /** Raw parsed JSON body (or text) of the error response. */
  readonly body?: unknown;

  constructor(status: number, message: string, code?: ErrorCode | (string & {}), body?: unknown) {
    super(`HTTP ${status}: ${message}`);
    this.status = status;
    this.code = code;
    this.body = body;
  }

  /**
   * Map an error response to its typed class. `serverApiVersion` is the
   * response's `x-cove-api-version`, when it carried a parseable one;
   * `impliedCode` the code the status alone implies, for a body-less
   * response (HEAD), used only when neither the body nor the
   * `X-Cove-Error-Code` header names one; `retryAfter` its raw `Retry-After` header, read on a 429
   * and on a 5xx.
   */
  static fromResponse(
    status: number,
    body: unknown,
    serverApiVersion?: number,
    impliedCode?: string,
    retryAfter?: string | null,
  ): CoveAPIError {
    let code: string | undefined;
    let message: string | undefined;
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (typeof b.code === "string") code = b.code;
      else if (typeof b.error === "string") code = b.error;
      // Admission/quota denials (`DenyReason`, the platform's most
      // common 409) used to serialize internally-tagged on `reason` instead
      // of `code` — the one error body that didn't key its discriminant on
      // `code`. That's fixed server-side (`cove-core/src/capacity/types.rs`
      // tags on `code` now), so the `reason` fallback that used to sit here
      // is dead and has been removed.
      if (typeof b.message === "string") message = b.message;
      else if (typeof b.error === "string") message = b.error;
    }
    if (code === undefined && impliedCode !== undefined) {
      // A body-less response (HEAD) whose status names its code unambiguously.
      code = impliedCode;
      message ??= impliedCode;
    }
    if (!message) {
      // Some bodies carry only a code (e.g. {code:"sudo_required", reauth_window_secs}).
      if (typeof body === "string") message = body;
      else if (body != null) message = code ?? JSON.stringify(body);
      else message = "request failed";
    }
    if (status === 426 && code === "CLI_TOO_OLD") {
      // Only this code: the CLI keys its self-update on it the same way
      // (`cove/cove-cli/src/tcp_api.rs`, `maybe_auto_update`); any other 426
      // body stays a generic `CoveAPIError` below.
      return new UpgradeRequiredError(status, upgradeMessage(serverApiVersion), code, body, serverApiVersion);
    }
    const byCode =
      code !== undefined && Object.prototype.hasOwnProperty.call(CODE_MAP, code)
        ? CODE_MAP[code]
        : undefined;
    const Klass =
      (byCode && byCode[0] === status ? byCode[1] : undefined) ??
      STATUS_MAP[status] ??
      (status >= 500 ? ServerError : CoveAPIError);
    if (
      Klass === RateLimitError ||
      Klass === ServerError ||
      Klass.prototype instanceof RateLimitError ||
      Klass.prototype instanceof ServerError
    ) {
      // 429 and every 5xx class (`UnavailableError` included) carry `Retry-After`.
      const RetryKlass = Klass as typeof RateLimitError | typeof ServerError;
      return new RetryKlass(status, message, code, body, parseRetryAfter(retryAfter));
    }
    return new Klass(status, message, code, body);
  }
}

/** 401 — missing, malformed, expired, or revoked bearer token. */
export class AuthenticationError extends CoveAPIError {}
/** 403 — token lacks the required scope, or admin gate failed. */
export class PermissionDeniedError extends CoveAPIError {}
/** 404 — resource absent (Cove collapses most 403s into 404s). */
export class NotFoundError extends CoveAPIError {}
/** Why `vms.create` answered 409 — see {@link ConflictError.createConflict}. */
export type CreateConflict =
  | {
      /**
       * The name is held by a live VM, or is still in its post-delete cooldown;
       * `retryAfterSecs` is how long the cooldown has left (absent for a live VM).
       */
      kind: "name_taken";
      retryAfterSecs?: number;
    }
  | {
      /** A capacity or quota denial, with the numbers behind it. */
      kind: "denied";
      reason: DenyReason;
    };

/**
 * Every `DenyReason` `code`. A `Record` over the generated union, so a variant
 * the contract adds or drops is a compile error here until this list follows.
 */
const DENY_REASON_CODES: Record<DenyReason["code"], true> = {
  ram_headroom_exceeded: true,
  cpu_headroom_exceeded: true,
  disk_soft_limit_exceeded: true,
  disk_safety_buffer_exceeded: true,
  vm_limit_exceeded: true,
  pressure_denied_mem: true,
  pressure_denied_psi: true,
  swap_pressure_denied: true,
  pending_resize_exhausted: true,
  user_vcpu_quota_exceeded: true,
  user_ram_quota_exceeded: true,
  user_vm_count_quota_exceeded: true,
  user_disk_quota_exceeded: true,
  team_vcpu_quota_exceeded: true,
  team_ram_quota_exceeded: true,
  team_vm_count_quota_exceeded: true,
  team_disk_quota_exceeded: true,
};

/** 409 — operation conflicts with current state. */
export class ConflictError extends CoveAPIError {
  /**
   * Narrow a `vms.create` 409 (the contract's `VmCreateConflictResponse`, an
   * untagged union keyed on `code`) into why it was refused: a taken name, or
   * a capacity/quota `DenyReason`. `undefined` for any other 409 body. A
   * `vms.clone` 409 reads the same way, since a taken `new_vm_name` answers
   * the same body; its state conflicts are `undefined`.
   */
  createConflict(): CreateConflict | undefined {
    const body = this.body;
    if (!body || typeof body !== "object") return undefined;
    const code = (body as { code?: unknown }).code;
    if (code === "vm_name_taken") {
      const r = (body as { retry_after_secs?: unknown }).retry_after_secs;
      return { kind: "name_taken", retryAfterSecs: typeof r === "number" ? r : undefined };
    }
    if (typeof code === "string" && Object.prototype.hasOwnProperty.call(DENY_REASON_CODES, code)) {
      return { kind: "denied", reason: body as DenyReason };
    }
    return undefined;
  }
}
/**
 * 422, or 400 `validation_failed` — request shape or values rejected. The
 * server answers 400 `validation_failed` for a request it cannot decode
 * (malformed JSON, a field of the wrong type, an unknown enum value, a query
 * or path value of the wrong type) and 422 for a well-formed value it
 * refuses; `status` tells them apart. A 400 with any other code stays a plain
 * `CoveAPIError`.
 */
export class ValidationError extends CoveAPIError {}
/**
 * A `Retry-After` in delta-seconds (plain ASCII digits), else `undefined`.
 * The HTTP-date form, a sign, a fraction or anything else reads as absent:
 * the server only sends seconds, and a caller should not be handed a guess.
 */
function parseRetryAfter(header: string | null | undefined): number | undefined {
  const trimmed = header?.trim();
  return trimmed && /^[0-9]{1,9}$/.test(trimmed) ? Number(trimmed) : undefined;
}

/**
 * 429 `rate_limited` — this source IP spent its request budget on the bearer
 * listener. The budget is per source IP (default 30 requests per second, set
 * by the operator), so every caller behind one NAT or tunnel shares it. The
 * SDK never retries: wait `retryAfterSecs`, then send the request again.
 */
export class RateLimitError extends CoveAPIError {
  /**
   * The response's `Retry-After` in seconds; `undefined` when the header is
   * absent or not delta-seconds.
   */
  readonly retryAfterSecs?: number;

  constructor(
    status: number,
    message: string,
    code?: ErrorCode | (string & {}),
    body?: unknown,
    retryAfterSecs?: number,
  ) {
    super(status, message, code, body);
    this.retryAfterSecs = retryAfterSecs;
  }
}
/**
 * 426 with `code: "CLI_TOO_OLD"` — the server no longer speaks this SDK's API
 * version. Install the SDK that matches the server; the message says where.
 */
export class UpgradeRequiredError extends CoveAPIError {
  /** API version the server advertised in `x-cove-api-version`, when it sent one. */
  readonly serverApiVersion?: number;
  /**
   * `min_cli_version` from the body: the oldest cove-cli release that speaks
   * the server's API version (a cove-cli version, not an SDK version).
   */
  readonly minCliVersion?: string;

  constructor(
    status: number,
    message: string,
    code?: ErrorCode | (string & {}),
    body?: unknown,
    serverApiVersion?: number,
  ) {
    super(status, message, code, body);
    this.serverApiVersion = serverApiVersion;
    const m = (body as { min_cli_version?: unknown } | undefined)?.min_cli_version;
    if (typeof m === "string") this.minCliVersion = m;
  }
}

/**
 * Never names `baseUrl`: the SDK may be talking to the external bearer
 * listener, which does not serve `/public/sdk` — only the Warpgate-fronted
 * URL does.
 */
function upgradeMessage(serverApiVersion?: number): string {
  const server = serverApiVersion === undefined ? "" : ` (server version ${serverApiVersion})`;
  return (
    `This SDK speaks API version ${COVE_API_VERSION}; the server refused it${server}. ` +
    "Install the SDK that matches the server from its /public/sdk/index.json on the Warpgate-fronted URL."
  );
}

/** 5xx — server-side failure (503 also gates disabled subsystems, e.g. secrets). */
export class ServerError extends CoveAPIError {
  /**
   * The response's `Retry-After` in seconds when it sent one as
   * delta-seconds; otherwise `undefined`.
   */
  readonly retryAfterSecs?: number;

  constructor(
    status: number,
    message: string,
    code?: ErrorCode | (string & {}),
    body?: unknown,
    retryAfterSecs?: number,
  ) {
    super(status, message, code, body);
    this.retryAfterSecs = retryAfterSecs;
  }
}

/** 413 — the request or the resource is larger than the server allows. */
export class PayloadTooLargeError extends CoveAPIError {}

/**
 * 413 `file_too_large` — the file is larger than the host's `[files]
 * max_bytes`, or an upload body is longer than its `Content-Length`. The
 * message states the limit.
 */
export class FileTooLargeError extends PayloadTooLargeError {}
/**
 * 403 `file_path_denied` — the path is on the host's deny-list or on a pseudo
 * filesystem (`/proc`, `/sys`, …). Not a scope problem: a key without
 * `files:read`/`files:write` is a plain `PermissionDeniedError`
 * (`scope_denied`).
 */
export class FilePathDeniedError extends PermissionDeniedError {}
/** 404 `file_not_found` — the file or its parent directory does not exist in the VM. */
export class VmFileNotFoundError extends NotFoundError {}
/** 422 `file_not_regular` — the target is not a regular file, or a path component is a symlink. */
export class FileNotRegularError extends ValidationError {}
/**
 * 503 `unavailable` — something the operation depends on is not available
 * right now; the message says what. For file transfer: the guest agent
 * connection was lost or timed out, or the guest already has as many
 * transfers open as it allows. Retry.
 */
export class UnavailableError extends ServerError {}

/**
 * A download whose body did not match its `Content-Length`: the transfer
 * failed after the server had already sent `200`, so the body ended early (or
 * the connection broke). Never a complete file. `cause` is the transport's
 * error when the connection broke.
 */
export class DownloadTruncatedError extends CoveError {
  /** The file's size, from `Content-Length`. */
  readonly expectedBytes: number;
  /** How many bytes arrived before the body ended or failed. */
  readonly receivedBytes: number;

  constructor(expectedBytes: number, receivedBytes: number, options?: { cause?: unknown }) {
    super(
      receivedBytes > expectedBytes
        ? `Download sent more than its Content-Length of ${expectedBytes} bytes`
        : `Download ended after ${receivedBytes} of ${expectedBytes} bytes: the transfer failed`,
    );
    this.expectedBytes = expectedBytes;
    this.receivedBytes = receivedBytes;
    if (options && "cause" in options) {
      // Set by hand: the ES2022 `Error` cause option is newer than this package's ES2020 target.
      Object.defineProperty(this, "cause", { value: options.cause, configurable: true, writable: true });
    }
  }
}

const STATUS_MAP: Record<number, typeof CoveAPIError> = {
  401: AuthenticationError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  413: PayloadTooLargeError,
  422: ValidationError,
  429: RateLimitError,
};

/**
 * Error codes with a class of their own, each with the one status it comes
 * with; the same code on another status falls back to {@link STATUS_MAP}.
 * `validation_failed` comes with 422 too, which {@link STATUS_MAP} already
 * maps to `ValidationError`.
 */
const CODE_MAP: Partial<Record<string, [number, typeof CoveAPIError]>> = {
  validation_failed: [400, ValidationError],
  file_too_large: [413, FileTooLargeError],
  file_path_denied: [403, FilePathDeniedError],
  file_not_found: [404, VmFileNotFoundError],
  file_not_regular: [422, FileNotRegularError],
  unavailable: [503, UnavailableError],
};
