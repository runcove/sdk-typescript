import { CoveError, CoveTimeoutError } from "../errors.js";
import { apiPath, type CoveHttp, type RequestOverrides } from "../http.js";
import { parseSSE } from "../sse.js";
import { VmFilesResource } from "./files.js";
import type {
  AddPortRequest,
  CloneRequest,
  CloneResponse,
  ConnectionInfo,
  CreateInviteRequest,
  CreateVmRequest,
  CreateVmResponse,
  ExecCollectResult,
  ExecEvent,
  ExecOutputDto,
  ExecRequestDto,
  ExecWithSecretsRequest,
  GetVmConsoleParams,
  GrantShareOutcome,
  GrantShareRequest,
  InjectSelector,
  ListVmEventsParams,
  ListVmProcessesParams,
  ListVmsParams,
  ProxyInvite,
  ProxyPortInfo,
  ProxyUrlInfo,
  RemovalResponse,
  ResizeRequest,
  ResizeResult,
  RevokeShareOutcome,
  SetPublicRequest,
  ShareEntry,
  SharedVmSummary,
  StreamVmConsoleParams,
  TelemetryParams,
  VmConsole,
  VmDetail,
  VmEvent,
  VmEventsPage,
  VmProcess,
  VmState,
  VmStats,
  VmSummary,
  VmSummaryPage,
  VmTelemetrySeries,
  WakeRequest,
} from "../types.js";

export interface ExecOptions {
  command: string[];
  /**
   * Deadline the *server* enforces on the command inside the guest. Distinct
   * from `RequestOverrides.timeoutMs`, which is this client's own deadline on
   * the HTTP request carrying it.
   */
  timeoutSecs?: number;
  /**
   * Working directory. A relative path resolves against the home directory of
   * the account the command runs as; default that home directory (`/root`).
   */
  cwd?: string;
  /**
   * Extra environment variables, set last so they win over the guest's
   * login-like defaults (`PATH` included). At most 128; names at most 256
   * bytes with no `=`; no NUL in names or values.
   */
  env?: Record<string, string>;
  /** Account to run as, by name in the VM's `/etc/passwd`. Default: root. */
  user?: string;
  /**
   * Run through the account's login shell (`<shell> -l -c`) so its profile
   * files apply. Default `false`.
   */
  login?: boolean;
}

export interface ExecWithSecretsOptions {
  command: string[];
  selector: InjectSelector;
  /**
   * Seconds the command may run in the guest; the server's default is 30 and
   * it refuses more than 3600 with 400 `validation_failed`. Past it the guest
   * kills the command and everything that stayed in its process group, and the
   * result is `exit_code` 124 with `timed_out: true`.
   */
  timeoutSecs?: number;
}

/**
 * Parse the JSON payload of a terminal exec event. A truncated stream would
 * otherwise surface a bare `SyntaxError` from `JSON.parse`, breaking the SDK's
 * contract that everything it throws is a `CoveError`.
 */
function parseTerminalEvent<T>(kind: string, data: string): T {
  try {
    return JSON.parse(data) as T;
  } catch {
    const shown = data.length > 200 ? `${data.slice(0, 200)}…` : data;
    throw new CoveError(`Malformed \`${kind}\` event in exec stream: ${shown}`);
  }
}

/** Resolve after `ms`, or reject with `signal.reason` on abort; the timer never outlives either. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** `client.vms` — VM lifecycle, monitoring, and exec. */
export class VmsResource {
  /** Single-file transfer in and out of a running VM. See {@link VmFilesResource}. */
  readonly files: VmFilesResource;

  constructor(private readonly http: CoveHttp) {
    this.files = new VmFilesResource(http);
  }

  /**
   * List VMs visible to the caller (cursor-paginated). Scope: `vms:read`.
   * Returns one page ordered by `name`; use {@link iter} to walk them all.
   */
  list(params: ListVmsParams = {}, overrides: RequestOverrides = {}): Promise<VmSummaryPage> {
    return this.http.request<VmSummaryPage>("GET", apiPath`/api/vms`, {
      ...overrides,
      query: { state: params.state, limit: params.limit, cursor: params.cursor, tag: params.tag },
    });
  }

