/**
 * The hand-written public types: the ones that are not a schema in
 * `sdk/openapi.yaml` `components.schemas`, plus a corrected copy of each schema
 * that `scripts/schema-barrel-exclusions.mjs` keeps out of the generated list
 * (today only `ExecRequestDto`). Everything else public is a generated schema
 * type (`generated/schemas.gen.ts`).
 *
 * `types.ts` joins this module and the schema list with two `export *` lines,
 * so a name here that is also a schema name fails the build (TS2308) instead of
 * shadowing it. Keep it that way: define ergonomic types here, never a second
 * copy of a wire shape.
 *
 * One runtime helper lives here too, {@link hasScope}, because it reads only
 * these types and the generated `ProfileSummary`.
 *
 * The query-parameter bags alias the generated per-operation query type, so
 * their fields follow the contract while their public name stays readable. The
 * contract declares a few enum-valued query parameters as plain `string`; those
 * bags put the closed union back, because the server ignores a value it cannot
 * parse and answers unfiltered, so a misspelling must fail to compile instead.
 */

import { CoveError } from "./errors.js";
import type {
  DeliveryState,
  DrainHostData,
  ExecRequestDto as GeneratedExecRequestDto,
  GetHostTelemetryData,
  GetVmConsoleData,
  ListAllVmsData,
  ListAnyCheckpointsData,
  ListApiKeysData,
  ListAuditData,
  ListVmCheckpointsData,
  ListVmEventsData,
  ListVmProcessesData,
  ListVmsData,
  ListWebhookDeliveriesData,
  ListWebhooksData,
  ProfileSummary,
  StreamVmConsoleData,
  VmState,
} from "./generated/types.gen.js";

// ---------------------------------------------------------------------------
// Request bodies the generated schema gets wrong for callers
// (left out of generated/schemas.gen.ts by scripts/schema-barrel-exclusions.mjs)
// ---------------------------------------------------------------------------

/**
 * `POST /vms/{name}/exec` request body, without `selector`: the server refuses
 * a plain exec that carries one (400). Secrets-injected exec goes through
 * `client.vms.execWithSecrets` (`ExecWithSecretsRequest`).
 */
export type ExecRequestDto = Omit<GeneratedExecRequestDto, "selector">;

// ---------------------------------------------------------------------------
// Client-side shapes (not raw wire JSON)
// ---------------------------------------------------------------------------

/**
 * Parsed event from the `exec` SSE stream (see `client.vms.exec`) — client-side
 * shape, not raw wire JSON. `data` is a raw output chunk exactly as the guest
 * produced it (usually one line *including* its trailing newline) — concatenate
 * chunks verbatim; do not add separators.
 */
export type ExecEvent =
  | { kind: "stdout"; data: string }
  | { kind: "stderr"; data: string }
  | {
      kind: "exit";
      code: number;
      /**
       * The guest killed the command at its `timeoutSecs` deadline (`code` is then 124).
       * `false` for a command that exited on its own, even with 124, and from a server
       * too old to report it.
       */
      timedOut: boolean;
    }
  | { kind: "error"; error: string }
  | { kind: "paused"; reason: string; newState: string };

/** Collected result of `client.vms.execCollect` — client-side shape, not raw wire JSON. */
export interface ExecCollectResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** The command was killed at its deadline; `exitCode` is then 124. */
  timedOut: boolean;
}

/**
 * Every permission an API key may hold. The contract types `scopes` as plain
 * strings; this union is the SDK's narrower name for them.
 *
 * Mirrors the server's catalogue (`cove-service/src/ops/keys/scopes.rs` ::
 * `ALL_SCOPES`) exactly, and a Rust test
 * (`unit_keys_scopes_typescript_union_matches_the_catalogue`) reads this file
 * and fails if the two drift — a union that names a permission the server
 * rejects, or omits one a caller needs, is worse than no union at all.
 *
 * Satisfaction is **exact match**, with one exception: bare `admin` satisfies
 * any `admin:...` permission (the back-compat superset). The shared stems in
 * `admin:quotas:read` / `admin:quotas:write` are a naming convention, not a
 * hierarchy — `admin:quotas` is not a permission and confers nothing.
 */
