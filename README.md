# @runcove/sdk

TypeScript SDK for the Cove external REST API — the bearer-auth surface
of the `cove-server` daemon. Its types are generated from
`sdk/openapi.yaml`, the canonical contract for this
package; the client on top of them (transport, auth, streams, pagination,
errors) is hand-written.

- ESM + CJS builds (`import` and `require` both work).
- Node >= 18 or any browser/edge runtime — web platform APIs only (global
  `fetch`, `Headers`, `ReadableStream`, `AbortSignal.timeout`, WebCrypto).
  Browser callers authenticate with a bearer key and need CORS/network reach
  to the host; no ambient session/ticket pickup exists in the browser.
- Zero runtime dependencies.
- Resource groups follow the API's areas: `vms`, `checkpoints`, `policies`, `host`, `secrets`, `tags`, `audit`, `keys`, `webhooks`, `meta`, `events`, `teams`, `admin`, `spotlight` (see `src/index.ts` for the list).

> **0.x: no stability promise.** Names follow the public vocabulary, which
> changed on 2026-07-26. A rename is a clean
> removal of the old name, not a deprecated alias, and the breaking ones are
> listed in the root `CHANGELOG.md` and the release notes. Pin an exact
> version rather than a range.

## Install

Install the package from the npm registry. The SDK is pre-1.0, so pin an exact version:

```sh
npm install --save-exact @runcove/sdk
```

To match a Cove server, take `<version>` from `https://<cove-host>/public/sdk/index.json`, then run
`npm install --save-exact @runcove/sdk@<version>`.

### Inside a Cove VM, a release less than three days old is held back

The Cove golden images set npm's `min-release-age=3` (days), so npm will not install a version
published less than three days ago: right after a release, `npm install @runcove/sdk` fails with
`ENOVERSIONS`, and later it can quietly pick an older version. Lift the cooldown for this one
command, pinned to the version you want:

```sh
npm install --save-exact --min-release-age=0 @runcove/sdk@<version>
```

The package has no runtime dependencies, so this lifts the cooldown for the SDK alone. Alternatively
install the tarball your server serves, by its URL (below); the cooldown does not apply to it.

### From your Cove server

A Cove server can also serve an SDK version, the one its operator installed on it, without
authentication, under `/public/sdk/` on its main (web) address; the API-key listener does not
serve it. Use this when you want exactly the SDK version your server's operator chose, or when you install
from a mirror that cannot reach the npm registry. `/public/sdk/index.json` lists each file and its
version. Install the tarball by its URL, pinned to that version:

```sh
curl -s "https://<cove-host>/public/sdk/index.json"   # find <version>
npm install "https://<cove-host>/public/sdk/cove-sdk-<version>.tgz"
```

The SDK that matches a server is the one that server serves (see "Versions").

## Authentication

Pass exactly one credential. The client is credential-agnostic — it holds a
`CoveAuth` strategy and applies it to every request:

```ts
import { CoveClient, BearerAuth, TicketAuth } from "@runcove/sdk";

// 1. Bearer API key (`cvk_…`) — the external bearer listener (`[api] bind`).
new CoveClient({ baseUrl, token: "cvk_..." });

// 2. Warpgate SSO ticket — the credential the `cove` CLI persists after
//    `cove login` (~/Library/Application Support/cove/ticket on macOS,
//    ~/.config/cove/ticket on Linux). Works against a deployment that has
//    NOT enabled the bearer listener. Note: sensitive ops (e.g. delete) may
//    trigger Warpgate's interactive sudo step-up, which a headless caller
//    cannot satisfy — use a bearer key for automation. Five admin operations
//    are the exception: they refuse every bearer key with 401 `sudo_required`.
//    updateVmAgents, bulkStopVms, bulkDeleteVms and deleteAnyCheckpoint need a
//    ticket or a session; drainHost is never served on the Warpgate-fronted
//    listener either, so in practice a drain runs on the host's Unix socket.
new CoveClient({ baseUrl, ticket: readFileSync(ticketPath, "utf8").trim() });

// 3. A custom strategy — the swap-in point for a future auth model. Implement
//    `CoveAuth` (sync or async `apply`, e.g. to refresh an OAuth token).
class MyAuth implements CoveAuth {
  async apply(headers: Headers) {
    headers.set("Authorization", `Bearer ${await this.freshToken()}`);
  }
}
new CoveClient({ baseUrl, auth: new MyAuth() });
```

`token` and `ticket` are shorthands for `new BearerAuth(...)` / `new TicketAuth(...)`.

## Quickstart

```ts
import { CoveClient } from "@runcove/sdk";

// The external bearer listener (`[api] bind`): loopback by default, so plain
// http is accepted. A `cvk_` key is refused with 401 on the Warpgate-fronted
// `https://<cove-host>` address, which takes a Warpgate ticket instead.
const client = new CoveClient({
  baseUrl: "http://127.0.0.1:8090",
  token: "cvk_...", // minted via `cove key create` or POST /api/api-keys
});

// List running VMs. `list` returns one page plus a `next_cursor`; `iter`
// follows the cursor for you, which is what "all of them" needs.
for await (const vm of client.vms.iter({ state: "running" })) console.log(vm.name);

