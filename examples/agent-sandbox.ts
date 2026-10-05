#!/usr/bin/env node
// An agent's sandbox: write code into a fresh VM, run its tests, read the failure, fix the
// code and run the tests again. The "agent" here is scripted (two fixed versions of one
// file); a real one would ask a model for the next version. Needs python3 in the VM's image.
//
//   COVE_URL=http://127.0.0.1:8090 COVE_TOKEN=cvk_... node examples/agent-sandbox.ts
//   node examples/agent-sandbox.ts --mock     # offline, against an in-memory fake server
//
// Node 22.18 or later runs this file as it is; run `npm run build` first.
import { CoveClient, CoveAPIError } from "@runcove/sdk";

const WORKDIR = "/root/work";

// The agent's two attempts at the code under test, and the test it must pass.
const FIRST_TRY = `def slugify(title):\n    return "-".join(title.split())\n`;
const SECOND_TRY = `def slugify(title):\n    return "-".join(title.lower().split())\n`;
const TEST = `import unittest
from slugify import slugify

class SlugifyTest(unittest.TestCase):
    def test_joins_words(self):
        self.assertEqual(slugify("hello  world"), "hello-world")

    def test_lowercases(self):
        self.assertEqual(slugify("Hello World"), "hello-world")
`;

const mock = process.argv.includes("--mock");
const client = mock
  ? // The in-memory fake server, loaded only for --mock: a copy of this file needs no _mock.ts.
    new CoveClient({ baseUrl: "https://cove.mock", token: "cvk_mock", fetch: (await import("./_mock.ts")).mockFetch() })
  : new CoveClient({ baseUrl: env("COVE_URL"), token: env("COVE_TOKEN"), timeoutMs: 30_000 });

// Create (202: creation goes on in the background), then wait until the VM runs.
const { name } = await client.vms.create({});
console.log(`created ${name}`);
try {
  await client.vms.waitForState(name, ["running"], { timeoutMs: 300_000, intervalMs: mock ? 10 : 1000 });
  console.log(`${name} is running`);

  await writeFile(name, `${WORKDIR}/test_slugify.py`, TEST);
  let passed = false;
  for (const [attempt, code] of [FIRST_TRY, SECOND_TRY].entries()) {
    await writeFile(name, `${WORKDIR}/slugify.py`, code);
    // timeoutSecs is the server's deadline on the command in the guest.
    const run = await client.vms.execCollect(name, {
      command: ["python3", "-m", "unittest", "discover", "-s", WORKDIR],
      timeoutSecs: 120,
    });
    if (run.exitCode === 0) {
      console.log(`attempt ${attempt + 1}: tests passed`);
      passed = true;
      break;
    }
    // unittest reports on stderr; its last line is the verdict the agent reads.
    console.log(`attempt ${attempt + 1}: tests failed (exit ${run.exitCode})`);
    console.log(`  ${run.stderr.trim().split("\n").at(-1) || "(no output)"}`);
  }
  if (!passed) {
    console.error("the tests still fail after the last attempt");
    process.exitCode = 1;
  }
} catch (err) {
  if (!(err instanceof CoveAPIError)) throw err;
  console.error(`API error ${err.status} ${err.code}: ${err.message}`);
  process.exitCode = 1;
} finally {
  // Delete whatever happened above (202: deletion goes on in the background).
  await client.vms.delete(name);
  console.log(`deleted ${name}`);
}

/**
 * Write `content` to `path` in the guest with `vms.files.upload`. The server needs the
 * directory to exist, so make it first. Any size and binary content work: pass a `Uint8Array`
 * or a stream (with `size`) instead of a string.
 */
async function writeFile(vm: string, path: string, content: string): Promise<void> {
  const mkdir = await client.vms.execCollect(vm, { command: ["mkdir", "-p", path.slice(0, path.lastIndexOf("/")) || "/"] });
  if (mkdir.exitCode !== 0) throw new Error(`creating the directory for ${path} failed: ${mkdir.stderr}`);
  await client.vms.files.upload(vm, path, content);
}

function env(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error("set COVE_URL and COVE_TOKEN (a cvk_ API key), or run with --mock");
    process.exit(1);
  }
  return value;
}
