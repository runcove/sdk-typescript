# Changelog

All notable changes to `@runcove/sdk` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions 0.5.0 to 0.5.2 were released inside the Cove server releases `cove-server-v0.34.0`
to `cove-server-v0.34.2`. Later versions are released on their own, under `sdk-ts-v<version>`
tags, and Cove server releases no longer carry the SDK.

## [Unreleased]

## [0.6.0] - 2026-11-24

### Fixed

- **`vms.clone`'s 409 is typed as `VmCloneConflictResponse`, which includes `VmNameTakenBody`, and `ConflictError.createConflict()` reads a taken clone name the same way as a taken create name.** The server now answers a taken clone name with `vm_name_taken` (it was `invalid_state_transition`), with `retry_after_secs` while the name is in its post-delete cooldown.
- **`vms.exec` and `vms.execCollect` return output with carriage returns byte for byte.** The SDK asks for each chunk as a JSON string (`?encoding=json`, a query parameter and not a header, so a browser needs no CORS preflight entry) and decodes it when the response carries `x-cove-exec-encoding: json`; CRLF output used to come back with a stray `data: ` in it. Against an older server, which ignores the parameter, the chunks are read raw, as before.
- `vms.wake` documents that waking a stopped VM with a disk-only checkpoint's id is the in-place disk rollback (it said Cove has no rollback), and `CreateVmRequest.ports` names the key `[service.proxy].allowed_ports`.
- `RotateSummary` carries `existed`, set by a secret delete: `false` when nothing was stored under that name in that scope (the wipe is still sent).

### Added

- **`client.admin.enableUser(username)` lets a person an offboarding shut out back in** (`POST /api/admin/users/{username}/enable`). Until then every request of theirs is refused with 403 `user_disabled` (a new `ErrorCode` value), and nothing that would hand them a credential is created. It resolves to the cleared shut-out (`EnableUserResponse`: `disabled_at`, `disabled_by`, `reason`) and, like `offboardUser`, refuses every API key with 401 `sudo_required` (`AuthenticationError`). `AdminUserSummary` gains `disabled_at` and `OffboardUserReport` gains `disabled`.

- **`client.keys.revokeByToken(token)` revokes an API key by presenting it** (`POST /api/api-keys/revoke`): any key you hold, yours or one you found, no scope needed. Resolves alike whether or not the key was live.

