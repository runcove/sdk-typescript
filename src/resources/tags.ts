import { apiPath, type CoveHttp, type RequestOverrides } from "../http.js";
import type { SetTagRequest, SetVmTeamRequest, TagEntry, TagSummary } from "../types.js";

/** `client.tags` — VM tags and team attribution. */
export class TagsResource {
  constructor(private readonly http: CoveHttp) {}

  /** List a VM's tags, ordered by key. Scope: `tags:read`. */
  listForVm(name: string, overrides: RequestOverrides = {}): Promise<TagEntry[]> {
    return this.http.request<TagEntry[]>("GET", apiPath`/api/vms/${name}/tags`, overrides);
  }

  /**
   * Set a tag. Scope: `tags:write`.
   * Key must match `[a-z0-9_.-]{1,64}`, no leading/trailing dot; the
   * `cove:` prefix is reserved. Value: max 256 UTF-8 bytes, no control
   * characters; empty allowed.
   */
  set(
    name: string,
    key: string,
    value: string,
    overrides: RequestOverrides = {},
  ): Promise<void> {
    const body: SetTagRequest = { value };
    return this.http.request<void>("PUT", apiPath`/api/vms/${name}/tags/${key}`, {
      ...overrides,
      body,
    });
  }

  /** Delete a tag (idempotent — succeeds even if already absent). Scope: `tags:write`. */
  delete(name: string, key: string, overrides: RequestOverrides = {}): Promise<void> {
    return this.http.request<void>(
      "DELETE",
      apiPath`/api/vms/${name}/tags/${key}`,
      overrides,
    );
  }

  /**
   * Aggregate tag usage. Scope: `tags:read`.
   * Admins see the cross-tenant aggregate; other callers see only their own
   * VMs' tags.
   */
  listAll(overrides: RequestOverrides = {}): Promise<TagSummary[]> {
    return this.http.request<TagSummary[]>("GET", apiPath`/api/tags`, overrides);
  }

  /**
   * Attribute a VM to a team. Scope: `vms:write`.
   * The VM owner must already be a member of the target team (else 403).
   */
  setTeam(name: string, team: string, overrides: RequestOverrides = {}): Promise<void> {
    const body: SetVmTeamRequest = { team };
    return this.http.request<void>("PUT", apiPath`/api/vms/${name}/team`, {
      ...overrides,
      body,
    });
  }

  /** Detach a VM from its team (idempotent). Scope: `vms:write`. */
  unsetTeam(name: string, overrides: RequestOverrides = {}): Promise<void> {
    return this.http.request<void>("DELETE", apiPath`/api/vms/${name}/team`, overrides);
  }
}
