import { apiPath, type CoveHttp, encodeSegment, type RequestOverrides } from "../http.js";
import type {
  ImportResponse,
  ImportSecretsRequest,
  RotateSummary,
  ScopedImportResult,
  SecretNameList,
  SetSecretRequest,
  VmCountResult,
} from "../types.js";

/**
 * Secrets operations for one scope (a VM, or a user/team/project envelope) —
 * obtained via `client.secrets.vm(...)` / `.user(...)` / `.team(...)` /
 * `.project(...)`. All four scopes share the same wire surface under
 * `<scope>/secrets`; only two response shapes differ (see the generics):
 * `set` returns nothing for a VM but a fan-out count for envelope scopes, and
 * `import` reports `vm_count` only for envelope scopes.
 */
export class SecretsScope<SetResult = VmCountResult, ImportResult = ScopedImportResult> {
  /** @internal Constructed by {@link SecretsResource}; `base` is a pre-encoded path prefix. */
  constructor(
    private readonly http: CoveHttp,
    private readonly base: string,
  ) {}

  /** List secret names in this scope (values are never returned). Scope: `secrets:read`. */
  list(overrides: RequestOverrides = {}): Promise<SecretNameList> {
    return this.http.request<SecretNameList>("GET", `${this.base}/secrets`, overrides);
  }

  /**
   * Set a secret. Scope: `secrets:write`.
   * Envelope scopes return a best-effort fan-out count.
   */
  set(
    key: string,
    req: SetSecretRequest,
    overrides: RequestOverrides = {},
  ): Promise<SetResult> {
    return this.http.request<SetResult>("POST", `${this.base}/secrets/${encodeSegment(key)}`, {
      ...overrides,
      body: req,
    });
  }

  /** Delete a secret (reports wipe fan-out). Scope: `secrets:write`. Idempotent. */
  unset(key: string, overrides: RequestOverrides = {}): Promise<RotateSummary> {
    return this.http.request<RotateSummary>(
      "DELETE",
      `${this.base}/secrets/${encodeSegment(key)}`,
      overrides,
    );
  }

  /** Rotate a secret with acked push to running VMs. Scope: `secrets:write`. */
  rotate(
    key: string,
    req: SetSecretRequest,
    overrides: RequestOverrides = {},
  ): Promise<RotateSummary> {
    return this.http.request<RotateSummary>(
      "POST",
      `${this.base}/secrets/${encodeSegment(key)}/rotate`,
      { ...overrides, body: req },
    );
  }

  /**
   * Bulk-import secrets into this scope. Scope: `secrets:write`.
   * Best-effort — entries with invalid names are silently skipped.
   */
  import(
    req: ImportSecretsRequest,
    overrides: RequestOverrides = {},
  ): Promise<ImportResult> {
    return this.http.request<ImportResult>("POST", `${this.base}/secrets/import`, {
      ...overrides,
      body: req,
    });
  }
}

/**
 * `client.secrets` — per-VM and scoped (user/team/project) secrets.
 * Gated on `[secrets] enabled`; every method returns **503
 * `feature_disabled`** when that config flag is off.
 *
 * ```ts
 * await client.secrets.vm("web-1").set("API_KEY", { value_b64 });
 * await client.secrets.team("infra").list();
 * ```
 */
export class SecretsResource {
  constructor(private readonly http: CoveHttp) {}

  /** Secrets on a single VM. */
  vm(name: string): SecretsScope<void, ImportResponse> {
    return new SecretsScope(this.http, apiPath`/api/vms/${name}`);
  }

  /** User-scoped secrets (fan out to the user's VMs). */
  user(username: string): SecretsScope {
    return new SecretsScope(this.http, apiPath`/api/users/${username}`);
  }

  /** Team-scoped secrets (fan out to the team's VMs). */
  team(team: string): SecretsScope {
    return new SecretsScope(this.http, apiPath`/api/teams/${team}`);
  }

  /** Project-scoped secrets (fan out to the project's VMs). */
  project(projectId: string): SecretsScope {
    return new SecretsScope(this.http, apiPath`/api/projects/${projectId}`);
  }
}