  /**
   * Iterate every VM visible to the caller, transparently following
   * `next_cursor` across pages. Scope: `vms:read`.
   *
   * Use this, not `list()`, when you mean "all my VMs" — `list()` answers with
   * one page and a cursor, and treating that page as the whole set is the
   * mistake the page envelope exists to prevent.
   */
  async *iter(
    params: ListVmsParams = {},
    overrides: RequestOverrides = {},
  ): AsyncGenerator<VmSummary> {
    let cursor = params.cursor;
    for (;;) {
      const page = await this.list({ ...params, cursor }, overrides);
      for (const vm of page.vms) yield vm;
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  /**
   * Create a VM. Scope: `vms:write`.
   * Returns 202 immediately; creation continues in the background — poll
   * `get(name)` for state. Pre-flight failures (name taken, quota/admission
   * denial, validation) return synchronously as 400/409/422; 503 if the
   * host cannot admit the request.
   */
  create(req: CreateVmRequest, overrides: RequestOverrides = {}): Promise<CreateVmResponse> {
    return this.http.request<CreateVmResponse>("POST", apiPath`/api/vms`, {
      ...overrides,
      body: req,
    });
  }

  /**
   * Get VM detail. Scope: `vms:read`.
   * During the cold-create window the server synthesizes a partial DTO with
   * `state: "creating"`, empty `mac_address`, and zeroed sizes. 404-over-403:
   * a VM that exists but isn't yours reads the same as a missing one.
   */
  get(name: string, overrides: RequestOverrides = {}): Promise<VmDetail> {
    return this.http.request<VmDetail>("GET", apiPath`/api/vms/${name}`, overrides);
  }

  /**
   * Poll `get(name)` until the VM's state is one of `states`. Throws `CoveTimeoutError` (no `cause`) after
   * `timeoutMs` (default 300 000) naming the last state seen; `signal` aborts it (the abort error passes through).
   * `opts.signal` takes precedence over `overrides.signal` (Node 18 has no `AbortSignal.any`, so the two are not combined).
   * Scope: `vms:read`.
   */
  async waitForState(
    name: string,
    states: readonly VmState[],
    opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
    overrides: RequestOverrides = {},
  ): Promise<VmDetail> {
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      opts.signal?.throwIfAborted();
      const vm = await this.get(name, { ...overrides, signal: opts.signal ?? overrides.signal });
      if (states.includes(vm.state)) return vm;
      if (Date.now() >= deadline) throw new CoveTimeoutError(`VM ${name} still ${vm.state} after ${timeoutMs} ms`);
      await sleep(Math.min(opts.intervalMs ?? 1000, Math.max(0, deadline - Date.now())), opts.signal);
    }
  }

  /**
   * Delete a VM. Scope: `vms:write`.
   * 202 if deletion is accepted and runs in the background; 204 if a
   * defunct/failed row squatting the name was purged synchronously.
   */
  delete(name: string, overrides: RequestOverrides = {}): Promise<void> {
    return this.http.request<void>("DELETE", apiPath`/api/vms/${name}`, overrides);
  }

  /** Stop a VM (async graceful shutdown). Scope: `vms:write`. 202 accepted, 409 on invalid state. */
  stop(name: string, overrides: RequestOverrides = {}): Promise<void> {
    return this.http.request<void>("POST", apiPath`/api/vms/${name}/stop`, overrides);
  }

  /** Start a stopped VM. Scope: `vms:write`. 409 on invalid state or admission denial. */
  start(name: string, overrides: RequestOverrides = {}): Promise<void> {
    return this.http.request<void>("POST", apiPath`/api/vms/${name}/start`, overrides);
  }

  /** Pause a running VM. Scope: `vms:write`. 409 on invalid state. */
  pause(name: string, overrides: RequestOverrides = {}): Promise<void> {
    return this.http.request<void>("POST", apiPath`/api/vms/${name}/pause`, overrides);
  }

  /** Resume a paused VM. Scope: `vms:write`. 409 on invalid state or admission denial. */
  resume(name: string, overrides: RequestOverrides = {}): Promise<void> {
    return this.http.request<void>("POST", apiPath`/api/vms/${name}/resume`, overrides);
  }

  /**
   * Wake a VM from a checkpoint. Scope: `vms:write`. A `hibernated` VM
   * wakes from a checkpoint with memory; a `stopped` VM wakes from a
   * disk-only one, whose disk replaces the VM's. Omit `checkpoint_id` to
   * wake from the latest available checkpoint, except on a `stopped` VM
   * whose latest is disk-only: that is refused with 409
   * `disk_rollback_not_named` and changes nothing (call `start` to boot the
   * current disk, or pass the checkpoint's id to roll back). 409
   * `invalid_state_transition` on any other state the checkpoint cannot wake.
   *
   * This used to live at `client.checkpoints.restore()`, which read like
   * "roll a VM back to a checkpoint" and was not that: it posts to the
   * un-hibernate route, and `checkpoint_id` only selects *which* checkpoint
   * to wake from. There is no checkpoint-rollback operation in Cove today —
   * `restore` is reserved for that, if it is ever built.
   */
  wake(
    name: string,
    req: WakeRequest = {},
    overrides: RequestOverrides = {},
  ): Promise<void> {
    return this.http.request<void>("POST", apiPath`/api/vms/${name}/wake`, {
      ...overrides,
      body: req,
    });
  }

  /**
   * Resize CPU/memory (running) or grow disk (stopped). Scope: `vms:write`.
   * `disk_size_gb` is mutually exclusive with `cpus`/`memory_mb` (422).
   * `memory_mb` must be a multiple of 2. Disk grow requires a stopped VM.
   */
  resize(
    name: string,
    req: ResizeRequest,
    overrides: RequestOverrides = {},
  ): Promise<ResizeResult> {
    return this.http.request<ResizeResult>("POST", apiPath`/api/vms/${name}/resize`, {
      ...overrides,
      body: req,
    });
  }

  /** Clone a VM. Scope: `vms:write`. */
  clone(
    source: string,
    req: CloneRequest,
    overrides: RequestOverrides = {},
  ): Promise<CloneResponse> {
    return this.http.request<CloneResponse>("POST", apiPath`/api/vms/${source}/clone`, {
      ...overrides,
      body: req,
    });
  }

  /** Mint an SSH connection ticket. Scope: `vms:write`. */
  connect(name: string, overrides: RequestOverrides = {}): Promise<ConnectionInfo> {
    return this.http.request<ConnectionInfo>(
      "POST",
      apiPath`/api/vms/${name}/connect`,
      overrides,
    );
  }

  /** Proxy URLs (SSH + per-port HTTPS) for a VM. Scope: `vms:read`. */
  getUrl(name: string, overrides: RequestOverrides = {}): Promise<ProxyUrlInfo> {
    return this.http.request<ProxyUrlInfo>("GET", apiPath`/api/vms/${name}/url`, overrides);
  }

  /**
   * Expose a guest port through the HTTPS proxy. Scope: `ports:write`. 201
   * created, 200 when the port was already published (idempotent: a retry, or
   * the primary port, comes back unchanged), 422 on validation failure.
   * Resolves to the port and its URL; `undefined` from a server older than API
   * version 7, which answers without a body.
   */
  addPort(
    name: string,
    req: AddPortRequest,
    overrides: RequestOverrides = {},
  ): Promise<ProxyPortInfo | undefined> {
    return this.http.request<ProxyPortInfo | undefined>(
      "POST",
      apiPath`/api/vms/${name}/ports`,
      {
        ...overrides,
        body: req,
      },
    );
  }

  /**
   * Remove an exposed port. Scope: `ports:write`. Idempotent: `existed` is
   * `false` when the port was not published; `undefined` from a server older
   * than API version 7, which does not say.
   */
  removePort(
    name: string,
    port: number,
    overrides: RequestOverrides = {},
  ): Promise<RemovalResponse | undefined> {
    return this.http.request<RemovalResponse | undefined>(
      "DELETE",
      apiPath`/api/vms/${name}/ports/${port}`,
      overrides,
    );
  }

  /** Toggle public (unauthenticated) access on the primary port. Scope: `ports:write`. */
  setPortPublic(
    name: string,
    port: number,
    req: SetPublicRequest,
    overrides: RequestOverrides = {},
  ): Promise<void> {
    return this.http.request<void>("PUT", apiPath`/api/vms/${name}/ports/${port}/public`, {
      ...overrides,
      body: req,
    });
  }

  /** List every registered port and its exposure state. Scope: `ports:read`. */
  listPorts(name: string, overrides: RequestOverrides = {}): Promise<ProxyPortInfo[]> {
    return this.http.request<ProxyPortInfo[]>("GET", apiPath`/api/vms/${name}/ports`, overrides);
  }

  /** Mint a time-limited share invite for a port. Scope: `ports:write`. */
  createInvite(
    name: string,
    port: number,
    req: CreateInviteRequest,
    overrides: RequestOverrides = {},
  ): Promise<ProxyInvite> {
    return this.http.request<ProxyInvite>(
      "POST",
      apiPath`/api/vms/${name}/ports/${port}/invites`,
      { ...overrides, body: req },
    );
  }

  /** List active invite links for this VM's proxy ports. Scope: `ports:read`. */
  listInvites(name: string, overrides: RequestOverrides = {}): Promise<ProxyInvite[]> {
    return this.http.request<ProxyInvite[]>(
      "GET",
      apiPath`/api/vms/${name}/invites`,
      overrides,
    );
  }

  /** Revoke an invite link. Scope: `ports:write`. */
  revokeInvite(
    name: string,
    inviteId: string,
    overrides: RequestOverrides = {},
  ): Promise<void> {
    return this.http.request<void>(
      "DELETE",
      apiPath`/api/vms/${name}/invites/${inviteId}`,
      overrides,
    );
  }

  // -------------------------------------------------------------------------
  // Sharing. Every method here is served on the external API listener of
  // every host.
  // -------------------------------------------------------------------------

  /**
   * VMs someone else shared with the caller, never the caller's own. Lighter
   * than {@link VmsResource.list} (no tags, no share count) but carries
   * `owner`. Scope: `vms:read`.
   */
  listShared(overrides: RequestOverrides = {}): Promise<SharedVmSummary[]> {
    return this.http.request<SharedVmSummary[]>(
      "GET",
      apiPath`/api/vms/shared-with-me`,
      overrides,
    );
  }

  /**
   * Who has access to a VM. Scope: `access:read`; the VM's owner and
   * administrators only. 404 means absent or not yours (a sharee gets the
   * same 404).
   */
  listAccess(name: string, overrides: RequestOverrides = {}): Promise<ShareEntry[]> {
    return this.http.request<ShareEntry[]>(
      "GET",
      apiPath`/api/vms/${name}/access`,
      overrides,
    );
  }

  /**
   * Grant a user or team access to a VM (201). `user_known: false` means the
   * user has no account yet: the grant still stands and applies at their
   * first sign-in. Scope: `access:write`; the VM's owner and administrators
   * only. 400 malformed grant; 404 means absent or not yours.
   */
  grantAccess(
    name: string,
    req: GrantShareRequest,
    overrides: RequestOverrides = {},
  ): Promise<GrantShareOutcome> {
    return this.http.request<GrantShareOutcome>("POST", apiPath`/api/vms/${name}/access`, {
      ...overrides,
      body: req,
    });
  }

  /**
   * Revoke a share. `subjectType` is `"user"` or `"team"`; `subjectId` the
   * username or team name. The outcome lists any edges or sessions the server
   * could not confirm torn down (it retries them). Scope: `access:write`; the
   * VM's owner and administrators only. 400 unknown subject type; 404 means
   * absent or not yours.
   */
  revokeAccess(
    name: string,
    subjectType: string,
    subjectId: string,
    overrides: RequestOverrides = {},
  ): Promise<RevokeShareOutcome> {
    return this.http.request<RevokeShareOutcome>(
      "DELETE",
      apiPath`/api/vms/${name}/access/${subjectType}/${subjectId}`,
      overrides,
    );
  }

  /** Top guest processes ranked by usage. Scope: `vms:exec`. Guest process names are data-plane content, not VM metadata — gated the same as console access. */
  processes(
    name: string,
    params: ListVmProcessesParams = {},
    overrides: RequestOverrides = {},
  ): Promise<VmProcess[]> {
    return this.http.request<VmProcess[]>("GET", apiPath`/api/vms/${name}/processes`, {
      ...overrides,
      query: { top: params.top },
    });
  }

  /** Point-in-time guest stats. Scope: `vms:read`. */
  stats(name: string, overrides: RequestOverrides = {}): Promise<VmStats> {
    return this.http.request<VmStats>("GET", apiPath`/api/vms/${name}/stats`, overrides);
  }

  /** Tail of the serial console log. Scope: `vms:exec`. Console output is data-plane content, not VM metadata. */
  console(
    name: string,
    params: GetVmConsoleParams = {},
    overrides: RequestOverrides = {},
  ): Promise<VmConsole> {
    return this.http.request<VmConsole>("GET", apiPath`/api/vms/${name}/console`, {
      ...overrides,
      query: { lines: params.lines },
    });
  }

  /**
   * Live serial console stream (SSE). Scope: `vms:exec`. Same data-plane
   * reasoning as {@link console} — the historical snapshot and the
   * live tail are gated identically.
   * Emits `lines` historical lines first, then live-tails indefinitely — the
   * generator only ends when the connection is closed (via `overrides.signal`).
   */
  async *streamConsole(
    name: string,
    params: StreamVmConsoleParams = {},
    overrides: RequestOverrides = {},
  ): AsyncGenerator<string> {
    const response = await this.http.requestSSE(
      "GET",
      apiPath`/api/vms/${name}/console/stream`,
      { ...overrides, query: { lines: params.lines } },
    );
    if (!response.body) return;
    for await (const evt of parseSSE(response.body)) {
      if (evt.event === "console") yield evt.data;
    }
  }

  /** Per-VM telemetry time series. Scope: `vms:read`. */
  telemetry(
    name: string,
    params: TelemetryParams = {},
    overrides: RequestOverrides = {},
  ): Promise<VmTelemetrySeries> {
    return this.http.request<VmTelemetrySeries>("GET", apiPath`/api/vms/${name}/telemetry`, {
      ...overrides,
      query: { from: params.from, to: params.to, step: params.step, limit: params.limit },
    });
  }

  /** Per-VM event log (cursor-paginated). Scope: `vms:read`. */
  eventsLog(
    name: string,
    params: ListVmEventsParams = {},
    overrides: RequestOverrides = {},
  ): Promise<VmEventsPage> {
    return this.http.request<VmEventsPage>("GET", apiPath`/api/vms/${name}/events-log`, {
      ...overrides,
      query: { cursor: params.cursor, limit: params.limit },
    });
  }

  /**
   * Iterate every event-log entry, transparently following `next_cursor`
   * across pages. Scope: `vms:read`.
   */
  async *iterEventsLog(
    name: string,
    params: ListVmEventsParams = {},
    overrides: RequestOverrides = {},
  ): AsyncGenerator<VmEvent> {
    let cursor = params.cursor;
    for (;;) {
      const page = await this.eventsLog(name, { ...params, cursor }, overrides);
      for (const event of page.events) yield event;
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  /**
   * Execute a command in the guest, streaming output. Scope: `vms:exec`.
   * Returns an async generator of `ExecEvent`s parsed from the `200
   * text/event-stream` response — `stdout`/`stderr` carry raw output
   * chunks (newlines included; concatenate verbatim); the stream ends
   * after exactly one of `exit`/`error`/`paused`.
   * At `opts.timeoutSecs` (30 s when omitted) the guest SIGKILLs the command and
   * everything that stayed in its process group, and the stream ends with `exit`
   * code 124 and `timedOut: true` after the output written before then.
   * For secrets-injected exec (buffered JSON response) use
   * `execWithSecrets` instead. 503 `feature_disabled` never applies here
   * (that's only for the `selector` path).
   */
  async *exec(
    name: string,
    opts: ExecOptions,
    overrides: RequestOverrides = {},
  ): AsyncGenerator<ExecEvent> {
    // cwd/env/user/login need guest agent protocol 9: a VM whose agent is
    // older refuses an exec that carries any of them (the stream's `error`
    // event says so) and runs one without them as before. Unset options are
    // left out of the body, so a plain exec is unchanged on the wire.
    const body: ExecRequestDto = {
      command: opts.command,
      timeout_secs: opts.timeoutSecs,
      cwd: opts.cwd,
      env: opts.env,
      user: opts.user,
      // `false` is the default: left out like the others.
      login: opts.login || undefined,
    };
    const response = await this.http.requestSSE("POST", apiPath`/api/vms/${name}/exec`, {
      ...overrides,
      body,
    });
    if (!response.body) return;
    for await (const evt of parseSSE(response.body)) {
      switch (evt.event) {
        case "stdout":
          yield { kind: "stdout", data: evt.data };
          break;
        case "stderr":
          yield { kind: "stderr", data: evt.data };
          break;
        case "exit": {
          const parsed = parseTerminalEvent<{ code: number; timed_out?: boolean }>("exit", evt.data);
          yield { kind: "exit", code: parsed.code, timedOut: parsed.timed_out === true };
          return;
        }
        case "error": {
          const parsed = parseTerminalEvent<{ error: string }>("error", evt.data);
          yield { kind: "error", error: parsed.error };
          return;
        }
        case "paused": {
          const parsed = parseTerminalEvent<{ reason: string; new_state: string }>(
            "paused",
            evt.data,
          );
          yield { kind: "paused", reason: parsed.reason, newState: parsed.new_state };
          return;
        }
        default:
          // Unknown event kind — ignore rather than throw, in case the
          // server adds a new informational event type.
          break;
      }
    }
  }

  /**
   * Run a command in the guest with the selected secrets injected, buffered (not streamed).
   * Scope: `vms:exec`. 503 `feature_disabled` when `[secrets] enabled = false`.
   * `opts.timeoutSecs` is the deadline the server puts on the guest command, 30 s when omitted
   * and at most 3600 (a larger value is refused with 400 `validation_failed`).
   * Past it the guest SIGKILLs the command's whole process group and the result is
   * `exit_code` 124 with `timed_out: true`, carrying the output written before then; a
   * `setup_tag` selector's secrets are still wiped. A command that exits 124 on its own has
   * `timed_out: false`. `overrides.timeoutMs` bounds the whole HTTP request, and this call is
   * buffered, so keep it longer than `timeoutSecs`.
   */
  execWithSecrets(
    name: string,
    opts: ExecWithSecretsOptions,
    overrides: RequestOverrides = {},
  ): Promise<ExecOutputDto> {
    const body: ExecWithSecretsRequest = {
      command: opts.command,
      selector: opts.selector,
      timeout_secs: opts.timeoutSecs,
    };
    return this.http.request<ExecOutputDto>(
      "POST",
      apiPath`/api/vms/${name}/exec-with-secrets`,
      { ...overrides, body },
    );
  }

  /**
   * Convenience wrapper over `exec` that drains the stream and resolves to
   * the collected `{stdout, stderr, exitCode, timedOut}`. Throws `CoveError` if the
   * stream ends in `error` or `paused` instead of `exit`. A command killed at its
   * `timeoutSecs` deadline resolves with `exitCode` 124 and `timedOut: true` (it used
   * to throw `exec failed: command timed out after Ns`).
   */
  async execCollect(
    name: string,
    opts: ExecOptions,
    overrides: RequestOverrides = {},
  ): Promise<ExecCollectResult> {
    let stdout = "";
    let stderr = "";
    for await (const evt of this.exec(name, opts, overrides)) {
      if (evt.kind === "stdout") {
        stdout += evt.data;
      } else if (evt.kind === "stderr") {
        stderr += evt.data;
      } else if (evt.kind === "exit") {
        return { stdout, stderr, exitCode: evt.code, timedOut: evt.timedOut };
      } else if (evt.kind === "error") {
        throw new CoveError(`exec failed: ${evt.error}`);
      } else if (evt.kind === "paused") {
        throw new CoveError(
          `exec interrupted: VM left Running mid-exec (${evt.reason}, new state: ${evt.newState})`,
        );
      }
    }
    throw new CoveError("exec stream ended without a terminal event");
  }
}