// Create a VM (async — 202 accepted), then wait for it. `waitForState` polls
// `get` and throws a `CoveTimeoutError` after `timeoutMs` (default 300 000). Without
// `image` the host's default image is used; a name the host does not have is
// a 404 `unknown_image` whose message lists the ones it has.
const { name } = await client.vms.create({});
try {
  const detail = await client.vms.waitForState(name, ["running"], { timeoutMs: 300_000 });
  console.log(detail.state);
} finally {
  // Delete it when done, so no stopped VM is left behind (a stopped VM still
  // holds its disk and its name). A 429 here must be retried: see "Rate limit".
  await client.vms.delete(name);
}
```

A Cove deployment has two listeners and each accepts one kind of credential: a
`cvk_` API key goes to the bearer listener (`127.0.0.1:8090` by default, or
wherever `[api] bind` points), a Warpgate ticket to the Warpgate-fronted main
address (see "Authentication"). The wrong credential on a listener is a 401. From another
machine, either forward the port (`ssh -L 8090:127.0.0.1:8090 <cove-host>`, which needs a shell
account on the host) and keep the loopback URL, or point `baseUrl` at the `https://` address an
operator has fronted the listener with (see the external API page of the Cove
docs).

VM names: `create()` without a `name` lets the server pick one. A name you
choose must be 3-30 characters of lowercase ASCII letters, digits and hyphens,
and must not start or end with a hyphen (`web-1`, not `Web_1`, `ab` or
`-web`); a clone's `new_vm_name` follows the same rule. Any other name throws a
`CoveAPIError` with `status === 400` and `code === "invalid_vm_name"`, before
anything is created, and `err.body.name` echoes the refused name.

An `http://` `baseUrl` is refused with a `CoveConfigError` unless the host is loopback
(`localhost`, `127.0.0.0/8`, `[::1]`), because the credential would travel in cleartext; pass
`allowInsecureHttp: true` to accept that for another host. A single SSE line or
event over 16 MiB is cancelled with a `CoveError`.

### Per-call overrides: cancellation, deadlines, headers

Every method takes an optional `RequestOverrides` bag as its last parameter,
after any parameters of its own:

```ts
interface RequestOverrides {
  signal?: AbortSignal;              // cancel this call
  timeoutMs?: number;                // deadline for this call
  headers?: Record<string, string>;  // extra headers on this call
}
```

A client-wide `timeoutMs` sets the default deadline; a call can raise or
lower it for itself. The two compose with `signal` rather than replacing it —
whichever fires first wins:

```ts
const client = new CoveClient({
  baseUrl: "http://127.0.0.1:8090",
  token: "cvk_...",
  timeoutMs: 30_000, // default deadline per request
});

const controller = new AbortController();
await client.vms.get("my-vm", { signal: controller.signal });

// A long build needs more than the client default; a health check needs less.
await client.vms.execWithSecrets("my-vm", { command: ["./build.sh"], selector: { kind: "all" } }, {
  timeoutMs: 600_000,
});
await client.meta.health({ timeoutMs: 2_000 });

// Extra headers are merged in. The SDK's own win: a caller cannot displace
// `Authorization`, `Accept`, `Content-Type`, or the API version.
await client.vms.list({ state: "running" }, { headers: { "X-Trace-Id": traceId } });
```

For a streaming call (`vms.exec`, `vms.streamConsole`, `client.events`) the deadline bounds the
wait for the response headers only — once the stream is open it runs until the
server ends it or `signal` aborts, so a deadline can never cut it off
mid-flight. Note that a method's own options and its overrides stay separate:
`exec`'s `timeoutSecs` is the deadline the *server* enforces on the command
inside the guest, while `timeoutMs` is this client's deadline on the HTTP
request carrying it.

## Streaming exec

`client.vms.exec` streams command output as it happens (SSE under the hood),
yielding a discriminated union you can switch on:

```ts
for await (const evt of client.vms.exec("my-vm", { command: ["ls", "-la"] })) {
  switch (evt.kind) {
    case "stdout":
      process.stdout.write(evt.data); // raw chunk, newline included
      break;
    case "stderr":
      process.stderr.write(evt.data);
      break;
    case "exit":
      // timedOut: killed at the timeoutSecs deadline (30 s when omitted); code is then 124.
      console.log("exited with", evt.code, evt.timedOut ? "(timed out)" : "");
      break;
    case "error":
      console.error("exec error:", evt.error);
      break;
    case "paused":
      console.warn("VM left Running mid-exec:", evt.reason, evt.newState);
      break;
  }
}
```

If you just want the buffered result, use `execCollect` (throws on `error`/`paused`).
A command killed at its deadline resolves with `exitCode` 124 and `timedOut: true`
rather than throwing:

```ts
const { stdout, stderr, exitCode, timedOut } = await client.vms.execCollect("my-vm", {
  command: ["cat", "/etc/os-release"],
  timeoutSecs: 10,
});
```

For secrets-injected exec (server buffers the whole run and returns JSON
instead of streaming), use `execWithSecrets` with an `InjectSelector`:

```ts
const result = await client.vms.execWithSecrets("my-vm", {
  command: ["./deploy.sh"],
  selector: { kind: "all" },
  timeoutSecs: 300,
});
```

`timeoutSecs` is the server's deadline on the command, 30 s when omitted and
at most 3600 (the server refuses a larger value with 400 `validation_failed`). A
command still running at the deadline is killed, together with everything that
stayed in its process group, and the result is `exit_code` 124 with `timed_out: true` and the
output written before then.

Live-tail the serial console the same way, via an async generator of lines:

```ts
for await (const line of client.vms.streamConsole("my-vm", { lines: 20 })) {
  console.log(line);
}
```

## File transfer

`client.vms.files` moves single files in and out of a running VM (`GET`,
`PUT` and `HEAD` on `/api/vms/{name}/files`). The key needs `files:read` to
stat or download and `files:write` to upload; both are in a new key's
default scopes. `files:write` is as strong as `vms:exec`: a file written as
root can run code. The caller also needs SSH access to the VM. `path` is the
file's absolute path in the guest.

