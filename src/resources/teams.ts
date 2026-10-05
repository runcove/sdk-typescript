import { apiPath, type CoveHttp, type RequestOverrides } from "../http.js";
import type {
  AddMemberRequest,
  CreateTeamRequest,
  RemoveMemberOutcome,
  TeamDeleteOutcome,
  TeamMemberEntry,
  TeamSummary,
} from "../types.js";

/**
 * `client.teams` — teams and their rosters.
 *
 * Listing every team needs `teams:read` and, over an API key, an admin key of
 * an administrator; signed-in sessions are unchanged. A member reads their own
 * team's roster with `listMembers`. Changing a team or its roster needs an
 * administrator and `teams:write`. A 404 means absent
 * or not yours; the SDK never turns it into "forbidden".
 *
 * Every operation here is served on the external API listener of every host.
 */
export class TeamsResource {
  constructor(private readonly http: CoveHttp) {}

  /**
   * Every team, with its member count. Scope: `teams:read`; over an API key
   * this full listing also needs an admin key (`cove key create --admin`) of
   * an administrator, and any other key gets 403 `admin_required`. Sessions
   * are unchanged. `created_by` is present only for an administrator.
   */
  list(overrides: RequestOverrides = {}): Promise<TeamSummary[]> {
    return this.http.request<TeamSummary[]>("GET", apiPath`/api/teams`, overrides);
  }

  /**
   * Create a team (201). Scope: `teams:write`; administrators only. 403 not
   * an administrator.
   */
  create(req: CreateTeamRequest, overrides: RequestOverrides = {}): Promise<TeamSummary> {
    return this.http.request<TeamSummary>("POST", apiPath`/api/teams`, {
      ...overrides,
      body: req,
    });
  }

  /**
   * Delete a team. Refused with 409 (`team_has_vms`) while the team owns live
   * VMs; otherwise every team API key is revoked with it. The outcome lists
   * any edges or sessions the server could not confirm torn down. Scope:
   * `teams:write`; administrators only. 403 not an administrator; 404 means
   * absent or not yours.
   */
  delete(name: string, overrides: RequestOverrides = {}): Promise<TeamDeleteOutcome> {
    return this.http.request<TeamDeleteOutcome>(
      "DELETE",
      apiPath`/api/teams/${name}`,
      overrides,
    );
  }

  /**
   * A team's roster. Scope: `teams:read`; administrators and the team's own
   * members. 403 neither; 404 means absent or not yours. `added_by` is
   * present only for an administrator.
   */
  listMembers(name: string, overrides: RequestOverrides = {}): Promise<TeamMemberEntry[]> {
    return this.http.request<TeamMemberEntry[]>(
      "GET",
      apiPath`/api/teams/${name}/members`,
      overrides,
    );
  }

  /**
   * Add a user to a team (201, no body). Scope: `teams:write`;
   * administrators only. 403 not an administrator; 404 means the team or
   * user is absent or not yours.
   */
  createMember(
    name: string,
    req: AddMemberRequest,
    overrides: RequestOverrides = {},
  ): Promise<void> {
    return this.http.request<void>("POST", apiPath`/api/teams/${name}/members`, {
      ...overrides,
      body: req,
    });
  }

  /**
   * Remove a user from a team. Team API keys stay valid: they belong to the
   * team, not to the member. The outcome lists any edges or sessions the
   * server could not confirm torn down. Scope: `teams:write`; administrators
   * only. 403 not an administrator; 404 means absent or not yours.
   */
  deleteMember(
    name: string,
    username: string,
    overrides: RequestOverrides = {},
  ): Promise<RemoveMemberOutcome> {
    return this.http.request<RemoveMemberOutcome>(
      "DELETE",
      apiPath`/api/teams/${name}/members/${username}`,
      overrides,
    );
  }
}