export type ApiScope =
  | "vms:read"
  | "vms:write"
  | "vms:exec"
  | "tags:read"
  | "tags:write"
  | "secrets:read"
  | "secrets:write"
  | "checkpoints:write"
  | "ports:read"
  | "ports:write"
  | "files:read"
  | "files:write"
  | "access:read"
  | "access:write"
  | "teams:read"
  | "teams:write"
  | "audit:read"
  | "keys:manage"
  /** Back-compat superset: satisfies every `admin:...` permission below. */
  | "admin"
  | "admin:users:read"
  | "admin:vms:read"
  | "admin:host:read"
  /** Every checkpoint on the host with its owner, orphan status and size. */
  | "admin:checkpoints:read"
  /**
   * Delete one named checkpoint, whoever owns it — including an orphan whose
   * source VM is gone. Bounded to the checkpoint named, and deliberately not
   * `admin:fleet:delete`, which is the whole-host bulk operation.
   */
  | "admin:checkpoints:write"
  | "admin:quotas:read"
  | "admin:quotas:write"
  | "admin:projects:read"
  | "admin:projects:write"
  /**
   * Reach ANOTHER principal's secrets — another user's, or a team's or project's
   * you are not a member of — as a member of the server's `[auth] admins`. Needed
   * IN ADDITION to `secrets:read` / `secrets:write`, which the routes themselves
   * require. Managing your own user scope, or a team or project you belong to,
   * needs only `secrets:read` / `secrets:write`.
   */
  | "admin:secrets:read"
  | "admin:secrets:write"
  /**
   * Create a VM with nested virtualisation (`nested_virt: true` on
   * `POST /vms`), or clone a VM that has it. Needed IN ADDITION to
   * `vms:write`, and only by a key whose holder is in the server's
   * `[auth] admins`. Anyone else is refused whatever the key holds.
   */
  | "admin:vms:nested-virt"
  | "admin:sessions:write"
  | "admin:fleet:write"
  | "admin:fleet:delete"
  | "admin:agent-push";

// ---------------------------------------------------------------------------
// The caller's permissions (`client.meta.me()`)
// ---------------------------------------------------------------------------

/**
 * Whether the credential that fetched `me` (`client.meta.me()`) holds `scope`.
 *
 * - An API key (`permissions.kind === "key"`) holds exactly the list it was
 *   minted with, the list the bearer gate reads. A permission is held when
 *   it is on the list, or, for an `admin:…` permission, when bare `admin` is
 *   (the back-compat superset). Nothing else implies anything: `vms:write`
 *   does not give `vms:read`, and `admin:quotas:read` does not give
 *   `admin:quotas:write`.
 * - A session (`permissions.kind === "session"`) has no scope list, so it is
 *   not restricted by one: the answer is `true` (but see the next point).
 * - An `admin` or `admin:…` permission also needs the server's admin check,
 *   which `me.is_admin` reports: an ordinary key that lists `admin` (one not
 *   minted as an admin key, `admin_key: true`) passes no admin check, and a
 *   session of a user outside `[auth] admins` holds no admin permission. So
 *   for those the answer is `false` unless `me.is_admin` is `true`.
 *
 * It says nothing about whether a particular VM is reachable (decided per VM,
 * a 404 for one you cannot see).
 *
 * Throws {@link CoveError} when `me` has no `permissions` (a server older than
 * the field), rather than guessing.
 */
