import { CoveError, CoveTimeoutError } from "../errors.js";
import { apiPath, isAbortLike, type CoveHttp, type RequestOverrides } from "../http.js";
import type {
  CreatedKey,
  CreateKeyRequest,
  KeySummary,
  ListApiKeysParams,
} from "../types.js";

/**
 * First server API version that serves service keys: `service` and `member`
 * on create, and `service: true` on list. An older server ignores them, so it
 * would mint a team key, or a personal key acting as the caller, and list the
 * caller's own keys. Equal to the server's `SERVICE_KEYS_API_VERSION`;
 * `cove/cove-cli/tests/version_drift.rs` checks the two stay equal.
 */
export const SERVICE_KEYS_MIN_API_VERSION: number = 6;

/** `client.keys` — bearer API key management. */
export class KeysResource {
  constructor(private readonly http: CoveHttp) {}

  /**
   * List API keys (never includes raw tokens). Scope: `keys:manage`. Your own
   * keys by default; `{ team }` lists a team's and `{ service: true }` every
   * service key (both administrators only; over the bearer API an ordinary
   * `cvk_` key does not count as one, so these need a `ticket` client or an
   * admin key that also holds `keys:manage`, else 403).
   * `service: true` needs a server at API version 6 or later: the SDK first
   * reads the server's version from a `GET /api/whoami` and throws a
   * `CoveError`, sending nothing, when the server is older or its version
   * cannot be read.
   */
  async list(
    params: ListApiKeysParams = {},
    overrides: RequestOverrides = {},
  ): Promise<KeySummary[]> {
    if (params.service) await this.requireServiceKeys(overrides);
    return this.http.request<KeySummary[]>("GET", apiPath`/api/api-keys`, {
      ...overrides,
      query: { team: params.team, service: params.service },
    });
  }

  /**
   * Create an API key. Scope: `keys:manage`.
   * The `raw_token` in the response is shown exactly once. Omit `scopes` for
   * the default set; an empty list is refused (422). The fields keep their
   * wire names (`admin_key`, `expires_in_secs`, …).
   *
   * Four kinds, picked by the fields:
   *
   * - **Personal key** (no `team`, `service` or `admin_key`): acts as you.
   *   Never expires unless you set `expires_in_secs`, within the server's
   *   `[auth] max_key_lifetime_days` cap (default 365). It cannot hold
   *   `admin` or any `admin:*` permission.
   * - **Admin key** (`admin_key: true`): the only kind that may hold `admin`
   *   or `admin:*`, and it must hold at least one. It needs `expires_in_secs`
   *   within `[auth] admin_max_key_lifetime_days` (default 30, never above
   *   the general cap). Only an administrator (`[auth] admins`) may mint one
   *   (403 otherwise). Never with `team` or `service`.
   *   An admin key cannot be minted over the bearer API at all: any API key,
   *   admin key or not, gets 403. Mint it from a signed-in session, never
   *   with a `cvk_` key. From the SDK that means a client built with a
   *   `ticket`; `cove key create --admin` over SSH or in the REPL, or from a
   *   CLI signed in through the browser with `cove login` (not `--api-key`),
   *   does the same. The web UI is a session too, but has no control for it
   *   yet. Creating a key is sudo-gated: a ticket older than `[daemon]
   *   sudo_window_secs` (default 900 seconds) gets 401 `sudo_required`
   *   (`AuthenticationError`) until a fresh `cove login`. Rotating one is refused over an API key in the same
   *   way. An admin key can still mint and rotate ordinary keys.
   * - **Team key** (`team`): administrators only (403 otherwise; over the
   *   bearer API only a `ticket` client or an admin key holding `keys:manage`
   *   counts as one); needs
   *   `expires_in_secs` within the general cap; cannot hold `keys:manage`,
   *   `access:write`, `admin` or `admin:*`.
   * - **Service key** (`service: "<name>"`, minted as `svc:<name>`):
   *   administrators only (403 otherwise; as for a team key, an ordinary
   *   `cvk_` key does not count). Exactly
   *   one of `team` or `member` names its binding — the team, or the one
   *   member, its VMs are charged to and controlled by; `member` without
   *   `service` is refused. Needs `expires_in_secs` within the general cap;
   *   cannot hold `keys:manage`, `access:write`, `admin` or `admin:*`.
   *   It needs a server at API version 6 or later: the SDK first reads the
   *   server's version from a `GET /api/whoami` and throws a `CoveError`,
   *   sending nothing, when the server is older or its version cannot be
   *   read, since an older server would ignore both `service` and `member`.
   *
   * A team or service key cannot mint keys itself.
   */
  async create(req: CreateKeyRequest, overrides: RequestOverrides = {}): Promise<CreatedKey> {
    if (req.service != null || req.member != null) await this.requireServiceKeys(overrides);
    return this.http.request<CreatedKey>("POST", apiPath`/api/api-keys`, {
      ...overrides,
      body: req,
    });
  }

