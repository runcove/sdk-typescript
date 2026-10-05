import { CoveError } from "../errors.js";
import { apiPath, type CoveHttp, type RequestOverrides } from "../http.js";
import { parseSSE, type ServerSentEvent } from "../sse.js";
import type {
  AllVmEventsStreamEvent,
  LifecycleEventData,
  LifecycleStreamEvent,
  StreamReconnected,
  VmEventStreamEvent,
} from "../types.js";

/** Options of the `client.events` streams: the per-call overrides plus reconnect behaviour. */
export interface EventStreamOptions extends RequestOverrides {
  /**
   * Reconnect when the server ends the stream cleanly (it does after 300 s).
   * Default `true`. `false` ends the iterator at the first clean close.
   */
  reconnect?: boolean;
  /**
   * The least time between two connects, in milliseconds. Default `1000`: at
   * most one reconnect per second, so a server that closes at once is not
   * hammered. Must be a finite number, `0` or more; anything else throws a
   * {@link CoveError} when the stream is opened.
   */
  reconnectMinIntervalMs?: number;
}

/**
 * `client.events` — the server's event streams (SSE) as async iterators.
 * Scope: `vms:read`.
 *
 * The server closes every stream after 300 s. The iterator reconnects by
 * default. The server does not replay: events emitted between the close and
 * the reconnect are not delivered — a `reconnected` event marks each gap;
 * re-list (`vms.list`) if you need the state after it. `lagged` means the
 * server dropped `skipped` events because this consumer fell behind. The
 * server reads no `Last-Event-ID`, and the SDK sends none.
 *
 * Each iterator ends when `signal` aborts (the abort error passes through
 * unwrapped), when the server answers a connect or reconnect with an error
 * status (the typed {@link CoveAPIError} subclass is thrown), or on a transport
 * failure mid-stream ({@link CoveConnectionError}). Only a clean end of stream
 * reconnects. Leaving a `for await` loop early closes the connection.
 */
export class EventsResource {
  constructor(private readonly http: CoveHttp) {}

  /**
   * State changes on every VM the caller owns (`GET /api/vms/events`):
   * `vm-update`, `vm-created`, `vm-deleted`, plus `lagged` and `reconnected`.
   * The set of VMs is the caller's own, refreshed on each create and delete.
   */
  all(opts: EventStreamOptions = {}): AsyncGenerator<AllVmEventsStreamEvent> {
    return reconnecting(
      opts,
      (o) => this.http.requestSSE("GET", apiPath`/api/vms/events`, o),
      mapAllVmEvents,
    );
  }

  /**
   * Creation progress and state changes of one VM (`GET /api/vms/{name}/events`):
   * `state` (sent first on every connect), `progress`, `error`, plus `lagged`
   * and `reconnected`. A VM the caller cannot view answers 404, the same as
   * one that does not exist ({@link NotFoundError}).
   *
   * The iterator ends by itself, without reconnecting or throwing, after a
   * `state` of `deleted` or an `error` (a failed create): the server ends the
   * stream there, because the name is free again and a later VM under it is a
   * different VM, which needs a new `vm(name)` call.
   */
  vm(name: string, opts: EventStreamOptions = {}): AsyncGenerator<VmEventStreamEvent> {
    return reconnecting(
      opts,
      (o) => this.http.requestSSE("GET", apiPath`/api/vms/${name}/events`, o),
      mapVmEvents,
      (evt) => (evt.kind === "state" && evt.state === "deleted") || evt.kind === "error",
    );
  }

  /**
   * Typed lifecycle events with their actor (`GET /api/lifecycle-events`).
   * An administrator sees the whole fleet; anyone else, the VMs they owned
   * when the stream opened (so a VM created later appears from the next
   * reconnect) and their own key events.
   */
  lifecycle(opts: EventStreamOptions = {}): AsyncGenerator<LifecycleStreamEvent> {
    return reconnecting(
      opts,
      (o) => this.http.requestSSE("GET", apiPath`/api/lifecycle-events`, o),
      mapLifecycleEvents,
    );
  }
}

/**
 * The reconnect loop shared by the three streams. `connect` makes the one
 * request (each method keeps its own literal call site); `map` turns a frame
 * into the typed event, or `null` for a frame the SDK does not yield;
 * `terminal` names an event after which the server ends the stream for good,
 * so the iterator ends there too. The options are checked here, at the call,
 * rather than at the first `next()`.
 */
