#!/usr/bin/env node
// A file-processing job: copy a batch of input files into a throwaway VM, run the
// processing there (here, totalling order quantities with awk, where your own converter
// or an untrusted tool would go), and read the result back with `vms.files`. Nothing the job runs touches
// your machine, and the VM is deleted at the end.
//
//   COVE_URL=http://127.0.0.1:8090 COVE_TOKEN=cvk_... node examples/file-processing.ts
//   node examples/file-processing.ts --mock     # offline, against an in-memory fake server
//
// Node 22.18 or later runs this file as it is; run `npm run build` first.
import { CoveClient, CoveAPIError } from "@runcove/sdk";

// The batch: file name -> contents. Read your own with fs.readFileSync.
const INPUTS: Record<string, string> = {
  "orders-monday.csv": "apples,5\npears,2\n",
  "orders-tuesday.csv": "apples,7\npears,3\n",
};

// Sums the second column per first column over every input file, sorted by item.
const PROCESS = `cat /root/in/*.csv | awk -F, '{ t[$1] += $2 } END { for (k in t) print k "," t[k] }' | sort > /root/out/totals.csv`;

const mock = process.argv.includes("--mock");
const client = mock
  ? // The in-memory fake server, loaded only for --mock: a copy of this file needs no _mock.ts.
    new CoveClient({ baseUrl: "https://cove.mock", token: "cvk_mock", fetch: (await import("./_mock.ts")).mockFetch() })
  : new CoveClient({ baseUrl: env("COVE_URL"), token: env("COVE_TOKEN"), timeoutMs: 30_000 });

const { name } = await client.vms.create({});
console.log(`created ${name}`);
try {
  await client.vms.waitForState(name, ["running"], { timeoutMs: 300_000, intervalMs: mock ? 10 : 1000 });
  console.log(`${name} is running`);

  for (const [file, content] of Object.entries(INPUTS)) await writeFile(name, `/root/in/${file}`, content);
  console.log(`uploaded ${Object.keys(INPUTS).length} files to /root/in`);

  const job = await client.vms.execCollect(name, {
    command: ["sh", "-c", `mkdir -p /root/out && ${PROCESS}`, "sum-orders"],
    timeoutSecs: 600,
  });
  if (job.exitCode !== 0) throw new Error(`processing failed (exit ${job.exitCode}): ${job.stderr}`);

  // downloadBytes reads the whole file; `vms.files.download` streams a large one instead.
  const result = await client.vms.files.downloadBytes(name, "/root/out/totals.csv");
  console.log("totals.csv:");
  process.stdout.write(result);
} catch (err) {
  if (!(err instanceof CoveAPIError)) throw err;
  console.error(`API error ${err.status} ${err.code}: ${err.message}`);
  process.exitCode = 1;
} finally {
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
