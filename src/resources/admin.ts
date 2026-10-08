import { apiPath, type CoveHttp, type RequestOverrides } from "../http.js";
import type {
  AdminBulkVmRequest,
  AdminBulkVmResponse,
  AdminCheckpointSummary,
  AdminCheckpointSummaryPage,
  AdminDrainResponse,
  AdminForceCreateResponse,
  AdminHostStateResponse,
  AdminQuotaDefaultsResponse,
  AdminQuotaOverrideRequest,
  AdminQuotaOverrideResponse,
  AdminRetimeoutRequest,
  AdminRetimeoutResponse,
  AdminTeamQuotaOverrideRequest,
  AdminTeamQuotaOverrideResponse,
  AdminUserSummary,
  AdminVmSummary,
  AdminVmSummaryPage,
  DrainHostParams,
  ListAllVmsParams,
  ListAnyCheckpointsParams,
  OffboardUserReport,
  OffboardUserRequest,
  ProjectMember,
  RevokeSessionsResponse,
  UpdateAgentsResponse,
} from "../types.js";

/** A value for an error message; never throws (a BigInt or a cycle included). */
function describe(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return typeof v === "bigint" ? `${v}n` : Object.prototype.toString.call(v);
  }
}

/** Why `req` is not a well-formed offboarding request, or `undefined`. */
function offboardRequestError(req: unknown): string | undefined {
  // Plain objects only: a boxed boolean, a Map, a Date or a class instance
  // is never a request, even one with no own keys that would read as `{}`.
  if (typeof req !== "object" || req === null) {
    return `the request must be a plain object like { dry_run: true }, got ${describe(req)}`;
  }
  const proto: unknown = Object.getPrototypeOf(req);
  if (proto !== Object.prototype && proto !== null) {
    return `the request must be a plain object like { dry_run: true }, got ${describe(req)}`;
  }
  // Every own key, non-enumerable and symbol ones included.
  const extra = Reflect.ownKeys(req).filter((k) => k !== "dry_run");
  if (extra.length > 0) {
    return `unknown field(s) ${extra.map(String).join(", ")}; the only field is dry_run`;
  }
  const dryRun = (req as { dry_run?: unknown }).dry_run;
  if (dryRun !== undefined && typeof dryRun !== "boolean") {
    return `dry_run must be a boolean, got ${describe(dryRun)}`;
  }
  return undefined;
}

/**
 * `client.admin` — fleet administration: host-wide listings, bulk VM
 * operations, quotas, project membership, sessions and the guest agent push.
 *
 * Every method needs an administrator: the caller must be in the server's
 * `[auth] admins`, and an API key must also hold the method's `admin:*` scope
 * (bare `admin` satisfies them all) and must be an admin key (minted with
 * `cove key create --admin`, short-lived); an ordinary or pre-upgrade key with
 * the scope gets 403 `admin_required`. Either refusal is a 403
 * (`PermissionDeniedError`, code `admin_required` or `scope_denied`).
 *
 * A 404 means absent or not yours; the SDK never turns it into "forbidden".
 * Every operation here is served on the external API listener of every host.
 *
 * Six refuse every API key, an admin key included, with 401 `sudo_required`.
 * {@link updateVmAgents}, {@link bulkStopVms}, {@link bulkDeleteVms},
 * {@link deleteAnyCheckpoint} and {@link offboardUser} need a recent
 * interactive sign-in, so they run
 * with a ticket or a session, never a key. {@link drainHost} is never served
 * on the Warpgate-fronted listener either: in practice a drain runs on the
 * host's Unix socket.
 */
export class AdminResource {
  constructor(private readonly http: CoveHttp) {}

  // -------------------------------------------------------------------------
  // Fleet
  // -------------------------------------------------------------------------

  /**
   * Re-apply the idle timeout across every auto-pausing VM. `to_secs` is the
   * new value (omitted: the host default); `from_secs` narrows the change to
   * VMs sitting on exactly that value. Send `dry_run: true` first: the answer
   * has the same shape and only `dry_run: false` writes.
   * Scope: `admin:fleet:write`. 403 not an administrator; 422 target timeout
   * out of range; 404 means absent or not yours.
   */
  updateAutoPauseTimeouts(
    req: AdminRetimeoutRequest,
    overrides: RequestOverrides = {},
  ): Promise<AdminRetimeoutResponse> {
    return this.http.request<AdminRetimeoutResponse>(
      "POST",
      apiPath`/api/admin/auto-pause/retimeout`,
      { ...overrides, body: req },
    );
  }

