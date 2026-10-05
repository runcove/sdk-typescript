#!/usr/bin/env node
// A CI runner: one fresh VM per run. Clone the repository, install with a registry token
// the VM holds only during setup, run the tests, and report the first step that fails.
// The VM is tagged with the run's id, so `cove ls` shows which run it belongs to.
//
//   COVE_URL=http://127.0.0.1:8090 COVE_TOKEN=cvk_... \
//     CI_REPO_URL=https://example.com/your/repo.git REGISTRY_TOKEN=... CI_RUN_ID=42 \
//     node examples/ci-runner.ts
//   node examples/ci-runner.ts --mock     # offline, against an in-memory fake server
//
// Needs git and make in the VM's image, and secrets turned on for the host (a host with
// them off answers 503 `feature_disabled`). Node 22.18 or later runs this file as it is;
// run `npm run build` first.
import { CoveClient, CoveAPIError } from "@runcove/sdk";

const mock = process.argv.includes("--mock");
const client = mock
  ? // The in-memory fake server, loaded only for --mock: a copy of this file needs no _mock.ts.
    new CoveClient({ baseUrl: "https://cove.mock", token: "cvk_mock", fetch: (await import("./_mock.ts")).mockFetch() })
  : new CoveClient({ baseUrl: env("COVE_URL"), token: env("COVE_TOKEN"), timeoutMs: 30_000 });
const repoUrl = mock ? "https://example.com/demo.git" : env("CI_REPO_URL");
const registryToken = mock ? "mock-registry-token" : env("REGISTRY_TOKEN");
const runId = process.env.CI_RUN_ID ?? "local";

// The pipeline. `setup` runs with the secrets tagged "setup", which the VM wipes as soon as
// the step ends; the other steps never see them. Replace the commands with your project's.
const PIPELINE = [
  { name: "checkout", command: ["git", "clone", "--depth", "1", repoUrl, "/root/src"] },
  {
    name: "setup",
    secretsTag: "setup",
    // The guest agent keeps secrets in a directory under /run/cove/secrets whose random name
    // it picks when it starts (a new one after every boot, wake or clone), so look the file up
    // by name rather than guess its path.
    command: ["sh", "-c", `f=$(find /run/cove/secrets -name REGISTRY_TOKEN -type f | head -n 1) && test -r "$f" && echo registry token available to setup`],
  },
  { name: "test", command: ["make", "-C", "/root/src", "test"] },
];

const { name } = await client.vms.create({ initial_tags: { ci_run: runId } });
console.log(`created ${name} for run ${runId}`);
let failed: string | undefined;
try {
  await client.vms.waitForState(name, ["running"], { timeoutMs: 300_000, intervalMs: mock ? 10 : 1000 });

  // Stored on the VM, but delivered only to a command run with its tag (below).
  await client.secrets.vm(name).set("REGISTRY_TOKEN", {
    value_b64: Buffer.from(registryToken).toString("base64"),
    lifetime: "setup_only",
    setup_tag: "setup",
  });

  for (const step of PIPELINE) {
    let exitCode: number;
    if (step.secretsTag) {
      // Buffered: the server runs the command with the tagged secrets, then wipes them. The
      // whole step is one HTTP request, so the client's 30 s default would cut a long install
      // short: give this call its own 30-minute deadline.
      const out = await client.vms.execWithSecrets(
        name,
        { command: step.command, selector: { kind: "setup_tag", tag: step.secretsTag } },
        { timeoutMs: 1_800_000 },
      );
      process.stdout.write(out.stdout);
      process.stderr.write(out.stderr);
      exitCode = out.exit_code;
    } else {
      // Streamed: output chunks arrive raw, newlines included, so write them as they are.
      exitCode = -1;
      for await (const evt of client.vms.exec(name, { command: step.command, timeoutSecs: 1800 })) {
        if (evt.kind === "stdout") process.stdout.write(evt.data);
        else if (evt.kind === "stderr") process.stderr.write(evt.data);
        else if (evt.kind === "exit") exitCode = evt.code;
        else console.error(`step ${step.name} did not finish: ${evt.kind}`);
      }
    }
    if (exitCode !== 0) {
      console.log(`step ${step.name}: failed (exit ${exitCode})`);
      failed = step.name;
      break;
    }
    console.log(`step ${step.name}: ok`);
  }
} catch (err) {
  if (!(err instanceof CoveAPIError)) throw err;
  console.error(`API error ${err.status} ${err.code}: ${err.message}`);
  failed = "the runner";
} finally {
  await client.vms.delete(name);
  console.log(failed ? `ci: failed at ${failed}` : "ci: passed");
  console.log(`deleted ${name}`);
}
if (failed) process.exitCode = 1;

function env(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`set ${key} (see the top of this file), or run with --mock`);
    process.exit(1);
  }
  return value;
}