export function hasScope(me: ProfileSummary, scope: ApiScope | (string & {})): boolean {
  const permissions = me.permissions;
  if (!permissions) {
    throw new CoveError("This server's /api/me does not report permissions; hasScope cannot answer");
  }
  // An admin permission counts only where the server's admin check passes:
  // for a key, only one minted as an admin key, held by an `[auth] admins`
  // user. `is_admin` is that check's answer.
  const adminScope = scope === "admin" || scope.startsWith("admin:");
  if (adminScope && me.is_admin !== true) return false;
  if (permissions.kind === "session") return true;
  return (
    permissions.scopes.includes(scope) ||
    (scope.startsWith("admin:") && permissions.scopes.includes("admin"))
  );
}

// ---------------------------------------------------------------------------
// Event streams (`client.events`) — client-side shapes over the SSE frames
// ---------------------------------------------------------------------------
//
// The contract types the three streams as `text/event-stream` strings, so no
// schema names their frames. These unions follow the JSON the server writes
// (`cove-server/src/handlers/events.rs`), discriminated on `kind` (the frame's
// `event:` name). The `connected` frame each stream opens with is not yielded.

/**
 * Yielded after the iterator reconnects across the server's clean close (every
 * stream ends after 300 s). The server does not replay: anything emitted
 * between the close and this marker was not delivered. Re-list (`vms.list`) if
 * you need the state after the gap.
 */
export interface StreamReconnected {
  kind: "reconnected";
}

/**
 * The server dropped `skipped` events because this consumer fell behind. They
 * are not replayed; re-list if you need the state after the gap.
 */
export interface StreamLagged {
  kind: "lagged";
  skipped: number;
}

/**
 * One frame of `client.events.all()` (`GET /api/vms/events`): a state change on
 * one of the caller's VMs. `vm-created` is sent once per new VM when it is up
 * (built, claimed from the warm pool, or cloned), `vm-deleted` on the move to
 * `deleted`, `vm-update` for any other change; `event_type` repeats the frame
 * name.
 */
export type AllVmEventsStreamEvent =
  | {
      kind: "vm-update" | "vm-created" | "vm-deleted";
      vm_name: string;
      state: VmState;
      event_type: string;
    }
  | StreamLagged
  | StreamReconnected;

/**
 * One frame of `client.events.vm(name)` (`GET /api/vms/{name}/events`). The
 * server sends `state` on every connect (the VM's state at that moment, or
 * `creating` while its creation is still in flight), so the first frame after
 * a `reconnected` marker is the current state. `progress` is a creation stage
 * reached; `error` is a failed creation (`stage` is `"Failed"`).
 */
export type VmEventStreamEvent =
  | { kind: "state"; state: VmState; timestamp: string }
  | { kind: "progress"; stage: string; message: string }
  | { kind: "error"; stage: string; message: string }
  | StreamLagged
  | StreamReconnected;

/**
 * Who caused a lifecycle event, as the server serialises its `Actor`
 * (`cove-types/src/actor.rs`): a union tagged on `kind`. A key's scopes are
 * never on the wire.
 */
export type LifecycleActor =
  | {
      kind: "user";
      username: string;
      /** How the user reached the server; an API key names its id. When the key is a connected app's token, `connected_app` is present. */
      source: "ssh" | "web" | "unix_socket" | { api_key: { key_id: string; connected_app?: { client_id: string; client_name: string; access: "full" | "non_destructive" } } };
    }
  | { kind: "system"; reason: string }
  | { kind: "team_key"; team_id: string; key_id: string; username: string }
  | {
      kind: "service_key";
      key_id: string;
      /** `svc:<name>`. */
      username: string;
      /** The team (id) or the one member its VMs are charged to. */
      binding: { team: string } | { member: string };
    };

/**
 * The `data` of one `lifecycle` frame of `GET /api/lifecycle-events`: a typed
 * lifecycle event with the actor that caused it.
 */
export interface LifecycleEventData {
  /** `<scope>.<verb>`, e.g. `vm.created`, `vm.tags.changed`, `keys.issued`. */
  kind: string;
  /** `null` for an event not bound to a VM (`keys.issued`, `keys.revoked`). */
  vm_id: string | null;
  /** Best effort: `null` when the name was not known when the event was emitted. */
  vm_name: string | null;
  /** Who acted (the server's `Actor`, tagged on `kind`). */
  actor: LifecycleActor;
  /** RFC 3339 timestamp. */
  at: string;
  /** Kind-specific payload, as the server emitted it. */
  payload: unknown;
}

