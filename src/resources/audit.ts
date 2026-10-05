import { apiPath, type CoveHttp, type RequestOverrides } from "../http.js";
import type { AuditEntry, AuditListParams, AuditPage } from "../types.js";

/** `client.audit` — audit log queries. */
export class AuditResource {
  constructor(private readonly http: CoveHttp) {}

  /**
   * Query the audit log (cursor-paginated). Scope: `audit:read`.
   * Non-admin callers only see their own entries; a `user` filter naming
   * someone else yields an empty page (no existence leak).
   */
  list(params: AuditListParams = {}, overrides: RequestOverrides = {}): Promise<AuditPage> {
    return this.http.request<AuditPage>("GET", apiPath`/api/audit`, {
      ...overrides,
      query: {
        vm: params.vm,
        user: params.user,
        kind: params.kind,
        key_id: params.key_id,
        source_ip: params.source_ip,
        since: params.since,
        until: params.until,
        limit: params.limit,
        cursor: params.cursor,
      },
    });
  }

  /**
   * Iterate every audit entry matching `params`, transparently following
   * `next_cursor` across pages. Scope: `audit:read`.
   */
  async *iter(
    params: AuditListParams = {},
    overrides: RequestOverrides = {},
  ): AsyncGenerator<AuditEntry> {
    let cursor = params.cursor;
    for (;;) {
      const page = await this.list({ ...params, cursor }, overrides);
      for (const entry of page.entries) yield entry;
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }
}
