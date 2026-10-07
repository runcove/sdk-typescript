/** `@runcove/sdk` — TypeScript SDK for the Cove external REST API. */

export { CoveClient } from "./client.js";
export type { CoveClientOptions } from "./client.js";

/** Per-call transport overrides — the last parameter of every resource method. */
export type { RequestOverrides, VersionSkewHook, VersionSkewInfo } from "./http.js";

/** The API version this SDK speaks, generated from `info.version` of `sdk/openapi.yaml`. */
export { COVE_API_VERSION } from "./http.js";

export { BearerAuth, TicketAuth, resolveAuth } from "./auth.js";
export type { CoveAuth, AuthOptions } from "./auth.js";

export {
  CoveError,
  CoveConfigError,
  CoveConnectionError,
  CoveTimeoutError,
  CoveAPIError,
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  ConflictError,
  ValidationError,
  RateLimitError,
  UpgradeRequiredError,
  ServerError,
  PayloadTooLargeError,
  FileTooLargeError,
  FilePathDeniedError,
  VmFileNotFoundError,
  FileNotRegularError,
  UnavailableError,
  DownloadTruncatedError,
  ERROR_CODES,
} from "./errors.js";
export type { CreateConflict } from "./errors.js";

export { parseSSE } from "./sse.js";
export type { ServerSentEvent } from "./sse.js";

export { verifyWebhookSignature } from "./webhook.js";
export type { VerifyWebhookOptions } from "./webhook.js";

export type { ExecOptions, ExecWithSecretsOptions } from "./resources/vms.js";
export type { EventStreamOptions } from "./resources/events.js";
export { VmFilesResource } from "./resources/files.js";
export type {
  VmFileStat,
  VmFileDownload,
  VmFileUploadBody,
  VmFileUploadOptions,
} from "./resources/files.js";
export { SecretsScope } from "./resources/secrets.js";
export {
  SpotlightResource,
  SPOTLIGHT_DEFAULT_PROTECT,
  SPOTLIGHT_TAGS,
} from "./resources/spotlight.js";
export type {
  SpotlightOnOptions,
  SpotlightOffOptions,
  SpotlightOnResult,
  SpotlightOffResult,
  SpotlightStatus,
} from "./resources/spotlight.js";
export { SERVICE_KEYS_MIN_API_VERSION } from "./resources/keys.js";

export * from "./types.js";