  /**
   * Refuse a service-key call unless the server advertises
   * {@link SERVICE_KEYS_MIN_API_VERSION} or later. A missing, zero or
   * unreadable version is refused too: nothing shows the server is new enough.
   */
  private async requireServiceKeys(overrides: RequestOverrides): Promise<void> {
    let version: number | undefined;
    try {
      // Every successful server response carries `x-cove-api-version` (the
      // external listener's own 401, 426 and 429 do not; those refuse here). `/api/whoami` is
      // in the contract and served on every listener, so its response header
      // is the version; `/api/health` is served on the external bearer
      // listener only, and root `/health` is not in the contract. Read from
      // this response, not the client-wide last-seen value, which a reply
      // without the header would leave at an earlier response's version.
      await this.http.request("GET", apiPath`/api/whoami`, {
        signal: overrides.signal,
        timeoutMs: overrides.timeoutMs,
        onApiVersion: (v) => {
          version = v;
        },
      });
    } catch (err) {
      // A deadline or the caller's own abort keeps its identity; only other
      // failures mean "cannot confirm".
      if (err instanceof CoveTimeoutError || isAbortLike(err)) throw err;
      throw new CoveError(
        `could not read the server's API version (${err instanceof Error ? err.message : String(err)}), ` +
          `so cannot confirm it serves service keys (API version ${SERVICE_KEYS_MIN_API_VERSION} or later); nothing was sent`,
      );
    }
    if (!version || version < SERVICE_KEYS_MIN_API_VERSION) {
      throw new CoveError(
        `this server speaks API version ${version ?? "unknown"}; service keys need API version ` +
          `${SERVICE_KEYS_MIN_API_VERSION} or later, and an older server would mint or list the wrong kind of key; nothing was sent`,
      );
    }
  }

  /**
   * Revoke an API key: your own, or anyone's as an administrator (signed in or
   * through an admin key). Scope: `keys:manage`. Requests with the key are
   * refused 401 at once; streams already open with it (events, console, exec)
   * end within the server's 15 s re-check interval.
   */
  revoke(id: string, overrides: RequestOverrides = {}): Promise<void> {
    return this.http.request<void>("DELETE", apiPath`/api/api-keys/${id}`, overrides);
  }

  /**
   * Revoke an API key by presenting it: holding the key is the proof, so any
   * key works, yours or one you found, and the call needs no scope (on the
   * bearer listener, no credential at all). Resolves alike whether the key was
   * live (it is revoked, as by its owner), already revoked, unknown or not a
   * key, so it tells you nothing about it. Never log `token`.
   */
  revokeByToken(token: string, overrides: RequestOverrides = {}): Promise<void> {
    return this.http.request<void>("POST", apiPath`/api/api-keys/revoke`, {
      ...overrides,
      body: { token },
    });
  }

  /**
   * Rotate an API key (atomic mint + revoke). Scope: `keys:manage`.
   * Returns a replacement key with a new show-once raw token.
   */
  rotate(id: string, overrides: RequestOverrides = {}): Promise<CreatedKey> {
    return this.http.request<CreatedKey>(
      "POST",
      apiPath`/api/api-keys/${id}/rotate`,
      overrides,
    );
  }
}