```ts
import { createReadStream, statSync } from "node:fs";

// Size, permission bits and modification time, without reading the file.
const { size, mode, mtime } = await client.vms.files.stat("my-vm", "/etc/os-release");

// The whole file in memory.
const bytes = await client.vms.files.downloadBytes("my-vm", "/var/log/app.log");

// Or a stream, for a large file.
const dl = await client.vms.files.download("my-vm", "/var/log/app.log");
for await (const chunk of dl.body) process.stdout.write(chunk);

// Upload bytes, a string, a Blob, or a stream with its size.
const done = await client.vms.files.upload("my-vm", "/root/run.sh", "#!/bin/sh\necho hi\n", {
  mode: 0o755,
});
console.log(done.size, done.sha256);

await client.vms.files.upload("my-vm", "/root/data.tar", createReadStream("data.tar"), {
  size: statSync("data.tar").size,
});
```

What to rely on:

- **A short download is a failed download.** Once the server has sent
  `200` it cannot change the status, so a transfer that fails part-way ends
  the body early. The SDK checks the body against its `Content-Length`: the
  stream errors with `DownloadTruncatedError` (`expectedBytes`,
  `receivedBytes`), and `downloadBytes` rejects with it. It never hands back
  fewer bytes as if they were the file.
- **An upload needs its size up front.** The server refuses a chunked body,
  so a stream or async iterable needs `size`. A stream that yields a
  different number of bytes fails with `CoveError` before the server commits
  anything. A source that throws mid-upload raises its own error. The guest
  writes a temporary file and renames it into place only once every byte has
  arrived, so a failed upload leaves the old file as it was. Streaming a
  request body needs a `fetch` that supports it (Node 18+); in a browser, pass
  a `Blob`.
- **Timeouts.** For `download` and `downloadBytes`, `timeoutMs` bounds the
  wait for the headers only, and the caller's `signal` stays live for the
  body. For `upload` it bounds the whole request, so raise it per call for a
  large file. The server ends a transfer that averages under 256 KiB/s (after
  60 s at least).
