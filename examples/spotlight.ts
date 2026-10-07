#!/usr/bin/env node
// Spotlight from a script: put a local git worktree onto a long-lived VM at a path, switch the
// VM to another worktree, then turn it off to put the base tree back, all over the HTTP API
// (a file upload plus one exec per switch). Nothing on the VM restarts, and what the VM installed
// itself (node_modules/ here) survives every switch. The binding lives in the VM's tags, so
// `cove tag ls <vm>` shows it and `off` works from another process.
//
// The repository is a throwaway one made here, with two branches checked out as two worktrees:
// your own would be a checkout and a `git worktree add` beside it. Needs `git` on PATH.
//
//   COVE_URL=http://127.0.0.1:8090 COVE_TOKEN=cvk_... node examples/spotlight.ts
//   node examples/spotlight.ts --mock     # offline, against an in-memory fake server
//
// Node 22.18 or later runs this file as it is; run `npm run build` first.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoveClient, CoveAPIError } from "@runcove/sdk";

const DEST = "/srv/app";

const mock = process.argv.includes("--mock");
const client = mock
  ? // The in-memory fake server, loaded only for --mock: a copy of this file needs no _mock.ts.
    new CoveClient({ baseUrl: "https://cove.mock", token: "cvk_mock", fetch: (await import("./_mock.ts")).mockFetch() })
  : new CoveClient({ baseUrl: env("COVE_URL"), token: env("COVE_TOKEN"), timeoutMs: 120_000 });

// worktree A is the repository's own checkout of `main`; worktree B is branch `feature`.
const work = mkdtempSync(join(tmpdir(), "cove-spotlight-"));
const worktreeA = join(work, "app");
const worktreeB = join(work, "app-feature");
makeRepo();

const { name } = await client.vms.create({});
console.log(`created ${name}`);
try {
  await client.vms.waitForState(name, ["running"], { timeoutMs: 300_000, intervalMs: mock ? 10 : 1000 });
  console.log(`${name} is running`);

  const on = await client.spotlight.on(name, { tree: worktreeA, dest: DEST });
  console.log(`spotlight on: main -> ${name}:${on.dest} (${on.files} files)`);
  console.log(`app.txt: ${await guest(["cat", `${DEST}/app.txt`])}`);

  // What the VM builds for itself, here a stand-in for `npm install`. The default protect list
  // (node_modules/, target/, volumes/, .venv/, .env) keeps it through every switch.
  await guest(["mkdir", "-p", `${DEST}/node_modules`]);
  await client.vms.files.upload(name, `${DEST}/node_modules/marker`, "installed\n");

  await client.spotlight.on(name, { tree: worktreeB, dest: DEST });
  console.log("switched to feature");
  console.log(`app.txt: ${await guest(["cat", `${DEST}/app.txt`])}`);
  console.log(`node_modules/marker: ${await guest(["cat", `${DEST}/node_modules/marker`])}`);

  const status = await client.spotlight.status(name);
  console.log(`status: ${status?.source} on ${status?.dest}`);

  const off = await client.spotlight.off(name, { tree: worktreeA });
  console.log(`spotlight off: base tree restored on ${off?.dest}`);
  console.log(`app.txt after off: ${await guest(["cat", `${DEST}/app.txt`])}`);
  console.log(`status: ${(await client.spotlight.status(name)) ?? "nothing bound"}`);
} catch (err) {
  if (!(err instanceof CoveAPIError)) throw err;
  console.error(`API error ${err.status} ${err.code}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.vms.delete(name);
  console.log(`deleted ${name}`);
  rmSync(work, { recursive: true, force: true });
}

/** Run `command` in the VM and return its output, trimmed; throw if it fails. */
async function guest(command: string[]): Promise<string> {
  const run = await client.vms.execCollect(name, { command });
  if (run.exitCode !== 0) throw new Error(`${command.join(" ")} failed (exit ${run.exitCode}): ${run.stderr}`);
  return run.stdout.trim();
}

/** A repository whose `main` and `feature` branches differ in app.txt, one worktree each. */
function makeRepo(): void {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=example", "-c", "user.email=example@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "main", worktreeA]);
  writeFileSync(join(worktreeA, ".gitignore"), "node_modules/\n");
  writeFileSync(join(worktreeA, "app.txt"), "version: base\n");
  git(worktreeA, "add", "-A");
  git(worktreeA, "commit", "-q", "-m", "base");
  git(worktreeA, "worktree", "add", "-q", "-b", "feature", worktreeB);
  writeFileSync(join(worktreeB, "app.txt"), "version: feature\n");
  git(worktreeB, "commit", "-q", "-am", "feature");
}

function env(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error("set COVE_URL and COVE_TOKEN (a cvk_ API key), or run with --mock");
    process.exit(1);
  }
  return value;
}
