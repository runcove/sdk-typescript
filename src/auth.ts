/**
 * Pluggable authentication strategies for the Cove SDK.
 *
 * The client is credential-agnostic: it holds a {@link CoveAuth} and calls
 * {@link CoveAuth.apply} on the headers of every outgoing request. Swapping the
 * platform's auth model later — a real OAuth/OIDC bearer flow, request signing,
 * mTLS-fronted headers — means adding one `CoveAuth` implementation, with no
 * change to `CoveHttp` or any resource group.
 *
 * Two schemes ship today, mirroring the `cove` CLI's `AuthMode`:
 *   - {@link BearerAuth} — `cvk_` API key, `Authorization: Bearer …`, spoken by
 *     the external bearer listener (`[api] bind`).
 *   - {@link TicketAuth} — Warpgate SSO ticket, `Authorization: Warpgate …`,
 *     spoken by the main Warpgate-fronted listener.
 */

import { CoveConfigError } from "./errors.js";

/**
 * A credential strategy. `apply` mutates the outgoing request's headers to
 * carry authentication. It may be async so an implementation can refresh an
 * expired token (e.g. an OAuth refresh) before the request goes out.
 */
export interface CoveAuth {
  apply(headers: Headers): void | Promise<void>;
}

/** `Authorization: Bearer <token>` — a `cvk_` API key for the external bearer listener. */
export class BearerAuth implements CoveAuth {
  /**
   * ECMAScript private, not TypeScript `private`: the latter is erased at
   * compile time, leaving the credential an ordinary enumerable property that
   * `JSON.stringify` and `util.inspect` print for any object reachable from
   * the client. A `#` field is not reachable at all from outside the class.
   */
  readonly #token: string;

  constructor(token: string) {
    if (!token) {
      throw new CoveConfigError("BearerAuth requires a non-empty token");
    }
    this.#token = token;
  }
  apply(headers: Headers): void {
    headers.set("Authorization", `Bearer ${this.#token}`);
  }
}

/**
 * `Authorization: Warpgate <ticket>` — the Warpgate SSO ticket the `cove` CLI
 * persists after `cove login` (`~/Library/Application Support/cove/ticket` on
 * macOS, `~/.config/cove/ticket` on Linux). Works against a deployment that has
 * not enabled the external bearer listener; note that sensitive operations may
 * trigger Warpgate's interactive sudo step-up, which a headless caller cannot
 * satisfy (that is what {@link BearerAuth} is for).
 */
export class TicketAuth implements CoveAuth {
  /** ECMAScript private, so the ticket never serializes — see {@link BearerAuth}. */
  readonly #ticket: string;

  constructor(ticket: string) {
    if (!ticket) {
      throw new CoveConfigError("TicketAuth requires a non-empty ticket");
    }
    this.#ticket = ticket;
  }
  apply(headers: Headers): void {
    headers.set("Authorization", `Warpgate ${this.#ticket}`);
  }
}

/** Options that carry a credential. Exactly one of `auth` / `token` / `ticket` is required. */
export interface AuthOptions {
  /**
   * A custom {@link CoveAuth} strategy — the swap-in point for a future auth
   * model (sync or async `apply`, e.g. to refresh an OAuth token).
   */
  auth?: CoveAuth;
  /**
   * Bearer API key (`cvk_<43 base62 chars>`), minted via `cove key create` or
   * `POST /api/api-keys`. Shorthand for {@link BearerAuth} — sent as
   * `Authorization: Bearer …` to the external bearer listener.
   */
  token?: string;
  /**
   * Warpgate SSO ticket — the credential the `cove` CLI persists after
   * `cove login`. Shorthand for {@link TicketAuth} — sent as
   * `Authorization: Warpgate …` to the main Warpgate-fronted listener, so it
   * works against a deployment that has NOT enabled the bearer listener.
   */
  ticket?: string;
}

/**
 * Resolve exactly one of `auth` / `token` / `ticket` into a {@link CoveAuth}.
 * Throws if none or more than one is supplied.
 */
export function resolveAuth(opts: AuthOptions): CoveAuth {
  const supplied = [
    opts.auth,
    opts.token === undefined ? undefined : new BearerAuth(opts.token),
    opts.ticket === undefined ? undefined : new TicketAuth(opts.ticket),
  ].filter((a): a is CoveAuth => a !== undefined);
  const [auth, extra] = supplied;
  if (!auth) {
    throw new CoveConfigError(
      "No credential supplied; pass one of `auth`, `token`, or `ticket`",
    );
  }
  if (extra) {
    throw new CoveConfigError("Pass exactly one of `auth`, `token`, or `ticket`");
  }
  return auth;
}