- **Typed errors.** 413 `file_too_large` is `FileTooLargeError` (the message
  states the host's limit). 403 `file_path_denied` is `FilePathDeniedError`,
  for a deny-listed or pseudo-filesystem path; a key without the scope is a
  plain `PermissionDeniedError`. 404 `file_not_found` is
  `VmFileNotFoundError`, and a missing VM is a plain `NotFoundError`. 422
  `file_not_regular` is `FileNotRegularError`: a directory, a device, or a
  symlink anywhere in the path, since symlinks are refused and never
  followed. 503 `unavailable` is `UnavailableError` (any endpoint's 503
  `unavailable`; here, the guest agent was lost or timed out, or it already
  has as many transfers open as it allows). Retry it. Each class extends its status class (`PermissionDeniedError`,
  `NotFoundError`, …), so existing `catch` blocks still match. A `HEAD` error
  has no body; the server names its code in `X-Cove-Error-Code`, so `stat`
  raises the same class a download would. From a server without that header
  (or a browser it is not exposed to), the status alone picks: a 403 or a
  404 there stays the plain class, with no `code`.
- **Mode.** `mode` is a number (`0o755`) or the octal string the server takes
  (`"0755"`), within `0o777`. Without one, the server keeps the replaced
  file's bits, or uses `0644` for a new file. `stat` and `download` report
  `mode` as a number, like `FileUploaded.mode`, and `mtime` as a `Date`
  from `Last-Modified`. `mtime` is `undefined` only when the server sent no
  such header. A browser reads `Last-Modified` cross-origin freely (it is
  CORS-safelisted) but `mode` only if the server exposes `X-Cove-File-Mode`;
  otherwise `mode` is `undefined`.

## Spotlight

`client.spotlight` (Node.js only) puts a local git worktree onto a long-lived
VM at a path, switches it to another worktree, and puts the base tree back
with `off`, without restarting anything on the VM. It is the SDK's form of
`cove dev spotlight`, over the HTTP API alone: no SSH, and no rsync on your
machine; `git` must be on `PATH`.

```ts
const on = await client.spotlight.on("my-box", { tree: "./wt-feature", dest: "/srv/app" });
// later: switch the same box to another worktree
await client.spotlight.on("my-box", { tree: "./wt-fix", dest: "/srv/app" });
await client.spotlight.status("my-box"); // { dest, base, source } or null
await client.spotlight.off("my-box", { tree: "." }); // restores the base commit
```

- **What is sent.** The worktree's tracked files plus its untracked files git
  does not ignore (`git ls-files -co --exclude-standard`), as one gzip tar
  uploaded with `vms.files`, with modes and symlinks kept. Each switch sends
  the whole tree; one over the host's file limit fails with
  `FileTooLargeError` before anything changes on the VM. The tree is read,
  tarred and gzipped in memory (`gzipSync` blocks the event loop while it
  runs), so it suits source trees rather than large binaries, and the upload
  counts against the client's `timeoutMs`. A submodule's contents are not
  sent, so a switch deletes a submodule's files in `dest` unless a protect
  entry covers them.
- **How it lands.** One `exec` of a fixed sh script (every value is an
  argument) extracts the tar beside `dest` and mirrors it onto `dest` with
  delete semantics, with `rsync` when the image has it and `find`/`cp`
  otherwise. Nothing matching `protect` (rsync protect patterns, as the CLI
  uses; default `SPOTLIGHT_DEFAULT_PROTECT`: the `node_modules`, `target`,
  `volumes` and `.venv` directories, and `.env`), nor anything below it, nor a `.git/`, is
  ever deleted, so what the VM built there survives a switch. A file the tree
  itself holds there is still written, as with the CLI. Wildcards in an
  entry behave as in rsync only within one path component (as in the
  defaults' plain names): on the fallback path a `*` can also match across
  a `/`. Files land owned by root (`root:root`), while the CLI's rsync
  writes them as the SSH user.
- **What `dest`'s `.gitignore` ignores is kept.** With rsync the script uses
  the CLI's filter rules in the CLI's order (`:- .gitignore`, then
  `--exclude=.git/`, then the protect rules): `.git/` is never touched, and
  a path a `.gitignore` in `dest` ignores (build output, `*.log`, `.env.local`)
  is not deleted. rsync reads the `.gitignore` files `dest` holds before the
  switch, so the first bind of a `dest` with none deletes ignored files, as
  the CLI's first sync does. As with the CLI, a file the tree holds that its
  own `.gitignore` ignores (a force-added one) is not written.
- **Without rsync on the VM** the script cannot read `.gitignore`, so when
  `dest` holds one outside a protected path it refuses (exit 3) before
  changing anything, and the error says to install rsync on the VM. A
  protected path inside a directory the tree replaces with a file or symlink
  can make this fallback fail part-way, after its deletions. The first
  fallback apply writes the tree's own `.gitignore` into `dest`, so on an image
  without rsync every later `on` and `off` is refused (and `off` cannot clear
  the binding) until rsync is installed.
- **Deadline.** The apply runs under `timeoutSecs` (default 300). An apply
  killed at its deadline throws `CoveError` saying so: `dest` may be
  half-mirrored, so run `on` again. The next run removes the stage
  directory the killed one left beside `dest`, and spotlight tarballs over
  an hour old in `/tmp`.
- **Where the binding lives.** In the VM's tags: `spotlight.base` (the HEAD
  of the first bind, which `off` restores; a switch keeps it),
  `spotlight.dest` and `spotlight.source` (the branch). They are written only
  after a successful apply, show in `cove tag ls <vm>`, and let
  `off` run from another process. `cove spotlight` in the CLI reads and
  writes the same tags, so each sees the other's binding. As with the CLI, `on` with a different
  `dest` re-points the binding but keeps the base, so `off` restores only the
  new `dest`, never the old one.
- **`off`** needs a checkout that holds the base commit (else `CoveError`:
  "run `git fetch`"), applies `git archive <base>` the same way, and deletes
  the tags. It restores the recorded commit by its id, never a branch or
  other ref. With nothing bound it resolves `null`, as the CLI's `off` does.
- **Scopes:** `tags:read` and `tags:write` (the binding), `files:write` (the
  upload), `vms:exec` (the apply). In a browser every method throws
  `CoveError`.

## Event streams

`client.events` turns the server's three event streams into async iterators
(`vms:read`): `all()` for state changes on every VM you own, `vm(name)` for one
VM's creation progress and state, and `lifecycle()` for typed lifecycle events
with the actor that caused them. Each yields a union discriminated on `kind`.
`all()` and `vm(name)` also carry advisories about a VM whose state did not
change (a health degrade or recovery, creation progress, pause and clone
details), so an event can repeat the state the previous one carried for that
VM: treat the state as idempotent and act when it changes, not on every event.

```ts
// Wait for web-1 to finish creating. Leaving the loop closes the stream; the
// iterator also ends by itself after a failed create or a delete.
watch: for await (const evt of client.events.vm("web-1")) {
  switch (evt.kind) {
    case "state":
      console.log("now", evt.state);
      if (evt.state === "running") break watch;
      break;
    case "progress":
      console.log("stage", evt.stage);
      break;
    case "error":
      // The last event: the server ends this stream here, and so does the loop.
      console.error("creation failed:", evt.message);
      break;
    case "lagged":
    case "reconnected":
      // Events were missed: re-read what you need (here the next `state`
      // frame after a reconnect is the current state anyway).
      break;
  }
}
```

The server closes every stream after 300 s. The iterator reconnects by
default. The server does not replay: events emitted between the close and the
reconnect are not delivered — a `reconnected` event marks each gap; re-list
(`vms.list`) if you need the state after it. `lagged` means the server dropped
`skipped` events because this consumer fell behind. The server reads no
`Last-Event-ID`, and the SDK sends none.

`vm(name)` ends without reconnecting or throwing after a `state` of `deleted`
or an `error` (a failed create): the server ends that stream there, since the
name is free again and a later VM under it is a different VM — call
`vm(name)` again to follow it.

Options: `reconnect: false` ends the iterator at the first clean close;
`reconnectMinIntervalMs` (default `1000`) is the least time between two
connects, so a reconnect happens at most once a second; it must be a finite
number, `0` or more, or opening the stream throws a `CoveError`. The iterator stops on
`signal` abort (the abort error passes through), on an error status at a
connect or reconnect (the typed error, e.g. `NotFoundError` for a VM you
cannot see), and on a transport failure mid-stream (`CoveConnectionError`);
only a clean close reconnects. `timeoutMs` bounds each connect's wait for the
response headers.

## Error handling

Non-2xx responses throw a `CoveAPIError` subclass matched to the HTTP status
(`AuthenticationError` for 401, `PermissionDeniedError` for 403,
`NotFoundError` for 404, `ConflictError` for 409, `PayloadTooLargeError` for
413, `ValidationError` for 422, `RateLimitError` for 429, `ServerError` for
5xx). A request the server cannot decode (malformed JSON, a field of the wrong
type, an unknown enum value, a query or path value of the wrong type) answers
400 `validation_failed`, which is a `ValidationError` too, as is any other
400 `validation_failed` the server answers (a relative path on file transfer,
for one), so one `instanceof ValidationError` covers both; a 400 with any
other code is a plain
`CoveAPIError`. A few codes get a subclass of their status class: the file-transfer
errors (see "File transfer") and 503 `unavailable` (`UnavailableError`). Every instance carries
`.status`, `.code` (when the body has a machine-readable `code` field), and
`.body` (the parsed JSON, or the raw text for the few endpoints — `/api/me`,
`/api/me/keys`, `/api/system/status` non-admin — that return plain text
instead of the `ApiError` envelope).

Everything else the SDK throws is a `CoveError` too, in the same classes as the
Python SDK's: `CoveConfigError` for a client that is configured wrongly (no
credential, more than one, an empty one, a malformed `baseUrl`, a `baseUrl`
with no host, a non-`http(s)` scheme, or plain `http://` to a non-loopback
host; thrown by `new CoveClient`, before any request), `CoveConnectionError`
for a server that cannot be reached, and `CoveTimeoutError` (a
`CoveConnectionError`) when a `timeoutMs` deadline expires, with the platform
`DOMException` as its `cause`. The one exception is your own `signal`: aborting it
rejects with the platform's `AbortError`, not a `CoveError`.

