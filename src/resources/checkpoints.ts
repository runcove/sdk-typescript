import { apiPath, type CoveHttp, type RequestOverrides } from "../http.js";
import type {
  Checkpoint,
  CheckpointCreateRequest,
  CheckpointPage,
  ListCheckpointsParams,
} from "../types.js";

/** `client.checkpoints` — point-in-time VM snapshots, and hibernating a VM to one. */
export class CheckpointsResource {
  constructor(private readonly http: CoveHttp) {}

  /** Checkpoint a VM. Scope: `checkpoints:write`. 409 on invalid state or admission denial. */
  create(
    name: string,
    req: CheckpointCreateRequest = {},
    overrides: RequestOverrides = {},
  ): Promise<Checkpoint> {
    return this.http.request<Checkpoint>("POST", apiPath`/api/vms/${name}/checkpoints`, {
      ...overrides,
      body: req,
    });
  }

  /**
   * List a VM's checkpoints (cursor-paginated). Scope: `vms:read`.
   * Returns one page; use {@link iterForVm} to walk them all.
   */
  listForVm(
    name: string,
    params: ListCheckpointsParams = {},
    overrides: RequestOverrides = {},
  ): Promise<CheckpointPage> {
    return this.http.request<CheckpointPage>("GET", apiPath`/api/vms/${name}/checkpoints`, {
      ...overrides,
      query: { limit: params.limit, cursor: params.cursor },
    });
  }

  /**
   * Iterate every checkpoint of one VM, transparently following
   * `next_cursor` across pages. Scope: `vms:read`.
   */
  async *iterForVm(
    name: string,
    params: ListCheckpointsParams = {},
    overrides: RequestOverrides = {},
  ): AsyncGenerator<Checkpoint> {
    let cursor = params.cursor;
    for (;;) {
      const page = await this.listForVm(name, { ...params, cursor }, overrides);
      for (const checkpoint of page.checkpoints) yield checkpoint;
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  /**
   * List every checkpoint owned by the caller, including orphans
   * (cursor-paginated). Scope: `vms:read`. Returns one page; use
   * {@link iterAll} to walk them all.
   */
  listAll(
    params: ListCheckpointsParams = {},
    overrides: RequestOverrides = {},
  ): Promise<CheckpointPage> {
    return this.http.request<CheckpointPage>("GET", apiPath`/api/checkpoints`, {
      ...overrides,
      query: { limit: params.limit, cursor: params.cursor },
    });
  }

  /**
   * Iterate every checkpoint the caller owns across every VM, transparently
   * following `next_cursor` across pages. Scope: `vms:read`.
   */
  async *iterAll(
    params: ListCheckpointsParams = {},
    overrides: RequestOverrides = {},
  ): AsyncGenerator<Checkpoint> {
    let cursor = params.cursor;
    for (;;) {
      const page = await this.listAll({ ...params, cursor }, overrides);
      for (const checkpoint of page.checkpoints) yield checkpoint;
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  /** Get a checkpoint by id. Scope: `vms:read`. */
  get(id: string, overrides: RequestOverrides = {}): Promise<Checkpoint> {
    return this.http.request<Checkpoint>("GET", apiPath`/api/checkpoints/${id}`, overrides);
  }

  /** Delete a checkpoint. Scope: `checkpoints:write`. 409 if still referenced by a clone. */
  delete(id: string, overrides: RequestOverrides = {}): Promise<void> {
    return this.http.request<void>("DELETE", apiPath`/api/checkpoints/${id}`, overrides);
  }

  /**
   * Hibernate a VM to a checkpoint. Scope: `vms:write`. Returns the
   * auto-generated checkpoint. Renamed from `suspend` —
   * "suspend" is retired from the public vocabulary in favor of `hibernate`.
   * To reverse this, see {@link VmsResource.wake} (`client.vms.wake`):
   * despite the historical name `restore`, waking a VM was never a
   * checkpoints operation, so it lives on `vms`, not here.
   */
  hibernate(name: string, overrides: RequestOverrides = {}): Promise<Checkpoint> {
    return this.http.request<Checkpoint>("POST", apiPath`/api/vms/${name}/hibernate`, overrides);
  }
}
