import { type AuthOptions, resolveAuth } from "./auth.js";
import { CoveHttp, type VersionSkewHook } from "./http.js";
import { AdminResource } from "./resources/admin.js";
import { AuditResource } from "./resources/audit.js";
import { CheckpointsResource } from "./resources/checkpoints.js";
import { EventsResource } from "./resources/events.js";
import { HostResource } from "./resources/host.js";
import { KeysResource } from "./resources/keys.js";
import { MetaResource } from "./resources/meta.js";
import { PoliciesResource } from "./resources/policies.js";
import { SecretsResource } from "./resources/secrets.js";
import { SpotlightResource } from "./resources/spotlight.js";
import { TagsResource } from "./resources/tags.js";
import { TeamsResource } from "./resources/teams.js";
import { VmsResource } from "./resources/vms.js";
import { WebhooksResource } from "./resources/webhooks.js";

/** Credential fields (exactly one required) are inherited from {@link AuthOptions}. */
export interface CoveClientOptions extends AuthOptions {
  /** Base URL of the cove daemon, e.g. `https://<cove-host>`. Trailing slash is stripped. */
  baseUrl: string;
  /** Custom fetch implementation — defaults to the global `fetch`. Useful for Node <18 polyfills or test doubles. */
  fetch?: typeof fetch;
  /**
   * Default deadline in milliseconds for a non-streaming request. Composed
   * with a per-call `signal` rather than replaced by it — whichever fires
   * first wins. Any single call can override it through the `timeoutMs` of
   * its trailing `RequestOverrides`.
   *
   * For a streaming call (`vms.exec`, `vms.streamConsole`) it bounds the wait
   * for the response headers only: an abort signal stays bound to the response
   * body, so a whole-request deadline would cut the stream off mid-flight.
   */
  timeoutMs?: number;
  /**
   * Permit an `http://` `baseUrl` to a non-loopback host (the credential then
   * travels in cleartext). Default `false`; loopback is always allowed.
   */
  allowInsecureHttp?: boolean;
  /**
   * Called once per client, on the first response whose `x-cove-api-version`
   * differs from the API version this SDK speaks, with both versions. The
   * request itself still succeeds. Omitted, the default emits one
   * `process.emitWarning(…, "CoveApiVersionWarning")` where that exists and
   * is silent elsewhere; `null` disables it. The SDK never writes to the
   * console; a server that refuses this SDK's version answers 426 instead —
   * see `UpgradeRequiredError`.
   */
  onVersionSkew?: VersionSkewHook | null;
}

/**
 * Client for the Cove external REST API.
 *
 * ```ts
 * const client = new CoveClient({
 *   baseUrl: "https://<cove-host>",
 *   token: "cvk_...",
 * });
 * for await (const vm of client.vms.iter()) console.log(vm.name);
 * ```
 *
 * Resource groups follow the API's areas; see `index.ts` for the list.
 */
export class CoveClient {
  readonly vms: VmsResource;
  readonly checkpoints: CheckpointsResource;
  readonly policies: PoliciesResource;
  readonly host: HostResource;
  readonly secrets: SecretsResource;
  readonly tags: TagsResource;
  readonly audit: AuditResource;
  readonly keys: KeysResource;
  readonly webhooks: WebhooksResource;
  readonly meta: MetaResource;
  /** Fleet administration; needs an administrator. See {@link AdminResource}. */
  readonly admin: AdminResource;
  /** Teams and their rosters. See {@link TeamsResource}. */
  readonly teams: TeamsResource;
  /** The server's event streams, reconnecting across its 300 s close. See {@link EventsResource}. */
  readonly events: EventsResource;
  /**
   * Mirror a local git worktree onto a VM directory, switch it, and restore the base tree, over
   * the file and exec API. Node.js only. See {@link SpotlightResource}.
   */
  readonly spotlight: SpotlightResource;
  readonly #http: CoveHttp;

  constructor(opts: CoveClientOptions) {
    const http = new CoveHttp({
      baseUrl: opts.baseUrl,
      auth: resolveAuth(opts),
      fetch: opts.fetch,
      timeoutMs: opts.timeoutMs,
      allowInsecureHttp: opts.allowInsecureHttp,
      onVersionSkew: opts.onVersionSkew,
    });
    this.#http = http;
    this.vms = new VmsResource(http);
    this.checkpoints = new CheckpointsResource(http);
    this.policies = new PoliciesResource(http);
    this.host = new HostResource(http);
    this.secrets = new SecretsResource(http);
    this.tags = new TagsResource(http);
    this.audit = new AuditResource(http);
    this.keys = new KeysResource(http);
    this.webhooks = new WebhooksResource(http);
    this.meta = new MetaResource(http);
    this.admin = new AdminResource(http);
    this.teams = new TeamsResource(http);
    this.events = new EventsResource(http);
    this.spotlight = new SpotlightResource(this.vms, this.tags);
  }

  /**
   * The API version the server advertised (`x-cove-api-version`) on the last
   * response that carried one; `undefined` until then. In a browser the
   * header is readable cross-origin only if the server exposes it (CORS
   * `Access-Control-Expose-Headers`).
   */
  get serverApiVersion(): number | undefined {
    return this.#http.serverApiVersion;
  }

  /**
   * Keep the credential out of anything that serializes the client — a log
   * line, an error report, a structured-logging call that stringifies its
   * context. The credential is already an ECMAScript private field on the auth
   * strategy, so this is belt and braces; it also spares callers a wall of
   * resource internals.
   */
  toJSON(): Record<string, unknown> {
    return { type: "CoveClient", auth: "[redacted]" };
  }
}