function reconnecting<T>(
  opts: EventStreamOptions,
  connect: (overrides: RequestOverrides) => Promise<Response>,
  map: (evt: ServerSentEvent) => T | null,
  terminal: (evt: T) => boolean = () => false,
): AsyncGenerator<T | StreamReconnected> {
  const { reconnectMinIntervalMs = 1000 } = opts;
  // `NaN` or a negative interval would make every pause zero: a server that
  // closes at once would be reconnected in a tight loop.
  if (!Number.isFinite(reconnectMinIntervalMs) || reconnectMinIntervalMs < 0) {
    throw new CoveError(
      `reconnectMinIntervalMs must be a finite number of milliseconds, 0 or more; got ${String(reconnectMinIntervalMs)}`,
    );
  }
  return reconnectLoop(opts, connect, map, terminal);
}

async function* reconnectLoop<T>(
  opts: EventStreamOptions,
  connect: (overrides: RequestOverrides) => Promise<Response>,
  map: (evt: ServerSentEvent) => T | null,
  terminal: (evt: T) => boolean,
): AsyncGenerator<T | StreamReconnected> {
  const { reconnect = true, reconnectMinIntervalMs = 1000, ...overrides } = opts;
  let lastConnect: number | undefined;
  for (;;) {
    if (lastConnect !== undefined) {
      await pause(lastConnect + reconnectMinIntervalMs - Date.now(), overrides.signal);
    }
    const reconnected = lastConnect !== undefined;
    lastConnect = Date.now();
    // A non-2xx throws the typed error here and ends the iterator.
    const response = await connect(overrides);
    try {
      // Marked only once the reconnect succeeded, so a refused reconnect never
      // announces a gap that is not followed by events.
      if (reconnected) yield { kind: "reconnected" };
      if (response.body) {
        for await (const evt of parseSSE(response.body)) {
          const out = map(evt);
          if (out === null) continue;
          yield out;
          // The `finally` below cancels the body.
          if (terminal(out)) return;
        }
      }
    } finally {
      // A consumer that leaves at the `reconnected` marker never starts
      // `parseSSE`, whose own cleanup cancels the body; cancel it here so the
      // connection is not left open. After `parseSSE` ran (drained, broken out
      // of, or failed) the body is closed or cancelled and unlocked, and this
      // is a no-op.
      await response.body?.cancel().catch(() => {});
    }
    if (!reconnect) return;
  }
}

/** Wait `ms` (nothing when it is not positive), rejecting with the signal's reason on abort. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    if (ms <= 0) {
      resolve();
      return;
    }
    const onAbort = (): void => {
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

/** The frame's JSON `data`; a frame that is not JSON is a `CoveError`, not a bare `SyntaxError`. */
function data<T>(evt: ServerSentEvent): T {
  try {
    return JSON.parse(evt.data) as T;
  } catch {
    throw new CoveError(`Unparseable \`${evt.event}\` event frame: ${evt.data.slice(0, 200)}`);
  }
}

const lagged = (evt: ServerSentEvent) => ({
  kind: "lagged" as const,
  skipped: data<{ skipped: number }>(evt).skipped,
});

function mapAllVmEvents(evt: ServerSentEvent): AllVmEventsStreamEvent | null {
  switch (evt.event) {
    case "vm-update":
    case "vm-created":
    case "vm-deleted": {
      const d = data<Omit<Extract<AllVmEventsStreamEvent, { vm_name: string }>, "kind">>(evt);
      return { kind: evt.event, ...d };
    }
    case "lagged":
      return lagged(evt);
    default:
      // `connected`, and any frame a newer server adds.
      return null;
  }
}

function mapVmEvents(evt: ServerSentEvent): VmEventStreamEvent | null {
  switch (evt.event) {
    case "state": {
      const d = data<{ state: Extract<VmEventStreamEvent, { kind: "state" }>["state"]; timestamp: string }>(evt);
      return { kind: "state", state: d.state, timestamp: d.timestamp };
    }
    case "progress":
    case "error": {
      const d = data<{ stage: string; message: string }>(evt);
      return { kind: evt.event, stage: d.stage, message: d.message };
    }
    case "lagged":
      return lagged(evt);
    default:
      return null;
  }
}

function mapLifecycleEvents(evt: ServerSentEvent): LifecycleStreamEvent | null {
  switch (evt.event) {
    case "lifecycle":
      return { kind: "lifecycle", event: data<LifecycleEventData>(evt) };
    case "lagged":
      return lagged(evt);
    default:
      return null;
  }
}