```ts
import { CoveAPIError, CoveTimeoutError, NotFoundError } from "@runcove/sdk";

try {
  await client.vms.get("does-not-exist");
} catch (err) {
  if (err instanceof NotFoundError) {
    // Cove collapses most 403s into 404s (existence non-leak): an object
    // that exists but isn't yours reads the same as a missing one.
    console.log("no such VM (or not yours)");
  } else if (err instanceof CoveAPIError) {
    console.error(err.status, err.code, err.body);
  } else if (err instanceof CoveTimeoutError) {
    console.error("deadline expired", err.cause);
  } else {
    throw err; // CoveConnectionError, or an abort of your own signal
  }
}
```

Capacity-check/quota denials on write endpoints (`vms.create`, `vms.start`,
`vms.resize`, `host.reserve`, ...) return HTTP 409 with a `DenyReason` body
(`{ code: "ram_headroom_exceeded", ... }`) instead of the usual `ApiError`
shape — inspect `err.body` for `code` and its companion numeric fields.

A 409 from `vms.create` has two causes, and `ConflictError.createConflict()`
tells them apart: `{ kind: "name_taken", retryAfterSecs }` when the name is
held by a live VM or is still in its post-delete cooldown (`retryAfterSecs`
says how long is left), `{ kind: "denied", reason }` for a capacity or quota
`DenyReason`, and `undefined` for any other 409 body.

```ts
import { ConflictError } from "@runcove/sdk";

try {
  await client.vms.create({ name: "web-1" });
} catch (err) {
  const why = err instanceof ConflictError ? err.createConflict() : undefined;
  if (why?.kind === "name_taken") {
    // retry after why.retryAfterSecs, or pick another name
  } else if (why?.kind === "denied") {
    // why.reason.code: "user_vcpu_quota_exceeded", "ram_headroom_exceeded", ...
  } else {
    throw err;
  }
}
```

### Rate limit (429 `rate_limited`)

The bearer listener allows each source IP 30 requests per second by default
(the operator sets it with `[api] rate_limit_per_ip`). The budget is per IP,
not per key or per client, so every caller behind one NAT or tunnel shares it,
and a program that fires many calls at once (`Promise.all` over a list) runs
through it fast. Past it, a call throws `RateLimitError` with
`code: "rate_limited"` and `retryAfterSecs`, the response's `Retry-After` in
seconds (`undefined` if the server sent none). The SDK **never retries**: wait
`retryAfterSecs`, then send the request again. Do this for cleanup too: a
`vms.delete` in a `finally` that gets a 429 must be retried, or the VM keeps
running. `ServerError` carries `retryAfterSecs` as well, set only when a 5xx
sent `Retry-After`.

```ts
import { RateLimitError } from "@runcove/sdk";

async function deleteWithRetry(name: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.vms.delete(name);
      return;
    } catch (err) {
      if (!(err instanceof RateLimitError) || attempt === attempts) throw err;
      await new Promise((r) => setTimeout(r, (err.retryAfterSecs ?? 1) * 1000));
    }
  }
}
```

## Versions

Every request declares the API version this SDK speaks (`X-Cove-Api-Version`,
generated from the contract), and every response the server tags with its
own. `client.serverApiVersion` is the last version the server advertised
(`undefined` until a response carried one).

- **The server speaks a different version but still serves this one.** The
  request succeeds, and `onVersionSkew` is called once per client with
  `{ client, server }`. By default that emits one
  `process.emitWarning(..., "CoveApiVersionWarning")` in Node and does
  nothing in a browser; pass your own function to route it to your logger,
  or `null` to turn it off. The SDK never writes to the console itself.

  ```ts
  const client = new CoveClient({
    baseUrl: "http://127.0.0.1:8090",
    token: process.env.COVE_API_KEY!,
    onVersionSkew: ({ client, server }) => log.warn({ client, server }, "cove API version skew"),
  });
  ```

- **The server no longer speaks this SDK's version.** It answers `426` with
  `code: "CLI_TOO_OLD"`, which the SDK throws as `UpgradeRequiredError`
  (a `CoveAPIError`), carrying `serverApiVersion` (when the response said)
  and `minCliVersion` (the oldest cove-cli release that speaks the server's
  version; it is a cove-cli version, not an SDK version). Install the SDK
  that matches the server from the deployment's `/public/sdk/index.json`,
  on its Warpgate-fronted URL: the external bearer listener does not serve
  `/public/sdk`. Any other `426` body stays a plain `CoveAPIError`.

In a browser, reading the server's version header cross-origin needs the
server to expose it through CORS. The external listener does so whenever
`[api] cors_origins` is set; where a server does not, `serverApiVersion`
stays `undefined` and the hook never fires.

## API keys

`client.keys` lists, creates, rotates and revokes bearer keys (`keys:manage`).
`create` takes the wire fields as they are (`admin_key`, `expires_in_secs`,
`service`, `member`, `team`), and the `raw_token` it returns is shown once.
Omit `scopes` for the default set.