  /**
   * Stop every VM on the host, within `budget_secs` (omitted: the host's
   * configured drain budget). `succeeded + failed + timed_out` accounts for
   * `attempted`. Scope: `admin:fleet:write`. 404 means absent or not yours.
   * Every API key is refused 401 `sudo_required` (`AuthenticationError`), and
   * drain is never served on the Warpgate-fronted listener: in practice a
   * drain runs on the host's Unix socket.
   */
  drainHost(
    params: DrainHostParams = {},
    overrides: RequestOverrides = {},
  ): Promise<AdminDrainResponse> {
    return this.http.request<AdminDrainResponse>("POST", apiPath`/api/admin/drain`, {
      ...overrides,
      query: { budget_secs: params.budget_secs },
    });
  }

  /**
   * Read the host's administrative gauges (TTL backlog, snapshot images,
   * orphaned checkpoints, audit and broadcast health). Scope:
   * `admin:host:read`. 403 not an administrator; 404 means absent or not
   * yours.
   */
  getHostState(overrides: RequestOverrides = {}): Promise<AdminHostStateResponse> {
    return this.http.request<AdminHostStateResponse>(
      "GET",
      apiPath`/api/admin/host-state`,
      overrides,
    );
  }

  /**
   * Replace the Cove agent binary inside every running VM. `binary` is the
   * raw agent executable, sent as `application/octet-stream` exactly as given;
   * an empty body is refused. `failed > 0` in the answer is a normal result,
   * not an error. Scope: `admin:agent-push`. 400 empty body; 403 not an
   * administrator; 404 means absent or not yours.
   * 401 `sudo_required` for every API key, an admin key included: it needs a
   * ticket or a session (`AuthenticationError`).
   */
  updateVmAgents(
    binary: Blob | ArrayBuffer | Uint8Array,
    overrides: RequestOverrides = {},
  ): Promise<UpdateAgentsResponse> {
    return this.http.request<UpdateAgentsResponse>("POST", apiPath`/api/admin/update-agents`, {
      ...overrides,
      rawBody: binary,
      contentType: "application/octet-stream",
    });
  }

  /**
   * Delete many VMs in one call: every VM, one person's, or a named list
   * (`scope`). `dry_run: true` reports the targets without touching them.
   * `failed > 0` is a normal result. Scope: `admin:fleet:delete`. 403 not an
   * administrator; 422 `include_pool` with a single-user scope; 404 means
   * absent or not yours.
   * 401 `sudo_required` for every API key, an admin key included: it needs a
   * ticket or a session (`AuthenticationError`).
   */
  bulkDeleteVms(
    req: AdminBulkVmRequest,
    overrides: RequestOverrides = {},
  ): Promise<AdminBulkVmResponse> {
    return this.http.request<AdminBulkVmResponse>("POST", apiPath`/api/admin/vms/delete-bulk`, {
      ...overrides,
      body: req,
    });
  }

  /**
   * Stop many VMs in one call; `scope` and `dry_run` as in
   * {@link bulkDeleteVms}. `failed > 0` is a normal result. Scope:
   * `admin:fleet:write`. 403 not an administrator; 422 `include_pool` with a
   * single-user scope; 404 means absent or not yours.
   * 401 `sudo_required` for every API key, an admin key included: it needs a
   * ticket or a session (`AuthenticationError`).
   */
  bulkStopVms(
    req: AdminBulkVmRequest,
    overrides: RequestOverrides = {},
  ): Promise<AdminBulkVmResponse> {
    return this.http.request<AdminBulkVmResponse>("POST", apiPath`/api/admin/vms/stop-bulk`, {
      ...overrides,
      body: req,
    });
  }

  // -------------------------------------------------------------------------
  // Projects and quotas
  // -------------------------------------------------------------------------

  /**
   * List a project's members, alphabetical by username. Scope:
   * `admin:projects:read`. 403 not an administrator; 404 means absent or not
   * yours.
   */
  listProjectMembers(
    projectId: string,
    overrides: RequestOverrides = {},
  ): Promise<ProjectMember[]> {
    return this.http.request<ProjectMember[]>(
      "GET",
      apiPath`/api/admin/projects/${projectId}/members`,
      overrides,
    );
  }

