import { apiPath, type CoveHttp, type RequestOverrides } from "../http.js";
import type {
  BuildInfo,
  CliStatusResponse,
  ConnectedAppSummary,
  HealthResponse,
  ProfileSummary,
  Session,
  SshKey,
  WhoamiResponse,
} from "../types.js";

/**
 * `client.meta` — health, version, identity.
 *
 * "One prefix per subject": the caller's own routes
 * collapse from `/profile` and `/user/*` onto a single `/me` prefix.
 * `/whoami` is the one deliberate exception — it stays permanently rather
 * than deprecating, so `whoami()` below is unchanged.
 */
export class MetaResource {
  constructor(private readonly http: CoveHttp) {}

  /** Daemon health and version info. Anonymous — no bearer token required. */
  health(overrides: RequestOverrides = {}): Promise<HealthResponse> {
    return this.http.request<HealthResponse>("GET", apiPath`/api/health`, overrides);
  }

  /** Server build metadata. Anonymous — no bearer token required. */
  version(overrides: RequestOverrides = {}): Promise<BuildInfo> {
    return this.http.request<BuildInfo>("GET", apiPath`/api/version`, overrides);
  }

  /**
   * Resolve the caller's username. No scope beyond a valid bearer token.
   * Permanent alias — kept forever, not deprecated (a deliberate decision).
   *
   * This is not a rename shim for {@link MetaResource.me}: it is a
   * deliberately separate, permanently-supported operation. `whoami` is a
   * cheap identity probe that touches nothing external, so it stays
   * available whenever the caller's token is valid. `me` assembles the full
   * caller summary (quota usage included) from several bastion calls, so
   * it is only as available as the bastion is. Use `whoami` when you just
   * need to know who you are; use `me` when you need the summary and can
   * tolerate the bastion being the dependency.
   */
  whoami(overrides: RequestOverrides = {}): Promise<WhoamiResponse> {
    return this.http.request<WhoamiResponse>("GET", apiPath`/api/whoami`, overrides);
  }

  /**
   * Caller summary, including quota usage, `permissions` (what this
   * credential may do: a key's complete scope list, or `session`) and
   * `is_admin`; `hasScope(me, scope)` reads the permissions for you. No scope
   * beyond a valid bearer token. Errors from this endpoint are plain-text
   * bodies, not the `ApiError` envelope (handled transparently by `CoveAPIError.fromResponse`).
   */
  me(overrides: RequestOverrides = {}): Promise<ProfileSummary> {
    return this.http.request<ProfileSummary>("GET", apiPath`/api/me`, overrides);
  }

  /**
   * Caller's registered SSH keys (read-only). No scope beyond a valid
   * bearer token. SSH key mutation is not mounted on this surface. Errors
   * are plain-text bodies, not the `ApiError` envelope.
   */
  meKeys(overrides: RequestOverrides = {}): Promise<SshKey[]> {
    return this.http.request<SshKey[]>("GET", apiPath`/api/me/keys`, overrides);
  }

  /**
   * The MCP clients the caller has connected to Cove by signing in (connected
   * apps), newest first. No scope beyond a valid bearer token. Revoking one
   * is not served on the bearer listener; do it from the profile page.
   */
  meConnectedApps(overrides: RequestOverrides = {}): Promise<ConnectedAppSummary[]> {
    return this.http.request<ConnectedAppSummary[]>(
      "GET",
      apiPath`/api/me/connected-apps`,
      overrides,
    );
  }

  /**
   * Every username the server knows, sorted. Scope: `vms:read`; over an API
   * key this full listing also needs an admin key (`cove key create --admin`)
   * of an administrator, and any other key gets 403 `admin_required`.
   * Sessions are unchanged.
   */
  users(overrides: RequestOverrides = {}): Promise<string[]> {
    return this.http.request<string[]>("GET", apiPath`/api/users`, overrides);
  }

  /**
   * The server's own OpenAPI 3.1 description, parsed. It matches the
   * `sdk/openapi.yaml` of the same release. Anonymous: no bearer token
   * required.
   */
  openapi(overrides: RequestOverrides = {}): Promise<Record<string, unknown>> {
    return this.http.request<Record<string, unknown>>(
      "GET",
      apiPath`/api/openapi.json`,
      overrides,
    );
  }

  /**
   * The caller's own CLI sessions, active and past. No scope beyond a valid
   * bearer token: the data is about the caller alone. Revoking one is not
   * offered to an API key (`revokeSession` is not served on the bearer
   * listener).
   */
  sessions(overrides: RequestOverrides = {}): Promise<Session[]> {
    return this.http.request<Session[]>("GET", apiPath`/api/me/sessions`, overrides);
  }

  /** CLI ticket status for the caller. No scope beyond a valid bearer token. */
  cliStatus(overrides: RequestOverrides = {}): Promise<CliStatusResponse> {
    return this.http.request<CliStatusResponse>("GET", apiPath`/api/me/cli-status`, overrides);
  }
}
