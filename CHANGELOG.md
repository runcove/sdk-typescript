# Changelog

All notable changes to `@runcove/sdk` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions 0.5.0 to 0.5.2 were released inside the Cove server releases `cove-server-v0.34.0`
to `cove-server-v0.34.2`. Later versions are released on their own, under `sdk-ts-v<version>`
tags, and Cove server releases no longer carry the SDK.

## [Unreleased]

### Fixed

- **`vms.clone`'s 409 is typed as `VmCloneConflictResponse`, which includes `VmNameTakenBody`, and `ConflictError.createConflict()` reads a taken clone name the same way as a taken create name.** The server now answers a taken clone name with `vm_name_taken` (it was `invalid_state_transition`), with `retry_after_secs` while the name is in its post-delete cooldown.

### Added

- **`client.admin.enableUser(username)` lets a person an offboarding shut out back in** (`POST /api/admin/users/{username}/enable`). Until then every request of theirs is refused with 403 `user_disabled` (a new `ErrorCode` value), and nothing that would hand them a credential is created. It resolves to the cleared shut-out (`EnableUserResponse`: `disabled_at`, `disabled_by`, `reason`) and, like `offboardUser`, refuses every API key with 401 `sudo_required` (`AuthenticationError`). `AdminUserSummary` gains `disabled_at` and `OffboardUserReport` gains `disabled`.

- **`client.keys.revokeByToken(token)` revokes an API key by presenting it** (`POST /api/api-keys/revoke`): any key you hold, yours or one you found, no scope needed. Resolves alike whether or not the key was live.

- **A clone request can set the clone's idle-pause policy, expiry policy and tags.** `CloneRequest` gains optional `auto_pause_policy`, `ttl_policy` and `tags`; a clone that leaves them out keeps its source's (its expiry clock starts when the clone is created). The clone endpoint's documented errors now include a bad tag (400), more than 50 tags (409, `too_many_tags`) and an out-of-bounds policy (422).
- **`vms.exec` takes `cwd`, `env`, `user` and `login`.** They set the working directory (relative to the account's home), add environment variables that win over the defaults, run the command as another account in the VM, or run it through that account's login shell. Options left unset are left out of the request, so a plain exec is unchanged. A VM whose guest agent is older refuses an exec that sets any of them.

### Changed

- **`vms.addPort` resolves to the port (`ProxyPortInfo`), whether it was new (201) or already published (200: idempotent), and `vms.removePort` / `tags.delete` resolve to `RemovalResponse` `{ existed }`.** Each resolves to `undefined` from a server older than API version 7. `COVE_API_VERSION` is 7.
- **The generated `ListVmsData` query types `tag` as `Array<string>`, as the contract now declares it.** `client.vms.list` / `iter` still take one string or an array (`ListVmsParams`).
- **The set-expiry request (`UpdateTtlPolicyRequest`) takes `expires_in`, an expiry counted from now that keeps the VM's `on_stop`, as an alternative to `policy`, which is now optional.** Send exactly one; the server answers 422 otherwise. A new `ExpiresIn` model carries `secs` (3600 to 315360000, or null to remove the expiry). The operation now documents its 422, and the `TtlPolicy` and create and clone texts give the ten-year ceiling.
- **`admin.revokeUserSessions` can fail with 503 `unavailable`** when the bastion kept one of the person's CLI sessions; those sessions stay valid and calling again retries only them. It used to answer success with them still valid. `keys.revoke`'s docs say an administrator can revoke anyone's key.
- **`ErrorCode` gains `disk_rollback_not_named`**: `vms.wake` with no `checkpoint_id`, on a stopped VM whose latest checkpoint is disk-only, is refused with this 409 and changes nothing, where the server used to roll the disk back. `vms.wake`'s docs, the wake operation's and `WakeRequest.checkpoint_id`'s say so.
- **Every operation the API-key listener serves declares its `429` response.** The per-operation error types gain `429: ApiError` (code `rate_limited`, with a `Retry-After` header in seconds). The client still raises the same rate-limit error as before.

### Docs

- **`VmDetail` documents each size field: the size the VM has now, the size it boots with, and the bounds a resize can move it between.**

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
