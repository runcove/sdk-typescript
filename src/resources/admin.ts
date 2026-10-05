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
  ProjectMember,
  RevokeSessionsResponse,
  UpdateAgentsResponse,
} from "../types.js";

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
 * Five refuse every API key, an admin key included, with 401 `sudo_required`.
 * {@link updateVmAgents}, {@link bulkStopVms}, {@link bulkDeleteVms} and
 * {@link deleteAnyCheckpoint} need a recent interactive sign-in, so they run
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
   * yours.
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
