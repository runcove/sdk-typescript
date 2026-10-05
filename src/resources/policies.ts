import { apiPath, type CoveHttp, type RequestOverrides } from "../http.js";
import type {
  AutoPausePolicy,
  IdleState,
  TtlPolicy,
  TtlPolicyView,
  UpdateAutoPauseRequest,
  UpdateTtlPolicyRequest,
} from "../types.js";

/**
 * `client.policies` — auto-pause and expiry policies.
 *
 * Two renames landed here, both same-shape-new-name: "expiry" replaces
 * "TTL", and "auto-pause" replaces
 * "auto-suspend" — the idle policy pauses a VM and keeps its memory
 * resident, so the old name named the one thing it does not do. See
 * {@link AutoPausePolicy}. The old method names were removed once it was
 * confirmed no consumer depended on them — this resource
 * only exposes the new vocabulary.
 */
export class PoliciesResource {
  constructor(private readonly http: CoveHttp) {}

  /** Set the auto-pause policy. Scope: `vms:write`. */
  setAutoPause(
    name: string,
    policy: AutoPausePolicy,
    overrides: RequestOverrides = {},
  ): Promise<void> {
    const body: UpdateAutoPauseRequest = { policy };
    return this.http.request<void>("POST", apiPath`/api/vms/${name}/auto-pause`, {
      ...overrides,
      body,
    });
  }

  /** Get the VM's idle state. Scope: `vms:read`. */
  getIdleState(name: string, overrides: RequestOverrides = {}): Promise<IdleState> {
    return this.http.request<IdleState>(
      "GET",
      apiPath`/api/vms/${name}/idle-state`,
      overrides,
    );
  }

  /** Set the VM's expiry policy. Scope: `vms:write`. */
  setExpiry(name: string, policy: TtlPolicy, overrides: RequestOverrides = {}): Promise<void> {
    const body: UpdateTtlPolicyRequest = { policy };
    return this.http.request<void>("POST", apiPath`/api/vms/${name}/expiry`, {
      ...overrides,
      body,
    });
  }

  /** Get the VM's expiry policy and countdowns. Scope: `vms:read`. */
  getExpiry(name: string, overrides: RequestOverrides = {}): Promise<TtlPolicyView> {
    return this.http.request<TtlPolicyView>(
      "GET",
      apiPath`/api/vms/${name}/expiry`,
      overrides,
    );
  }
}
