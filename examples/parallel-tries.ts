#!/usr/bin/env node
// Trying several fixes from one prepared VM: set up a VM once (check out the code, build
// it), checkpoint it, and clone one VM per candidate fix from that checkpoint, so every try
// starts from the same prepared state without repeating the setup. Each clone applies its
// fix and runs the tests; the first fix that passes is kept and the other clones deleted.
// The candidates here are three fixed versions of one function; an agent would write them.
//
//   COVE_URL=http://127.0.0.1:8090 COVE_TOKEN=cvk_... \
//     TRIES_REPO_URL=https://example.com/your/repo.git node examples/parallel-tries.ts
//   node examples/parallel-tries.ts --mock     # offline, against an in-memory fake server
//
// Needs git, make and python3 in the VM's image. Each clone counts against your quota. Node
// 22.18 or later runs this file as it is; run `npm run build` first.
import { CoveClient, CoveAPIError } from "@runcove/sdk";

const SRC = "/root/src";
// The candidate fixes for slugify.py, which the tests in the repository check.
const FIXES = [
  `def slugify(title):\n    return "-".join(title.split(" "))\n`,
  `def slugify(title):\n    return "-".join(title.lower().split())\n`,
  `def slugify(title):\n    return "-".join(w.lower() for w in title.split())\n`,
];

const mock = process.argv.includes("--mock");
const client = mock
  ? // The in-memory fake server, loaded only for --mock: a copy of this file needs no _mock.ts.
    new CoveClient({ baseUrl: "https://cove.mock", token: "cvk_mock", fetch: (await import("./_mock.ts")).mockFetch() })
  : new CoveClient({ baseUrl: env("COVE_URL"), token: env("COVE_TOKEN"), timeoutMs: 30_000 });
const repoUrl = mock ? "https://example.com/demo.git" : env("TRIES_REPO_URL");
const wait = { timeoutMs: 300_000, intervalMs: mock ? 10 : 1000 };

const { name: base } = await client.vms.create({});
console.log(`created ${base}`);
const tries: string[] = [];
try {
  await client.vms.waitForState(base, ["running"], wait);
  await run(base, ["git", "clone", "--depth", "1", repoUrl, SRC]);
  await run(base, ["make", "-C", SRC, "build"]);
  console.log(`${base} is prepared`);

  // A full checkpoint (memory too): a disk-only one cannot be cloned.
  const prepared = await client.checkpoints.create(base, { description: "prepared" });
  console.log("checkpoint taken: prepared");

  // One clone per fix, requested together. The host makes the clones of one VM one at a
  // time, and one can take about 45 s, so each call gets 300 s rather than the client's 30 s;
  // each clone is a copy, not a fresh setup.
  const names = FIXES.map((_, i) => `${base}-try-${i + 1}`);
  const cloned = await Promise.allSettled(
    names.map((n) =>
      client.vms.clone(base, { new_vm_name: n, source_checkpoint_id: prepared.id }, { timeoutMs: 300_000 }),
    ),
  );
  for (const c of cloned) if (c.status === "fulfilled") tries.push(c.value.new_vm.name);
  const refused = cloned.find((c) => c.status === "rejected");
  if (refused) throw refused.reason;
  console.log(`cloned ${tries.length} VMs from the checkpoint`);

  // Every clone tries its fix at the same time; results come back in fix order.
  const exits = await Promise.all(
    tries.map(async (vm, i) => {
      await client.vms.files.upload(vm, `${SRC}/slugify.py`, FIXES[i]!);
      const test = await client.vms.execCollect(vm, {
        command: ["python3", "-m", "unittest", "discover", "-s", SRC],
        timeoutSecs: 600,
      });
      return test.exitCode;
    }),
  );
  exits.forEach((code, i) => console.log(`fix ${i + 1} on ${tries[i]}: tests ${code === 0 ? "passed" : `failed (exit ${code})`}`));
  const winner = exits.indexOf(0);
  if (winner === -1) {
    console.log("no fix passed");
    process.exitCode = 1;
  } else {
    console.log(`keeping fix ${winner + 1}, on ${tries[winner]}`);
    // Delete the clones that lost, now.
    for (const [i, vm] of tries.entries()) {
      if (i === winner) continue;
      await client.vms.delete(vm);
      console.log(`deleted ${vm}`);
    }
    tries.splice(0, tries.length, tries[winner]!);
  }
} catch (err) {
  if (!(err instanceof CoveAPIError)) throw err;
  console.error(`API error ${err.status} ${err.code}: ${err.message}`);
  process.exitCode = 1;
} finally {
  // A real run keeps the winner (and the base, to try again). This one deletes both, so a
  // demo run leaves nothing behind but the checkpoint; `cove checkpoint rm` removes it.
  for (const vm of [...tries, base]) {
    await client.vms.delete(vm);
    console.log(`deleted ${vm}`);
  }
}

/** Run a command in the VM and fail if it fails. */
async function run(vm: string, command: string[]): Promise<void> {
  const out = await client.vms.execCollect(vm, { command, timeoutSecs: 1800 });
  if (out.exitCode !== 0) throw new Error(`${command.join(" ")} failed (exit ${out.exitCode}): ${out.stderr}`);
}

function env(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`set ${key} (see the top of this file), or run with --mock`);
    process.exit(1);
  }
  return value;
}
