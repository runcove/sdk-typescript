#!/usr/bin/env node
// Multi-VM fan-out: split one job into shards, run each shard on its own VM at the same
// time, and combine the results. The job here counts the primes in 1..30000 with awk; a
// test suite split by file, or a batch split by input, has the same shape.
//
//   COVE_URL=http://127.0.0.1:8090 COVE_TOKEN=cvk_... node examples/fan-out.ts
//   node examples/fan-out.ts --mock     # offline, against an in-memory fake server
//
// Each VM counts against your quota. Node 22.18 or later runs this file as it is; run
// `npm run build` first.
import { CoveClient, CoveAPIError } from "@runcove/sdk";

const SHARDS = [
  [1, 10000],
  [10001, 20000],
  [20001, 30000],
] as const;

// Counts the primes in $1..$2 by trial division.
const COUNT_PRIMES = `seq "$1" "$2" | awk '{ n = $1; if (n < 2) next; p = 1
  for (i = 2; i * i <= n; i++) if (n % i == 0) { p = 0; break }
  c += p } END { print c + 0 }'`;

const mock = process.argv.includes("--mock");
const client = mock
  ? // The in-memory fake server, loaded only for --mock: a copy of this file needs no _mock.ts.
    new CoveClient({ baseUrl: "https://cove.mock", token: "cvk_mock", fetch: (await import("./_mock.ts")).mockFetch() })
  : new CoveClient({ baseUrl: env("COVE_URL"), token: env("COVE_TOKEN"), timeoutMs: 30_000 });

// Create every VM at once. Keep the ones that were created even if another failed, so the
// `finally` below deletes them all.
const created = await Promise.allSettled(SHARDS.map(() => client.vms.create({})));
const names = created.flatMap((c) => (c.status === "fulfilled" ? [c.value.name] : []));
try {
  const refused = created.find((c) => c.status === "rejected");
  if (refused) throw refused.reason;
  console.log(`created ${names.length} VMs`);

  const wait = { timeoutMs: 300_000, intervalMs: mock ? 10 : 1000 };
  await Promise.all(names.map((name) => client.vms.waitForState(name, ["running"], wait)));
  console.log(`all ${names.length} running`);

  // One shard per VM, all at once; results come back in shard order.
  const counts = await Promise.all(
    SHARDS.map(async ([from, to], i) => {
      const run = await client.vms.execCollect(names[i]!, {
        command: ["sh", "-c", COUNT_PRIMES, "count-primes", String(from), String(to)],
        timeoutSecs: 600,
      });
      if (run.exitCode !== 0) throw new Error(`shard ${i + 1} failed (exit ${run.exitCode}): ${run.stderr}`);
      return Number(run.stdout.trim());
    }),
  );
  counts.forEach((count, i) => console.log(`shard ${i + 1}: ${count} primes in ${SHARDS[i]![0]}..${SHARDS[i]![1]}`));
  const total = counts.reduce((a, b) => a + b, 0);
  console.log(`total: ${total} primes in ${SHARDS[0][0]}..${SHARDS[SHARDS.length - 1]![1]}`);
} catch (err) {
  // A create over your quota is refused here as a 409 that names the reason.
  if (!(err instanceof CoveAPIError)) throw err;
  console.error(`API error ${err.status} ${err.code}: ${err.message}`);
  process.exitCode = 1;
} finally {
  // Delete every VM that was created, even when one of the deletes fails.
  const deleted = await Promise.allSettled(names.map((name) => client.vms.delete(name)));
  console.log(`deleted ${deleted.filter((d) => d.status === "fulfilled").length} VMs`);
}

function env(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error("set COVE_URL and COVE_TOKEN (a cvk_ API key), or run with --mock");
    process.exit(1);
  }
  return value;
}
