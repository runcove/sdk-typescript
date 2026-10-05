/**
 * Flue sandbox adapter backed by a Cove VM, via `@runcove/sdk`.
 *
 * Flue (https://github.com/withastro/flue) is a TypeScript agent harness;
 * its agents run shell/file operations through a `SandboxFactory`. This
 * adapter maps that contract onto a Cove microVM — every operation is
 * executed inside the guest through Cove's `exec` API, so the agent gets a
 * real, isolated Linux machine.
 *
 * Follows the shape mandated by Flue's Sandbox Adapter API doc: one file,
 * a factory taking an already-provisioned VM, `createSandbox` wrapping a
 * `SandboxApi` via `createSandboxSessionEnv`. The application owns VM
 * lifecycle (create/delete) — see `provisionCoveVm` below.
 *
 * ```ts
 * import { defineAgent } from "@flue/runtime";
 * import { CoveClient } from "@runcove/sdk";
 * import { cove, provisionCoveVm } from "./flue-sandbox.js";
 *
 * const client = new CoveClient({ baseUrl: process.env.COVE_URL!, ticket: myTicket });
 * const vm = await provisionCoveVm(client); // or reuse an existing VM name
 *
 * export default defineAgent(() => ({
 *   model: "anthropic/claude-sonnet-4-6",
 *   sandbox: cove(client, vm),
 *   instructions: "Fix the failing test in /workspace/repo ...",
 * }));
 * ```
 *
 * Requires `@flue/runtime` as a peer (not a dependency of @runcove/sdk) —
 * this file is an integration example, excluded from the SDK build.
 */

import { createSandboxSessionEnv } from "@flue/runtime";
import type { FileStat, Sandbox, SandboxApi, SandboxFactory } from "@flue/runtime";
import type { CoveClient } from "@runcove/sdk";

/** Single-quote shell escaping so paths/values survive `sh -c`. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

class CoveSandboxApi implements SandboxApi {
  constructor(
    private readonly client: CoveClient,
    private readonly vm: string,
  ) {}

  async exec(command: string, options: ExecOpts = {}) {
    const env = Object.entries(options.env ?? {})
      .map(([k, v]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          throw new Error(`invalid environment variable name: ${JSON.stringify(k)}`);
        }
        return `export ${k}=${q(v)};`;
      })
      .join(" ");
    const cd = options.cwd ? `cd -- ${q(options.cwd)} &&` : "";
    // Flue's per-call deadline is the *guest-side* one (`timeoutSecs`); the
    // cancellation signal is transport, so it rides in the overrides bag.
    const { stdout, stderr, exitCode } = await this.client.vms.execCollect(
      this.vm,
      {
        command: ["sh", "-c", `${env} ${cd} ${command}`],
        timeoutSecs: options.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : undefined,
      },
      { signal: options.signal },
    );
    return { stdout, stderr, exitCode };
  }

  /** Run a command that must succeed; returns stdout. */
  private async sh(command: string): Promise<string> {
    const { stdout, stderr, exitCode } = await this.exec(command);
    if (exitCode !== 0) throw new Error(`[cove:${this.vm}] ${command}: ${stderr.trim()}`);
    return stdout;
  }

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBuffer(path));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    // base64 round-trip: exec streams line-oriented text, raw bytes would mangle.
    const b64 = await this.sh(`base64 -- ${q(path)}`);
    return Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    let b64 = "";
    for (const byte of bytes) b64 += String.fromCharCode(byte);
    await this.sh(`printf %s ${q(btoa(b64))} | base64 -d > ${q(path)}`);
  }

  async stat(path: string): Promise<FileStat> {
    // %F=type %s=size %Y=mtime-epoch (GNU coreutils, present in cove goldens)
    const out = await this.sh(`stat -c '%F|%s|%Y' -- ${q(path)}`);
    const [type = "", size = "0", mtime = "0"] = out.trim().split("|");
    return {
      isFile: type.includes("file"),
      isDirectory: type === "directory",
      isSymbolicLink: type === "symbolic link",
      size: Number(size),
      mtime: new Date(Number(mtime) * 1000),
    };
  }

  async readdir(path: string): Promise<string[]> {
    const out = await this.sh(`ls -1A -- ${q(path)}`);
    return out.split("\n").filter(Boolean);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.exec(`test -e ${q(path)}`)).exitCode === 0;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.sh(`mkdir ${options?.recursive ? "-p " : ""}-- ${q(path)}`);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const flags = `${options?.recursive ? "r" : ""}${options?.force ? "f" : ""}`;
    await this.sh(`rm ${flags ? `-${flags} ` : ""}-- ${q(path)}`);
  }
}

/**
 * Adapter factory: an agent's shell/file surface becomes the Cove VM `vm`.
 * Pure adapter per Flue's contract — never creates or deletes the VM.
 */
export function cove(client: CoveClient, vm: string, workdir = "/workspace"): SandboxFactory {
  return {
    async createSandbox(): Promise<Sandbox> {
      const api = new CoveSandboxApi(client, vm);
      await api.mkdir(workdir, { recursive: true });
      return createSandboxSessionEnv(api, workdir);
    },
  };
}

/**
 * Application-side lifecycle helper: create a VM and wait until it accepts
 * exec. Delete it yourself when the agent run is done (`client.vms.delete`).
 */
export async function provisionCoveVm(
  client: CoveClient,
  opts: { image?: string } = {},
): Promise<string> {
  const { name } = await client.vms.create({ image: opts.image });
  const vm = await client.vms.waitForState(name, ["running", "failed"], { timeoutMs: 300_000 });
  if (vm.state === "failed") throw new Error(`cove VM ${name} failed to start`);
  return name;
}