  /**
   * Add someone to a project; adding an existing member succeeds too. The
   * wire body repeats the project id, which the SDK fills from `projectId`.
   * Scope: `admin:projects:write`. 400 `projectId` is not an acceptable
   * project name; 403 not an administrator; 404 means absent or not yours.
   */
  createProjectMember(
    projectId: string,
    username: string,
    overrides: RequestOverrides = {},
  ): Promise<void> {
    return this.http.request<void>("POST", apiPath`/api/admin/projects/${projectId}/members`, {
      ...overrides,
      body: { project_id: projectId, username },
    });
  }

  /**
   * Remove someone from a project; removing a non-member succeeds too. Scope:
   * `admin:projects:write`. 403 not an administrator; 404 means absent or not
   * yours.
   */
  deleteProjectMember(
    projectId: string,
    username: string,
    overrides: RequestOverrides = {},
  ): Promise<void> {
    return this.http.request<void>(
      "DELETE",
      apiPath`/api/admin/projects/${projectId}/members/${username}`,
      overrides,
    );
  }

  /**
   * Read the host-wide default resource caps. Scope: `admin:quotas:read`. 403
   * not an administrator; 404 means absent or not yours.
   */
  getQuotaDefaults(overrides: RequestOverrides = {}): Promise<AdminQuotaDefaultsResponse> {
    return this.http.request<AdminQuotaDefaultsResponse>(
      "GET",
      apiPath`/api/admin/quota-defaults`,
      overrides,
    );
  }

  /**
   * Read one person's resource-cap overrides; `null` in a dimension means the
   * host default applies. Scope: `admin:quotas:read`. 403 not an
   * administrator; 404 means absent or not yours.
   */
  getUserQuotaOverride(
    username: string,
    overrides: RequestOverrides = {},
  ): Promise<AdminQuotaOverrideResponse> {
    return this.http.request<AdminQuotaOverrideResponse>(
      "GET",
      apiPath`/api/admin/quotas/${username}`,
      overrides,
    );
  }

  /**
   * Set one person's resource-cap overrides. Scope: `admin:quotas:write`. 403
   * not an administrator; 422 `validation_failed` for an invalid username
   * (nothing stored); 404 means absent or not yours.
   */
  updateUserQuotaOverride(
    username: string,
    req: AdminQuotaOverrideRequest,
    overrides: RequestOverrides = {},
  ): Promise<void> {
    return this.http.request<void>("PUT", apiPath`/api/admin/quotas/${username}`, {
      ...overrides,
      body: req,
    });
  }

  /**
   * Drop one person's resource-cap overrides; succeeds when there were none.
   * Scope: `admin:quotas:write`. 403 not an administrator; 404 means absent or
   * not yours.
   */
  deleteUserQuotaOverride(username: string, overrides: RequestOverrides = {}): Promise<void> {
    return this.http.request<void>("DELETE", apiPath`/api/admin/quotas/${username}`, overrides);
  }

  /**
   * Let someone exceed their resource caps once: issues a one-shot pass,
   * spent only by a create that would otherwise be denied. Scope:
   * `admin:quotas:write`. 403 not an administrator; 404 means absent or not
   * yours.
   */
  createQuotaBypass(
    username: string,
    overrides: RequestOverrides = {},
  ): Promise<AdminForceCreateResponse> {
    return this.http.request<AdminForceCreateResponse>(
      "POST",
      apiPath`/api/admin/quotas/${username}/force-create`,
      overrides,
    );
  }

  /**
   * Read one team's resource-cap overrides; `null` in a dimension means the
   * host default applies. Scope: `admin:quotas:read`. 403 not an
   * administrator; 404 means absent or not yours.
   */
  getTeamQuotaOverride(
    teamId: string,
    overrides: RequestOverrides = {},
  ): Promise<AdminTeamQuotaOverrideResponse> {
    return this.http.request<AdminTeamQuotaOverrideResponse>(
      "GET",
      apiPath`/api/admin/team-quotas/${teamId}`,
      overrides,
    );
  }

