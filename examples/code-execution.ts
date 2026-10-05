#!/usr/bin/env node
// Running untrusted code per request: every request gets a fresh VM that runs one snippet
// and is deleted straight after, so nothing one request does can reach the next. The
// handler uploads the snippet, runs it under a deadline, and answers with its exit code and
// output. Three requests: one succeeds, one fails, one runs past its deadline.
//
//   COVE_URL=http://127.0.0.1:8090 COVE_TOKEN=cvk_... node examples/code-execution.ts
//   node examples/code-execution.ts --mock     # offline, against an in-memory fake server
//
// The snippets are shell scripts; one in Python or JavaScript runs the same way with its
// interpreter in the VM's image. Node 22.18 or later runs this file as it is; run
// `npm run build` first.
import { CoveClient, CoveAPIError } from "@runcove/sdk";

type Answer = { exitCode: number; timedOut: boolean; output: string };

const SNIPPET = "/root/job/snippet.sh";
// The deadline on each snippet, in seconds.
const DEADLINE_SECS = 5;

const mock = process.argv.includes("--mock");
const client = mock
  ? // The in-memory fake server, loaded only for --mock: a copy of this file needs no _mock.ts.
    new CoveClient({ baseUrl: "https://cove.mock", token: "cvk_mock", fetch: (await import("./_mock.ts")).mockFetch() })
  : new CoveClient({ baseUrl: env("COVE_URL"), token: env("COVE_TOKEN"), timeoutMs: 30_000 });

const REQUESTS = [
  "echo hello from a fresh VM\n",
  "echo checking the input\nexit 3\n",
  "echo starting a long job\nsleep 600\n",
];
let failed = false;
for (const [i, code] of REQUESTS.entries()) {
  try {
    const answer = await handle(code);
    const status = answer.timedOut ? `killed at its ${DEADLINE_SECS} s deadline` : `exit ${answer.exitCode}`;
    console.log(`request ${i + 1}: ${status}: ${answer.output}`);
  } catch (err) {
    if (!(err instanceof CoveAPIError)) throw err;
    console.error(`request ${i + 1}: API error ${err.status} ${err.code}: ${err.message}`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;

/** Run one snippet in a VM of its own, and delete the VM whatever happens. */
async function handle(code: string): Promise<Answer> {
  // The VM deletes itself when it stops, and in any case an hour after it was created: a
  // backstop if this process dies before its `finally`.
  const { name } = await client.vms.create({
    ttl_policy: { max_lifetime_secs: 3600, on_stop: { type: "immediate" } },
  });
  console.log(`created ${name}`);
  try {
    await client.vms.waitForState(name, ["running"], { timeoutMs: 300_000, intervalMs: mock ? 10 : 1000 });
    const mkdir = await client.vms.execCollect(name, { command: ["mkdir", "-p", "/root/job"] });
    if (mkdir.exitCode !== 0) throw new Error(`creating /root/job failed: ${mkdir.stderr}`);
    await client.vms.files.upload(name, SNIPPET, code);
    // At the deadline the guest agent kills the command and everything that stayed in its
    // process group, and the call returns exit 124 with `timedOut` set and the output written
    // before then.
    const run = await client.vms.execCollect(name, { command: ["sh", SNIPPET], timeoutSecs: DEADLINE_SECS });
    return { exitCode: run.exitCode, timedOut: run.timedOut, output: (run.stdout + run.stderr).trim() };
  } finally {
    await client.vms.delete(name);
    console.log(`deleted ${name}`);
  }
}

function env(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error("set COVE_URL and COVE_TOKEN (a cvk_ API key), or run with --mock");
    process.exit(1);
  }
  return value;
}