/**
 * One frame of `client.events.lifecycle()`. The event is under `event` (its
 * own `kind` would otherwise collide with the frame's).
 */
export type LifecycleStreamEvent =
  | { kind: "lifecycle"; event: LifecycleEventData }
  | StreamLagged
  | StreamReconnected;

// ---------------------------------------------------------------------------
// Query-parameter bags (aliases of the generated per-operation query types)
// ---------------------------------------------------------------------------

/** Query of `client.audit.list` / `iter`. `vm` is a VM **UUID**, not a name. */
export type AuditListParams = NonNullable<ListAuditData["query"]>;

/** Query of the checkpoint listings (`listForVm`, `listAll` and their `iter*`). */
export type ListCheckpointsParams = NonNullable<ListVmCheckpointsData["query"]>;

/** Query of `client.keys.list`. */
export type ListApiKeysParams = NonNullable<ListApiKeysData["query"]>;

/**
 * Query of `client.vms.list` / `iter`. `state` is a `VmState`. `tag` is
 * repeatable (`key=value` filters, AND semantics): pass an array to send
 * several, or one string for a single filter. The contract declares `state`
 * as a plain `string` and `tag` as a list of strings. The server
 * refuses a filter value it cannot apply rather than ignoring it: an unknown
 * `state`, a `tag` without `=` or with an empty key, or `limit: 0` throws a
 * 400 `validation_failed` whose `field` names the parameter. The server also
 * refuses any query key other than `state`, `tag`, `limit` and `cursor`.
 */
export type ListVmsParams = Omit<NonNullable<ListVmsData["query"]>, "tag" | "state"> & {
  state?: VmState;
  tag?: string | string[];
};

/** Query of `client.vms.eventsLog` / `iterEventsLog`. */
export type ListVmEventsParams = NonNullable<ListVmEventsData["query"]>;

/** Query of `client.vms.processes`. */
export type ListVmProcessesParams = NonNullable<ListVmProcessesData["query"]>;

/** Query of `client.vms.console`. */
export type GetVmConsoleParams = NonNullable<GetVmConsoleData["query"]>;

/** Query of `client.vms.streamConsole`: `lines` of backlog before live tailing starts. */
export type StreamVmConsoleParams = NonNullable<StreamVmConsoleData["query"]>;

/** Query shared by the VM and host telemetry series (`from`/`to` are Unix epoch seconds). */
export type TelemetryParams = NonNullable<GetHostTelemetryData["query"]>;

/** Query of `client.webhooks.list`. `vm_id` is required when `scope` is `"vm"`. */
export type ListWebhooksParams = Omit<NonNullable<ListWebhooksData["query"]>, "scope"> & {
  scope?: "server" | "vm";
};

/** Query of `client.webhooks.listDeliveries` / `iterDeliveries`. */
export type ListWebhookDeliveriesParams = Omit<
  NonNullable<ListWebhookDeliveriesData["query"]>,
  "state"
> & {
  state?: DeliveryState;
};

/** Query of `client.admin.listAllVms` / `iterAllVms`. `user` narrows to one person's VMs. */
export type ListAllVmsParams = NonNullable<ListAllVmsData["query"]>;

/**
 * Query of `client.admin.listAnyCheckpoints` / `iterAnyCheckpoints`. `user`
 * narrows to one person's checkpoints, `orphaned: true` to those whose source
 * VM is gone.
 */
export type ListAnyCheckpointsParams = NonNullable<ListAnyCheckpointsData["query"]>;

/** Query of `client.admin.drainHost`: `budget_secs` bounds the whole drain. */
export type DrainHostParams = NonNullable<DrainHostData["query"]>;