  /**
   * Set one team's resource-cap overrides. Scope: `admin:quotas:write`. 403
   * not an administrator; 404 means absent or not yours.
   */
  updateTeamQuotaOverride(
    teamId: string,
    req: AdminTeamQuotaOverrideRequest,
    overrides: RequestOverrides = {},
  ): Promise<void> {
    return this.http.request<void>("PUT", apiPath`/api/admin/team-quotas/${teamId}`, {
      ...overrides,
      body: req,
    });
  }

  /**
   * Drop one team's resource-cap overrides; succeeds when there were none.
   * Scope: `admin:quotas:write`. 403 not an administrator; 404 means absent or
   * not yours.
   */
  deleteTeamQuotaOverride(teamId: string, overrides: RequestOverrides = {}): Promise<void> {
    return this.http.request<void>(
      "DELETE",
      apiPath`/api/admin/team-quotas/${teamId}`,
      overrides,
    );
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  /**
   * List every account Cove knows, with its resource usage, alphabetical by
   * username. Scope: `admin:users:read`. 403 not an administrator; 404 means
   * absent or not yours.
   */
  listAllUsers(overrides: RequestOverrides = {}): Promise<AdminUserSummary[]> {
    return this.http.request<AdminUserSummary[]>("GET", apiPath`/api/admin/users`, overrides);
  }

  /**
   * Read one account and its resource usage. Scope: `admin:users:read`. 403
   * not an administrator; 404 means absent or not yours (for an unknown
   * username the body is plain text, `user not found`, so `err.body` is a
   * string).
   */
  getUser(username: string, overrides: RequestOverrides = {}): Promise<AdminUserSummary> {
    return this.http.request<AdminUserSummary>(
      "GET",
      apiPath`/api/admin/users/${username}`,
      overrides,
    );
  }

  /**
   * Invalidate every session one person holds; answers how many. Also revokes
   * the person's connected apps; the count is CLI sessions only. Scope:
   * `admin:sessions:write`. 403 not an administrator; 404 means absent or not
   * yours. 503 `unavailable` when the bastion kept any CLI session: those
   * stay valid, everything else was revoked, and repeating the call retries
   * only the sessions left.
   */
  revokeUserSessions(
    username: string,
    overrides: RequestOverrides = {},
  ): Promise<RevokeSessionsResponse> {
    return this.http.request<RevokeSessionsResponse>(
      "POST",
      apiPath`/api/admin/users/${username}/revoke-sessions`,
      overrides,
    );
  }

  /**
   * Offboard one person: in one transaction their CLI sessions, connected
   * apps, bound service keys, every direct share to them on any VM, their
   * own personal and admin API keys and webhooks. Then, item by item: first
   * Cove's own Warpgate role for them is deleted (`warpgate_role`),
   * unbinding their VMs' targets (the targets stay; no other role is
   * touched); next their Warpgate user is deleted (`warpgate_user`), taking
   * their Warpgate roles, user API tokens, passwords, one-time codes and
   * certificates with it (`outcome: "not_found"` when Warpgate has no such
   * role or user, not a failure); then, belt and braces, their
   * SSH keys at Warpgate (`ssh_keys_deleted`), every Warpgate ticket in their
   * name (`tickets_deleted`) and every live Warpgate session of theirs
   * (`sessions_closed`), pass after pass until one finds nothing new (three
   * at most); then the credential sweep runs once more, to end what a
   * still-open session created meanwhile; then every team they belong to,
   * every secret in their own scope and every VM they own (stopped, never
   * deleted). The answer reports each item, still with a 200 when some
   * failed. A failed item is an entry with `ok: false` and an `error`, a VM,
   * a `warpgate_role` or a `warpgate_user` with `outcome: "failed"`, any entry of `cli_sessions_failed` (a CLI
   * session Warpgate could not delete; it has no `ok`), or a set
   * `second_sweep_error` (the sweep after the sessions closed failed): run
   * the call again. Send `{ dry_run: true }` to get the same report with
   * nothing changed; a real run is `{ dry_run: false }` (the default) or an
   * empty body, and anything else is a 400. The wrapper always sends an
   * explicit `dry_run`, and rejects with a `TypeError`, sending nothing, when
   * `req` is not a plain object whose only field is a boolean `dry_run`. Scope: `admin:sessions:write`. 403 not an administrator;
   * 404 a user Cove knows nothing of (never signed in, and no membership,
   * share, binding, key, webhook or VM names them).
   * 401 `sudo_required` for every API key, an admin key included: it needs a
   * ticket or a session (`AuthenticationError`).
   */
  offboardUser(
    username: string,
    req: Partial<OffboardUserRequest> = {},
    overrides: RequestOverrides = {},
  ): Promise<OffboardUserReport> {
    // A JavaScript caller gets no excess-property check, and a malformed
    // request read loosely would become a real offboarding where a preview
    // was meant. So refuse anything but `{ dry_run?: boolean }`, sending
    // nothing.
    const bad = offboardRequestError(req);
    if (bad !== undefined) {
      return Promise.reject(new TypeError(`offboardUser: ${bad}`));
    }
    // Always an explicit boolean: the server refuses `{}`.
    const body: OffboardUserRequest = { dry_run: req.dry_run === true };
    return this.http.request<OffboardUserReport>(
      "POST",
      apiPath`/api/admin/users/${username}/offboard`,
      { ...overrides, body },
    );
  }

  // -------------------------------------------------------------------------
  // Host-wide listings and checkpoints
  // -------------------------------------------------------------------------

  /**
   * List every VM on the host, or one person's (`user`), cursor-paginated.
   * Returns one page; use {@link iterAllVms} to walk them all. Scope:
   * `admin:vms:read`. 400 unparseable `cursor`; 403 not an administrator; 404
   * means absent or not yours.
   */
  listAllVms(
    params: ListAllVmsParams = {},
    overrides: RequestOverrides = {},
  ): Promise<AdminVmSummaryPage> {
    return this.http.request<AdminVmSummaryPage>("GET", apiPath`/api/admin/vms`, {
      ...overrides,
      query: { user: params.user, limit: params.limit, cursor: params.cursor },
    });
  }

  /**
   * Iterate every VM on the host (or one person's), transparently following
   * `next_cursor` across pages. Scope and statuses as {@link listAllVms};
   * `timeoutMs` applies per page.
   */
  async *iterAllVms(
    params: ListAllVmsParams = {},
    overrides: RequestOverrides = {},
  ): AsyncGenerator<AdminVmSummary> {
    let cursor = params.cursor;
    for (;;) {
      const page = await this.listAllVms({ ...params, cursor }, overrides);
      for (const vm of page.vms) yield vm;
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  /**
   * List every checkpoint on the host, with its owner, orphan status and size,
   * cursor-paginated; `user` and `orphaned` narrow it. Returns one page; use
   * {@link iterAnyCheckpoints} to walk them all. Scope:
   * `admin:checkpoints:read`. 400 unparseable `cursor`; 403 not an
   * administrator; 404 means absent or not yours.
   */
  listAnyCheckpoints(
    params: ListAnyCheckpointsParams = {},
    overrides: RequestOverrides = {},
  ): Promise<AdminCheckpointSummaryPage> {
    return this.http.request<AdminCheckpointSummaryPage>("GET", apiPath`/api/admin/checkpoints`, {
      ...overrides,
      query: {
        user: params.user,
        orphaned: params.orphaned,
        limit: params.limit,
        cursor: params.cursor,
      },
    });
  }

  /**
   * Iterate every checkpoint on the host (filtered as
   * {@link listAnyCheckpoints}), transparently following `next_cursor` across
   * pages. Scope and statuses as {@link listAnyCheckpoints}; `timeoutMs`
   * applies per page.
   */
  async *iterAnyCheckpoints(
    params: ListAnyCheckpointsParams = {},
    overrides: RequestOverrides = {},
  ): AsyncGenerator<AdminCheckpointSummary> {
    let cursor = params.cursor;
    for (;;) {
      const page = await this.listAnyCheckpoints({ ...params, cursor }, overrides);
      for (const checkpoint of page.checkpoints) yield checkpoint;
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  /**
   * Delete any checkpoint, whoever owns it, including an orphan whose source
   * VM is gone. Scope: `admin:checkpoints:write`. 403 not an administrator;
   * 404 means absent or not yours (no checkpoint with that id); 409 a live
   * clone still depends on it, or a restore is in flight.
   * 401 `sudo_required` for every API key, an admin key included: it needs a
   * ticket or a session (`AuthenticationError`).
   */
  deleteAnyCheckpoint(id: string, overrides: RequestOverrides = {}): Promise<void> {
    return this.http.request<void>("DELETE", apiPath`/api/admin/checkpoints/${id}`, overrides);
  }
}
