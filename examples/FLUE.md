# Using @runcove/sdk as a Flue sandbox — agent guide

[Flue](https://github.com/withastro/flue) agents run shell and file
operations through a `SandboxFactory`. `flue-sandbox.ts` (this directory)
adapts that contract onto a Cove microVM via `@runcove/sdk`, so a Flue agent
gets a real, isolated Linux machine. This file is for an LLM wiring the two
together. Read `../AGENTS.md` first — everything there (auth, exec chunk
semantics, 202 polling) applies here too.

## Wiring

- Adapter: `flue-sandbox.ts :: cove(client, vmName, workdir?)` returns the
  `SandboxFactory` for `defineAgent({ sandbox: ... })`. Usage example is in
  the file's header comment.
- Provisioning: `flue-sandbox.ts :: provisionCoveVm(client)` creates a VM
  and waits for `running`. The application owns the VM's lifecycle — Flue's
  adapter contract forbids the adapter creating or destroying provider
  resources. Delete with `client.vms.delete(name)` when the run ends.
- `@flue/runtime` is a **peer**, not a dependency of `@runcove/sdk`
  (Node >= 22.19 per its engines field).

## Rules — each one is a live-verified constraint

- **Do not create a VM per exec.** One VM per harness; `createSessionEnv`
  may be called repeatedly for the same id and must reuse the VM.
- **Do not apply the agent definition's `cwd`.** Flue resolves it against the
  adapter's base cwd (`/workspace` by default). The adapter `mkdir -p`s the
  workdir because fresh Cove VMs don't have `/workspace`.
- **File ops travel as base64 over exec.** Cove's external API has no file
  endpoints — `readFile`/`writeFile` shell out to `base64` inside the guest.
  Verified for UTF-8, binary bytes, and quoted/spaced paths. Don't invent a
  file API; don't drop the base64 round-trip (raw bytes mangle in
  line-oriented exec output).
- **`exec` honors `cwd`/`env`/`timeoutMs`** by wrapping in `sh -c` with
  shell-quoted exports; `timeoutMs` maps to Cove's `timeout_secs`
  (rounded up).
- **Compile with `tsc`; Node's type-stripping cannot run the adapter**
  (it uses constructor parameter properties, non-erasable syntax).
- **Headless auth**: a Warpgate ticket hits the ~15 min step-up window on
  sensitive ops — a long agent run's final `delete` then fails
  `sudo_required`. Prefer a `cvk_` bearer key against a host with
  `[api] bind` enabled; a ticket is only reliable for short runs.

## Verification status

Against `@flue/runtime` 1.0.0-beta.9 and a live Cove host:

- Adapter typechecks unmodified against the published Flue types.
- `createSandboxSessionEnv` e2e: Flue's `SessionEnv` (`exec`, `readFile`,
  `writeFile`, `stat`, `readdir`, `exists`, `mkdir`, `rm`, `cwd`,
  `resolvePath`) drives a real VM; relative paths resolve against
  `/workspace`; exec exit codes and chunk output round-trip exactly.
- Full `defineAgent` model runs are not exercised here — they sit above
  `SessionEnv` and need a model API key; the Cove-facing surface below them
  is covered.

To re-verify after changes: typecheck the adapter against `@flue/runtime`
in a scratch project, then run the `SessionEnv` operations against a live
VM and delete it (`examples/create-exec-destroy.mjs` covers the plain-SDK
path; the adapter adds the base64 file transport on top).