Revoking a key (or the key expiring) refuses new requests with it at once, and
ends any stream already open with it (`client.events`, `vms.streamConsole`,
`vms.exec`) within the server's 15 s re-check interval: the `client.events`
iterators then fail their reconnect with the 401.

An **admin key** is the only kind that may hold `admin` or `admin:*` (and it
must hold one). It needs an expiry within the server's
`[auth] admin_max_key_lifetime_days` (default 30 days), and only an
administrator may mint one, and only from a signed-in session: over the bearer
API any `cvk_` key, admin key or not, gets 403 (see
[Fleet administration](#fleet-administration-clientadmin)). From the SDK that
means a client built with a `ticket` (the `cove key create --admin` command over
SSH, in the REPL or from a CLI signed in with `cove login` does the same).
Creating a key is sudo-gated, so the sign-in must be recent: a ticket older
than `[daemon] sudo_window_secs` (default 900 seconds) gets 401 `sudo_required`
(`AuthenticationError`) until a fresh `cove login`.

```ts
const sessionClient = new CoveClient({ baseUrl, ticket });
const admin = await sessionClient.keys.create({
  label: "fleet-report",
  scopes: ["admin:vms:read", "admin:host:read"],
  admin_key: true,
  expires_in_secs: 7 * 24 * 3600,
});
```

A **service key** (`svc:<name>`) belongs to a service rather than a person and
is bound to exactly one team or one member, whose VMs it is charged to and
controlled by. Administrators only; it needs an expiry within
`[auth] max_key_lifetime_days` and can never hold `keys:manage`,
`access:write`, `admin` or `admin:*`. `keys.list({ service: true })` lists
them. Over the bearer API an administrator's ordinary `cvk_` key does not count
as an administrator (only an admin key does), so minting or listing service
keys needs a client built with a `ticket` (a recent sign-in, as above) or an
admin key that also holds `keys:manage`; any other key gets 403. Service-key create and `keys.list({ service: true })` both need a server
at API version 6 or later (admin keys are not gated): the SDK reads the version
from `GET /api/whoami` first and throws a `CoveError`, sending nothing, when
the server is older or its version cannot be read.

```ts
// `sessionClient` is the ticket client from above; an admin key that holds
// `keys:manage` works too, an ordinary token client gets 403.
const svc = await sessionClient.keys.create({
  label: "deployer",
  service: "deployer",
  team: "platform", // or member: "alice"
  scopes: ["vms:read", "vms:write", "vms:exec"],
  expires_in_secs: 30 * 24 * 3600,
});
```

A team key (`team` without `service`) is administrators-only too, with the same
credential rules as a service key (a `ticket` client or an admin key holding
`keys:manage`; listing a team's keys with `keys.list({ team })` likewise), needs an
expiry and cannot hold `keys:manage`, `access:write` or any admin permission.

A key minted by a `token` client whose key expires never outlives that key.
Leave `expires_in_secs` out and the new key, of any kind, gets the calling
key's own expiry. Ask for a later one and the server refuses it with 422
`validation_failed`, `field: "expires_in_secs"` (a `ValidationError`); it is
never shortened for you. A calling key that never expires, or a `ticket`
client, changes nothing.

## Secrets

Secrets are addressed per scope — a single VM, or a user/team/project
envelope that fans out to the scope's VMs. Pick the scope first, then use
the same five operations (`list`, `set`, `unset`, `rotate`, `import`) on it:

```ts
const vm = client.secrets.vm("my-vm");
await vm.set("API_KEY", { value_b64: Buffer.from("hunter2").toString("base64") });
await vm.list(); // names only — values are never returned

const team = client.secrets.team("infra");
const { vm_count } = await team.set("SHARED_TOKEN", { value_b64 }); // fan-out count
await team.rotate("SHARED_TOKEN", { value_b64: fresh });            // acked push
```

All secrets methods return **503 `feature_disabled`** when `[secrets]
enabled = false` on the host.

## Verifying webhook deliveries

Cove signs every lifecycle webhook delivery: HMAC-SHA256 over
`<ce-id>.<ce-time>.<raw body>` with the subscription's `whsec_…` secret,
sent as `Cove-Signature: v1,<hex>`. `verifyWebhookSignature` checks it
(WebCrypto, constant-time compare):

```ts
import { verifyWebhookSignature } from "@runcove/sdk";

// In your receiver — pass the raw body, never re-serialized JSON:
const authentic = await verifyWebhookSignature({
  secret: process.env.COVE_WEBHOOK_SECRET, // or [newSecret, oldSecret] during rotation grace
  headers: request.headers,                 // needs ce-id, ce-time, Cove-Signature
  body: await request.text(),
});
if (!authentic) return new Response("bad signature", { status: 401 });
```

During rotation grace the header carries two space-separated `v1,<hex>`
entries and the verifier accepts either; pass both secrets while your fleet
rolls. It throws `TypeError` on missing headers/secret (misconfiguration
fails loudly) and returns `false` only for a genuine mismatch.

## Fleet administration (`client.admin`)

`client.admin` covers the administrator operations, one method per operation
id. Every one needs a caller in the server's `[auth] admins`, and an API key
must also hold the method's `admin:*` scope (bare `admin` satisfies them all)
and must be an admin key (minted with `cove key create --admin`, short-lived);
an ordinary or pre-upgrade key with the scope gets 403 `admin_required`.
An admin key cannot be minted or rotated over the bearer API at all
(`client.keys.create({ admin_key: true })` with any `cvk_` key, admin key or
not, gets 403): mint it from a signed-in session, today `cove key create --admin` over SSH or
in the REPL, because the web UI has no control for it yet.
An admin key can still mint and rotate ordinary keys.
Either refusal is a 403 `PermissionDeniedError`. Each method's JSDoc names its
scope and notable statuses.
`drainHost`, `updateVmAgents`, `bulkStopVms`, `bulkDeleteVms` and
`deleteAnyCheckpoint` refuse every API key, an admin key included, with 401
`sudo_required` (`AuthenticationError`). The last four need a ticket or a
session; `drainHost` is never served on the Warpgate-fronted listener, so in
practice a drain runs on the host's Unix socket.

Every admin operation is served on the external API listener of every host.

| Area | Methods |
|---|---|
| Fleet | `updateAutoPauseTimeouts`, `drainHost`, `getHostState`, `updateVmAgents`, `bulkStopVms`, `bulkDeleteVms` |
| Projects | `listProjectMembers`, `createProjectMember`, `deleteProjectMember` |
| Quotas | `getQuotaDefaults`, `getUserQuotaOverride`, `updateUserQuotaOverride`, `deleteUserQuotaOverride`, `createQuotaBypass`, `getTeamQuotaOverride`, `updateTeamQuotaOverride`, `deleteTeamQuotaOverride` |
| Users | `listAllUsers`, `getUser`, `revokeUserSessions`, `offboardUser`, `enableUser` |
| Host-wide listings | `listAllVms` / `iterAllVms`, `listAnyCheckpoints` / `iterAnyCheckpoints`, `deleteAnyCheckpoint` |

```ts
// Rehearse a bulk stop of one person's VMs, then run it.
const plan = await client.admin.bulkStopVms({ scope: { type: "user", username: "alice" }, dry_run: true });
console.log(plan.attempted, plan.targets.map((t) => t.vm_name));

// Every orphaned checkpoint on the host, across pages.
for await (const cp of client.admin.iterAnyCheckpoints({ orphaned: true })) {
  console.log(cp.checkpoint_id, cp.owner_username, cp.size_bytes);
}

// Push a new guest agent binary: sent as raw application/octet-stream bytes.
const result = await client.admin.updateVmAgents(new Uint8Array(agentBinary));
if (result.failed > 0) console.warn(result.results);
```

`updateVmAgents` takes a `Blob`, `ArrayBuffer` or `Uint8Array` and sends it
exactly as given. `failed > 0` in a bulk or agent-push answer is a normal
result, not an error.

## Teams, users and sharing

`client.teams` manages teams and their rosters: `list`, `create`, `delete`,
`listMembers`, `createMember`, `deleteMember`. Listing every team needs
`teams:read` and, over an API key, an admin key (`cove key create --admin`) of
an administrator; signed-in sessions are unchanged. Only an administrator sees
a team's `created_by` or a member's `added_by`. A member reads their own team's roster with
`listMembers`. Changing a team or its roster needs an administrator and
`teams:write`.
`client.vms` shares a VM with a user or a team: `listShared` (VMs others
shared with you), `listAccess`, `grantAccess`, `revokeAccess` (`access:read` /
`access:write`, the VM's owner or an administrator). `meta.users()` lists every
username the server knows (`vms:read`, and over an API key an admin key, like
`teams.list`), and `meta.openapi()` returns the server's own
OpenAPI document, parsed.

```ts
const { user_known } = await client.vms.grantAccess("web-1", {
  subject_type: "user",
  subject_id: "bob",
  role: "collaborator",
});
// user_known === false: bob has no account yet; the grant applies at his first sign-in.
await client.vms.revokeAccess("web-1", "user", "bob");
```

Like `client.admin`, every one of these is served on the external API
listener of every host.

## Not covered, and why

The SDK has a method for every operation the bearer (`external`) listener
serves; `tests/coverage.test.mjs` fails when any other is missing, when the SDK calls
an operation that listener does not serve, or when this list drifts from the
contract. These operations are not served on the bearer listener, so the SDK
does not call them:

- `connectManagement` — not served on the bearer listener.
- `createSshKey` — not served on the bearer listener.
- `updateSshKey` — not served on the bearer listener.
- `deleteSshKey` — not served on the bearer listener.
- `revokeMyConnectedApp` — not served on the bearer listener.
- `revokeSession` — not served on the bearer listener.
- `setVmPrimaryPort` — not served on the bearer listener.

## Pagination

Cursor-paginated endpoints (`audit.list`, `webhooks.listDeliveries`,
`vms.eventsLog`, `admin.listAllVms`, `admin.listAnyCheckpoints`) return a page plus a `next_cursor`. Pass it back in to
continue, or use the bundled async-generator helpers that drain every page
transparently:

```ts
for await (const entry of client.audit.iter({ kind: "vm.stopped" })) {
  console.log(entry.at, entry.vm_name);
}

for await (const delivery of client.webhooks.iterDeliveries(webhookId)) {
  console.log(delivery.delivery_id, delivery.state);
}

for await (const event of client.vms.iterEventsLog("my-vm")) {
  console.log(event.ts, event.kind);
}
```

## Scopes

Every method's JSDoc names the bearer-key scope it requires (from the
spec's `x-required-scope`), e.g. `vms:read`, `vms:write`, `vms:exec`,
`files:read`/`files:write` (file transfer), `secrets:read`/`secrets:write`,
`checkpoints:write`, `tags:read`/`tags:write`,
`audit:read`, `keys:manage`, `admin` (webhooks), `teams:read`/`teams:write`
(`client.teams`), `access:read`/`access:write` (VM sharing), or an `admin:*`
scope (`client.admin`, e.g. `admin:vms:read`, `admin:fleet:write`). A key
holding the bare `admin` scope also satisfies any `admin:*` sub-scope. Admin
scopes count only on a key minted with `--admin` (`admin_key: true`).
`meta.health`, `meta.version`, `meta.openapi` are anonymous; `meta.whoami`, `meta.me`,
`meta.meKeys`, `meta.meConnectedApps`, `meta.sessions`, `meta.cliStatus` require
only a valid bearer token (no specific scope).

### What this credential may do: `meta.me()` and `hasScope`

`meta.me()` reports the caller's own `permissions` and `is_admin`.
`permissions` is `{ kind: "key", scopes }` for an API key — the complete list
it was minted with, the only list the bearer gate reads — or
`{ kind: "session" }` for an SSH, web or local session, which has no scope
list. `hasScope(me, scope)` reads it: exact match on a key's list (bare `admin`
also satisfies any `admin:*`), and `true` for a session, which no scope list
restricts. An `admin` or `admin:*` permission also needs the server's admin
check, which `is_admin` reports — an ordinary key that lists `admin` passes
none, since only an admin key does — so for those `hasScope` is `false` unless
`is_admin` is `true`. It does not say whether a particular VM is reachable, and
it throws on a server too old to report `permissions`.

```ts
import { hasScope } from "@runcove/sdk";

const me = await client.meta.me();
if (!hasScope(me, "vms:write")) throw new Error("this key cannot create VMs");
```

`meta.sessions()` lists the caller's own CLI sessions, active and past.
Revoking one is not offered to an API key.

## Notable status codes

- **202** — `vms.create`, `vms.delete` (usually), `webhooks.replayDelivery`: accepted, runs in the background.
- **404-over-403** — most per-resource endpoints collapse "exists but not yours" into the same 404 as "doesn't exist".
- **503 `feature_disabled`** — every `client.secrets` method, when `[secrets] enabled = false`; `client.webhooks` mutations, when `[webhooks] enabled = false`.
- **429 `rate_limited`** — any method, when this source IP is over the bearer listener's per-IP budget (default 30 requests per second): `RateLimitError` with `retryAfterSecs`. Retry after it; the SDK does not.
- **503 `unavailable` "file transfer busy"** — the file-transfer API's per-person cap: one person (a user, across their sessions and personal keys, or a team key's team) may have 4 uploads or downloads, and 8 file stats, in flight on a host; one more is refused at once, with no `Retry-After`. Retry when one of your transfers finishes. It throws `UnavailableError`.
- **426 `CLI_TOO_OLD`** — any method, when the server no longer speaks this SDK's API version: `UpgradeRequiredError` (see "Versions").
- **409 with `DenyReason`** — capacity-check/quota denials on `vms.create`, `vms.start`, `vms.resume`, `vms.resize`, `vms.clone`, `vms.wake`, `host.reserve`.

## Development

```sh
npm run typecheck  # tsc --noEmit
npm run build      # ESM -> dist/, CJS -> dist/cjs/
npm test           # build + node --test (zero-dep, tests the built artifacts)
npm run typecheck:examples  # build, then tsc --noEmit over examples/*.ts (not part of npm test)
```

## Examples

`examples/create-exec-destroy.mjs` walks the full "hello VM" flow —
create, poll until running, streamed + buffered exec, delete:

```sh
npm run build
COVE_URL=http://127.0.0.1:8090 COVE_TOKEN=cvk_... node examples/create-exec-destroy.mjs
node examples/create-exec-destroy.mjs --mock   # offline, in-memory fake server
```

The `--mock` path doubles as a template for stubbing the SDK in your own
tests: pass any `fetch`-shaped function via `new CoveClient({ fetch })`.

Twelve worked use cases sit beside it. Each is the same program as its twin in
the Python SDK's examples (same steps, same order, same output), and the
documentation portal shows each pair side by side under Use cases:

| File | What it does |
|---|---|
| `agent-sandbox.ts` | An agent's sandbox: write code into a VM, run its tests, fix it, run them again |
| `ci-runner.ts` | A CI runner: clone, set up with a setup-only secret (`execWithSecrets`, `setup_tag`), test, stop at the first failure |
| `file-processing.ts` | Send input files into a throwaway VM, process them there, read the result back |
| `event-driven.ts` | Follow a new VM's event stream and provision it the moment it runs |
| `fan-out.ts` | Split a job over three VMs at once, then combine the results |
| `pet-vm.ts` | A long-lived VM that pauses when idle: disk-only checkpoint, roll back a broken change, hibernate, wake |
| `code-execution.ts` | One fresh VM per request: upload a snippet, run it under a deadline, delete the VM |
| `preview.ts` | A VM per pull request, tagged with its number: start the app, publish its port, delete by tag |
| `parallel-tries.ts` | Prepare one VM, checkpoint it, clone a VM per candidate fix, keep the first that passes |
| `repro-box.ts` | A VM with a lifetime cap to reproduce a bug: checkpoint the failure, give a colleague access |
| `coding-agent.ts` | A fresh VM per task for Claude Code: the key as a secret, clone, run the agent, download the diff |
| `spotlight.ts` | Put a git worktree onto a VM, switch it to another, then restore the base (`client.spotlight`) |

They are TypeScript files that Node 22.18 or later runs as they are, and they
share one in-memory fake server for `--mock`. `npm test` runs every one under
`--mock` and checks what it prints; `npm run typecheck:examples` typechecks them.

```sh
npm run build
node examples/ci-runner.ts --mock
COVE_URL=http://127.0.0.1:8090 COVE_TOKEN=cvk_... node examples/ci-runner.ts   # the file's header lists what else it needs
```

The Cove MCP server is built into the `cove` binary: use `cove mcp serve` (local
mode, CLI login or API key) or the hosted `/mcp` endpoint on a Cove server
(API keys or claude.ai sign-in). The Cove docs' "Using Cove as an agent" page describes
the local server.

## License

Licensed under the Apache License, Version 2.0. The full text is in `LICENSE`.
