#!/usr/bin/env node
// A coding agent per task: every task gets a fresh VM, where Claude Code clones the repository,
// makes the change unattended, and hands back a diff. The VM is deleted when the task ends,
// whatever happened. Two tasks: one the agent carries out, one it finds nothing to change for.
//
//   COVE_URL=http://127.0.0.1:8090 COVE_TOKEN=cvk_... \
//     AGENT_REPO_URL=https://example.com/your/repo.git ANTHROPIC_API_KEY=... \
//     node examples/coding-agent.ts
//   node examples/coding-agent.ts --mock     # offline, against an in-memory fake server
//
// Needs git, bash and the `claude` CLI in the VM's image (Cove's -loaded images have them), and
// secrets turned on for the host (a host with them off answers 503 `feature_disabled`). Node
// 22.18 or later runs this file as it is; run `npm run build` first.
import { CoveClient, CoveAPIError, CoveError } from "@runcove/sdk";

type Task = { id: string; prompt: string };
type Outcome = { diff: string | null; failure?: string };

const REPO = "/root/work";
const DIFF = "/root/task.diff";
// The deadline asked for one agent run, in seconds. Today the host ends every streamed exec after
// 300 seconds whatever is asked for here, so a run that needs longer comes back as "did not
// finish" (see below).
const AGENT_DEADLINE_SECS = 1800;

const mock = process.argv.includes("--mock");
const client = mock
  ? // The in-memory fake server, loaded only for --mock: a copy of this file needs no _mock.ts.
    new CoveClient({ baseUrl: "https://cove.mock", token: "cvk_mock", fetch: (await import("./_mock.ts")).mockFetch() })
  : new CoveClient({ baseUrl: env("COVE_URL"), token: env("COVE_TOKEN"), timeoutMs: 30_000 });
const repoUrl = mock ? "https://example.com/demo.git" : env("AGENT_REPO_URL");
const apiKey = mock ? "sk-ant-mock-not-a-real-key" : env("ANTHROPIC_API_KEY");

const TASKS: Task[] = [
  { id: "lowercase-slugs", prompt: "Make slugify() lowercase the title, and add a unit test for it." },
  { id: "contributing-typo", prompt: "Fix the typo in CONTRIBUTING.md." },
];
let failed = false;
for (const task of TASKS) {
  try {
    report(task, await runTask(task));
  } catch (err) {
    if (!(err instanceof CoveAPIError)) throw err;
    console.error(`task ${task.id}: API error ${err.status} ${err.code}: ${err.message}`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;

/** Run one task in a VM of its own, and delete the VM whatever happens. */
async function runTask(task: Task): Promise<Outcome> {
  // The tag names the task, so `cove ls --tag task=<id>` finds its VM. The VM deletes itself
  // when it stops, and in any case two hours after it was created: a backstop if this process
  // dies before its `finally`.
  const { name } = await client.vms.create({
    initial_tags: { task: task.id },
    ttl_policy: { max_lifetime_secs: 7200, on_stop: { type: "immediate" } },
  });
  console.log(`created ${name} for task ${task.id}`);
  try {
    await client.vms.waitForState(name, ["running"], { timeoutMs: 300_000, intervalMs: mock ? 10 : 1000 });

    // The key goes in as a secret, never on a command line: an environment variable that the
    // guest exports in its login shells, kept in memory and deleted with the VM. `rotate` puts
    // it into the running VM now; `set` would wait for the VM's next start.
    const delivery = await client.secrets.vm(name).rotate("ANTHROPIC_API_KEY", {
      value_b64: Buffer.from(apiKey).toString("base64"),
      exposure: "env",
      target_unit: "@login",
    });
    // The summary says how many VMs the key reached. Without it the agent would run keyless.
    if (delivery.vm_count !== 1) return { diff: null, failure: "the API key was not delivered to the VM" };

    const clone = await client.vms.execCollect(name, {
      command: ["git", "clone", "--depth", "1", repoUrl, REPO],
      timeoutSecs: 300,
    });
    if (clone.exitCode !== 0) return { diff: null, failure: `git clone failed: ${clone.stderr.trim()}` };

    // `bash -l` is a login shell, so the key is in the agent's environment. acceptEdits lets it
    // edit files without asking; the task text is an argument, not part of the script.
    let run;
    try {
      run = await client.vms.execCollect(name, {
        command: ["bash", "-lc", 'cd "$1" && claude -p "$2" --permission-mode acceptEdits', "agent", REPO, task.prompt],
        timeoutSecs: AGENT_DEADLINE_SECS,
      });
    } catch (err) {
      // The host ends the stream after 300 seconds, whatever the deadline, and the call then
      // fails. The agent may still be running in the VM: the diff is not taken, and the VM is
      // deleted below.
      if (err instanceof CoveAPIError || !(err instanceof CoveError)) throw err;
      return { diff: null, failure: `the agent did not finish: ${err.message}` };
    }
    console.log(`agent: ${(run.stdout + run.stderr).trim()}`);
    if (run.exitCode !== 0) return { diff: null, failure: `the agent failed (exit ${run.exitCode})` };

    // Stage everything, so files the agent created count too, and write the diff to a file.
    for (const command of [
      ["git", "-C", REPO, "add", "-A"],
      ["git", "-C", REPO, "diff", "--cached", `--output=${DIFF}`],
    ]) {
      const step = await client.vms.execCollect(name, { command });
      if (step.exitCode !== 0) return { diff: null, failure: `${command.slice(3).join(" ")} failed: ${step.stderr.trim()}` };
    }
    const diff = new TextDecoder().decode(await client.vms.files.downloadBytes(name, DIFF));
    return { diff };
  } finally {
    await client.vms.delete(name);
    console.log(`deleted ${name}`);
  }
}

/** A short summary: the files the diff changes, and its first changed lines. */
function report(task: Task, outcome: Outcome): void {
  if (outcome.failure) {
    console.log(`task ${task.id}: ${outcome.failure}`);
    return;
  }
  const diff = outcome.diff ?? "";
  const files = [...diff.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)].map((m) => m[1]);
  if (files.length === 0) {
    console.log(`task ${task.id}: no changes`);
    return;
  }
  console.log(`task ${task.id}: ${files.length} file${files.length === 1 ? "" : "s"} changed: ${files.join(", ")}`);
  const changed = diff.split("\n").filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l));
  for (const line of changed.slice(0, 4)) console.log(`  ${line}`);
}

function env(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`set ${key} (see the top of this file), or run with --mock`);
    process.exit(1);
  }
  return value;
}