- **A clone request can set the clone's idle-pause policy, expiry policy and tags.** `CloneRequest` gains optional `auto_pause_policy`, `ttl_policy` and `tags`; a clone that leaves them out keeps its source's (its expiry clock starts when the clone is created). The clone endpoint's documented errors now include a bad tag (400), more than 50 tags (409, `too_many_tags`) and an out-of-bounds policy (422).
- **`vms.exec` takes `cwd`, `env`, `user` and `login`.** They set the working directory (relative to the account's home), add environment variables that win over the defaults, run the command as another account in the VM, or run it through that account's login shell. Options left unset are left out of the request, so a plain exec is unchanged. A VM whose guest agent is older refuses an exec that sets any of them.
- **`vms.exec` and `vms.execCollect` take `stdin`.** A string is sent as text (`stdin`), a `Uint8Array`, another byte view or an `ArrayBuffer` as base64 (`stdin_b64`; `null` is unset, as on the other optional fields; anything else throws a `TypeError` rather than being dropped), written to the command's stdin, which is then closed. At most 1 MiB. A VM whose guest agent is older refuses it rather than run the command without it.
- **`LocalStatus.guest_ram_wired_mb`**: the whole Mac's wired memory now, in MB, which the guest RAM cap counts against; absent off a Mac.
- **API version 8 (`COVE_API_VERSION`). `vms.exec` and `vms.execCollect` refuse `stdin` against an older server.** With `stdin` set, the SDK first reads the server's version (`GET /api/whoami`). Below `EXEC_STDIN_MIN_API_VERSION` (8, now exported), or when the server does not report a version, it throws a `CoveError` ("this server (API 7) does not support exec stdin; upgrade the server to API 8 or later") and sends nothing, because an older server would run the command without its input. An exec without stdin is unchanged.
- **`VmDetail` gains an optional `permissions` list of strings** (`vm.view`, `vm.power`, `vm.snapshot`, ...), what the caller may do to the VM. It is plain strings, not a closed set: a name a newer server adds reads like any other, so skip names you do not know. Absent from older servers.
- **`checkpoint_not_found` joins the `ErrorCode` list.** Reading or deleting a checkpoint that does not exist answers it, naming the checkpoint.
- **`Checkpoint` gains optional `orphaned_at` and `reclaim_at`:** when the checkpoint's VM was deleted, and when the server will delete the checkpoint on its own.
- **`TrafficMonitorState` gains `'wake_stopped'`:** the server's traffic monitor attached, then its wake path stopped, so no paused VM can wake on traffic until the daemon restarts.
- **`HealthResponse` gains `wake_jump`**: `true` while the server's wake jump is on, so a plain `ssh` to a hibernated VM waits while it wakes; absent otherwise and from older servers.
- **`CloneVmErrors` has a 500 (`ApiError`).** When the new VM's guest agent answers its setup after the restore with a failure on every attempt, the message is `the clone could not finish its setup in the guest: ` followed by the agent's answer, escaped and cut to about 512 characters, with code `internal_error`. Do not retry it: the same source gives a guest that fails the same way. A guest agent that gives no answer in time is still 503.
- **Team admin fields** (API version 9): `ProfileSummary` gains `team_admin_of`, the teams whose keys the caller can manage as the team's admin; `TeamMemberEntry` gains `role` (`"admin"` or `"member"`); `RemoveMemberOutcome` gains `team_keys_minted`, the ids of the team keys the removed person minted, which keep working. An older server sends none of them. The answer to ending the team admin role, `TeamAdminRevokeResponse`, carries `team_keys_minted` too.
- **`create_failed_vm_kept` joins the error codes** (500: a create failed after its VM existed, and the VM was kept under a new name; the message names it).
- **`ProxyUrlInfo` (the answer of `GET /api/vms/{name}/url`) has `web_url`, the address Cove's web app is served on; the VM's page there is `<web_url>/vms/<vm_name>`.** It is absent when the server has no web address configured.
- **`CreateVmResponse` has an optional `warnings` list.** On a Mac it carries the warning that the Mac is short of free memory for the new VM; it is absent when there are none.
- **VM summaries and details carry an optional `activity` field,** set to `"starting"` while a stopped VM's cold start is waiting for its guest agent. `state` is unchanged.
- **The error code `destructive_not_granted`.** The server answers it (403) when a credential granted everything except destructive operations asks for one, such as deleting a VM; no scope would help, only the person who approved the credential.
- **`VmDetail` has an optional `network_policy_needs_restart` field.** It is `true` for a running or paused Mac VM whose stored network policy needs a restart of the VM to take effect (restart it, then set the policy again), and absent otherwise.
- **The generated types carry `updateImage`** (`POST /api/images/update`, a Mac's box update in local mode) and `LocalStatus.image_update` (`ImageUpdate`, `ImageUpdateState`, `TransferProgress`).
- **`ExecExit` has an optional `exact` field.** It is `false` on a base64 exec whose guest agent predates protocol 17, so the output is lossy text rather than the command's exact bytes, and absent when the bytes are exact.
- **`AdminHostStateResponse` carries an optional `agent_hot_patch`.** It says whether the daemon can hot-patch guests with its embedded agent; it is absent from a daemon that predates the field.
- **`vms.resize` accepts `force: true`.** The generated `ResizeRequest` type carries `force`, which shrinks memory even below what the guest is using.
- **`vms.rename(name, { new_name })` renames a VM.** It posts to `POST /api/vms/{name}/rename` and resolves to the VM's detail under its new name; the VM keeps its id, disk and state. A taken `new_name` is a `ConflictError` whose `createConflict()` gives `{ kind: "name_taken", retryAfterSecs }` (`retryAfterSecs` set while the name is in its cooldown), a busy VM is a `ConflictError` with code `invalid_state_transition`, and a VM that is missing or that the caller may not delete is a `NotFoundError`.
- **`vms.recover(name)` returns a `failed` VM to `stopped`** (`POST /api/vms/{name}/recover`, scope `vms:write`), so `vms.start(name)` can boot it again from its disk. A 409 says the VM is not failed, its hypervisor process may still be running, or its disk is missing.
- **`LocalStatus.low_disk_free_bytes`** in the generated types: a Mac's free disk, present only while below 10 GiB.
- **`secrets_restoring` is added to `ErrorCode`.** It is the code of a `409` that says a rebooted VM's secrets are still being put back and the command was not run; run it again.
- **Secret listings type each entry's `exposure`, `lifetime`, `target_unit`, `setup_tag` and `ttl_seconds`.** `SecretEntryDto` gains them as optional fields; values are never returned.
- **`ApiScope` includes `"vms:nested-virt"`**, the permission an API key needs, besides `vms:write`, for its holder to create or clone a VM with nested virtualisation when the server lists them in `[auth] nested_virt_users`. A team key or a service key cannot hold it, and a key gets it only when minted from a signed-in session of a listed person.
- **`HealthResponse` gains `oci_refused`**: set, with the reason, while the server refuses every OCI image reference because it could not build its registry client; absent otherwise and from older servers.
- **`OffboardUserReport` gains `warpgate_admin_roles_error`**: set when offboarding
  kept the person's Warpgate user and they hold a Warpgate admin role (naming it), or
  their admin roles could not be listed. A failed item: a Warpgate admin must remove
  the admin role.
- **`OffboardUserReport` gains the optional `left_behind`** (`OffboardLeftBehind`, `OffboardMintedKey`, `OffboardPortInvite`, `OffboardServiceVm`, `OffboardServiceWebhook`): what offboarding leaves in place for an administrator to handle.
- **`OffboardUserReport` gains `tickets_left_on_other_instances`**: how many Warpgate
  tickets in the person's name offboarding left on targets another Cove instance
  owns. A count, not a failed item.
- **`origin_not_trusted` joins the error codes** (403: a browser request from an origin not in the server's `[api] trusted_origins`, when that server enforces the list).
- **`client_address_denied` joins the error codes, and `getHostState` returns `request_refusals`** (the external listener's refusals per route group and reason; optional, absent from older daemons).
- **`AdminQuotaDefaultsResponse.derived_from_mac` and `LocalStatus.guest_ram_cap_mb`, both optional.** `derived_from_mac` is `true` when a Mac's host quota defaults are its own figures, `false` when they are not (a `[quota]` block overrides them, or the figures could not be read), and absent off a Mac or from an older server. `guest_ram_cap_mb` is the cap on the guest RAM a Mac's running VMs may hold, absent when the Mac's RAM could not be read.
- **`RamCapacity.committed_mb`**: the memory a cove instance has committed to the VMs that hold guest RAM plus the reservations no such VM accounts for, to compare with `headroom_mb`. Optional: absent from a server that predates it. It covers one instance only: two instances on one host each budget the whole host. `reservation_mb` is documented as the in-flight reservations only.
- **`admin.restoreVms` starts the VMs a host drain stopped.** It posts the VM ids (and optionally how many to start at once) to `POST /api/admin/restore-vms` and returns a result per VM. The route is for the host's Unix socket; every API key is refused with 401 `sudo_required`. `admin.drainHost`'s answer now carries `attempted_vms` and `hibernated`.
- **`ResizeResult` has an optional `warnings` list.** On a Mac it carries the warning that a memory grow leaves the Mac short of free memory; it is absent when there are none.
- **The generated types carry the rename route.** The request and response types for `POST /api/vms/{name}/rename` are generated from the contract.
- **`vms.resize` accepts `restart: true` and returns `restart`.** The generated `ResizeRequest`
  and `ResizeResult` types carry the field, and `ResizeRestart` is new.

### Changed

- **`vms.addPort` resolves to the port (`ProxyPortInfo`), whether it was new (201) or already published (200: idempotent), and `vms.removePort` / `tags.delete` resolve to `RemovalResponse` `{ existed }`.** Each resolves to `undefined` from a server older than API version 7. `COVE_API_VERSION` is 7.
- **The generated `ListVmsData` query types `tag` as `Array<string>`, as the contract now declares it.** `client.vms.list` / `iter` still take one string or an array (`ListVmsParams`).
- **The set-expiry request (`UpdateTtlPolicyRequest`) takes `expires_in`, an expiry counted from now that keeps the VM's `on_stop`, as an alternative to `policy`, which is now optional.** Send exactly one; the server answers 422 otherwise. A new `ExpiresIn` model carries `secs` (3600 to 315360000, or null to remove the expiry). The operation now documents its 422, and the `TtlPolicy` and create and clone texts give the ten-year ceiling.
- **`admin.revokeUserSessions` can fail with 503 `unavailable`** when the bastion kept one of the person's CLI sessions; those sessions stay valid and calling again retries only them. It used to answer success with them still valid. `keys.revoke`'s docs say an administrator can revoke anyone's key.
- **`ErrorCode` gains `disk_rollback_not_named`**: `vms.wake` with no `checkpoint_id`, on a stopped VM whose latest checkpoint is disk-only, is refused with this 409 and changes nothing, where the server used to roll the disk back. `vms.wake`'s docs, the wake operation's and `WakeRequest.checkpoint_id`'s say so.
- **Every operation the API-key listener serves declares its `429` response.** The per-operation error types gain `429: ApiError` (code `rate_limited`, with a `Retry-After` header in seconds). The client still raises the same rate-limit error as before.
- **The 401 of the user-, team- and project-scoped secret set, import and rotate operations is typed `SensitiveOpUnauthorizedResponse`**, which adds the `sudo_required` body: those writes now need a fresh login on the daemon socket and the bastion-fronted listener. API-key callers never receive it.
- **`renameVm`'s 401 can be the sudo challenge.** Renaming a VM needs a recent sign-in, as deleting one does, so its 401 is typed `SensitiveOpUnauthorizedResponse`, as `deleteVm`'s is.
- **`vms.grantAccess` to a user who has never signed in to the server rejects with a `CoveAPIError` of status 422 and code `user_never_signed_in`**, which `ERROR_CODES` and the `ErrorCode` type now include. `user_known: false` now means a known user has no access-gateway account right now.
- **`wakeVm`'s 409 can be a `DenyReason`.** The generated types now allow the admission denial a wake gets when the host has no room for the VM's memory, beside the existing `ApiError`.
- **`vms.get` and `vms.waitForState` throw a create's own failure, not `NotFoundError`, after it fails.** For 5 minutes after your create of a name was accepted and then failed, `GET /api/vms/{name}` answers the failure's own status in place of the 404, marked `x-cove-create-failed: 1`: a refusal by admission or a quota throws `ConflictError` (409), a host with no room or a create that failed throws `ServerError` (503 or 500), and a name refused after the 202 throws `CoveAPIError` (400 `invalid_vm_name`). `GetVmErrors` and `StreamVmEventsErrors` gain the 400, 409, 500 and 503 bodies; the 409 is a `DenyReason` or the `ApiError` envelope. Code that caught `NotFoundError` to detect a failed create must catch these too; after the 5 minutes, or once a new create of the name is accepted, the name answers 404 again.
- **The generated types know the profile routes' 409.** `GET /api/me/keys`, `POST /api/me/keys`, `PATCH`/`DELETE /api/me/keys/{id}` and `DELETE /api/me/sessions/{id}` declare a 409 with a plain-text reason when the server has no bastion (local mode without Warpgate, or its embedded Warpgate turned off or not answering). `GET /api/me`'s description says it answers 200 there, with no gateway half and the quotas.
- **A 409 from `createVm` can also be an `ApiError`, with `too_many_tags`, when `initial_tags` has too many entries.** The `initial_tags` and clone `tags` descriptions also give the server's rules, including that a non-empty set needs the `tags:write` permission (403 `scope_denied` without it).

### Docs

- **`VmDetail` documents each size field: the size the VM has now, the size it boots with, and the bounds a resize can move it between.**
- **`HostTelemetryPoint` and `RamCapacity` document their fields**, following the server's contract: where each memory figure comes from on Linux and on a Mac, what the VM-count and reservation fields count, and that `RamCapacity.mem_available_mb` (like the swap and PSI fields) reads 0 on a Mac.
- **`vms.resize` and the `ResizeResult` type document what `partial: true` means**, following the server's contract: a memory shrink the guest could not give back, or, with `restart`, a grow after the restart's start that failed (`restart: "restarted"`); send the resize again without `restart` to retry the grow. The `resizeVm` 200 response says the same.
- **`client.spotlight` docs no longer say the CLI keeps a separate binding:** `cove spotlight` now reads and writes the same `spotlight.*` VM tags, so a binding made by the CLI or the SDK is seen by the other.
- **The README names the server's browser address `<cove-web-host>`, the placeholder the documentation portal on a Cove server fills in.** The SDK download URLs and the Warpgate-fronted listener use it; the `ssh -L` example names the machine `<server-host>`.
- **`vms.resize` says retrying a failed grow with a resize without `restart` is off a Mac.** A Mac
  starts the VM at its new vCPU count and memory, so nothing grows after the start there.
- **`vms.delete` documents the admin 204.** `DELETE /api/vms/pool-…` by an administrator drains an unclaimed warm-pool standby and answers 204, next to the 204 for a purged failed row; anyone else still gets not found.
- **The `connectVm` 409 says it also covers a hibernated VM whose wake failed**, with a message that says why and names `cove wake`, following the server's contract.
- The VM name rule in the README and the generated `CreateVmRequest`, `CloneRequest` and `InvalidVmNameBody` type docs now say a new VM's name may not start with `pool-`, which the server reserves for VMs Cove keeps ready in advance and refuses as `invalid_vm_name`.
- **The `TicketAuth` docs and the create-exec-destroy example read the `cove login` ticket from the current context**, `contexts/<name>/ticket` under the CLI's config directory (`<name>` being the line in `current-context` there), where the CLI now keeps it.
- The `CheckpointState` type's comment now says the administrator's checkpoint listing returns checkpoints in every state, and `orphaned_checkpoint_count` on the host-state response counts orphaned checkpoints in any state.
- The VM name rule in the README and the create and clone request models now say a new VM's name may not be exactly `warpgate`, Warpgate's admin host, which the server refuses as `invalid_vm_name`.
- **`AdminBulkVmTarget.result` documents `already_being_deleted`**: a bulk delete leaves alone a VM another delete already owns, lists it with that result and does not count it in `attempted`, following the server's contract.

## [0.5.2] - 2026-10-06

### Security

- **The development dependency `@modelcontextprotocol/client` moves from 2.0.0 to 2.2.0, for GHSA-6qxp-vccf-f47h.** It is not a runtime dependency of the package, so what an install pulls in does not change.

## [0.5.1] - 2026-10-06

### Added

- **`@runcove/sdk` is published on npm: `npm install @runcove/sdk`.** Each version on npm is the tarball of the signed Cove release, uploaded unchanged after its checksum and signature are verified, and npm records its provenance.

### Docs

- **The README leads with `npm install @runcove/sdk`.** Installing from your Cove server's `/public/sdk/` stays documented as the second path, for the SDK that exact server shipped with. While the SDK is 0.x, pin an exact version.
- **The API descriptions and the SDK's own sources no longer cite internal planning notes.** Each now gives the reason in words, or links the published external API page. Nothing about the API's behaviour or shape changes.

## [0.5.0] - 2026-10-05

### Added

- **First release**, inside the `cove-server-v0.34.0` release assets as `cove-sdk-typescript.tgz`.
