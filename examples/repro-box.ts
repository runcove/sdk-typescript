#!/usr/bin/env node
// A throwaway box to reproduce a bug: create a VM that deletes itself after a day, tagged
// with the bug report it is for, run the reproduction there, checkpoint it while it shows
// the failure, and give a colleague access so they can look at the same box.
//
//   COVE_URL=http://127.0.0.1:8090 COVE_TOKEN=cvk_... REPORT=4521 COLLEAGUE=alice \
//     node examples/repro-box.ts
//   node examples/repro-box.ts --mock     # offline, against an in-memory fake server
//
// The box would normally stay until its colleague is done, or until it expires; this
// program deletes it and its checkpoint at the end, so a demo run leaves nothing behind.
// Node 22.18 or later runs this file as it is; run `npm run build` first.
import { CoveClient, CoveAPIError } from "@runcove/sdk";

// The reproduction from the report: here, a script that shows the failure and exits non-zero.
const REPRO = `echo importing 3 rows
echo expected 3 rows, found 2
exit 1
`;
const DAY_SECS = 24 * 3600;

const mock = process.argv.includes("--mock");
const client = mock
  ? // The in-memory fake server, loaded only for --mock: a copy of this file needs no _mock.ts.
    new CoveClient({ baseUrl: "https://cove.mock", token: "cvk_mock", fetch: (await import("./_mock.ts")).mockFetch() })
  : new CoveClient({ baseUrl: env("COVE_URL"), token: env("COVE_TOKEN"), timeoutMs: 30_000 });
const report = mock ? "4521" : env("REPORT");
const colleague = mock ? "alice" : env("COLLEAGUE");

// The VM is deleted a day after it was created, whatever state it is in.
const { name } = await client.vms.create({
  name: `repro-${report}`,
  initial_tags: { report },
  ttl_policy: { max_lifetime_secs: DAY_SECS },
});
console.log(`created ${name} for report ${report}`);
let checkpoint: string | undefined;
try {
  await client.vms.waitForState(name, ["running"], { timeoutMs: 300_000, intervalMs: mock ? 10 : 1000 });
  const expiry = await client.policies.getExpiry(name);
  console.log(`${name} deletes itself in ${Math.round((expiry.max_life_expires_in_secs ?? 0) / 3600)} hours`);

  const mkdir = await client.vms.execCollect(name, { command: ["mkdir", "-p", "/root/repro"] });
  if (mkdir.exitCode !== 0) throw new Error(`creating /root/repro failed: ${mkdir.stderr}`);
  await client.vms.files.upload(name, "/root/repro/repro.sh", REPRO);
  const run = await client.vms.execCollect(name, { command: ["sh", "/root/repro/repro.sh"], timeoutSecs: 600 });
  process.stdout.write(run.stdout);
  if (run.exitCode === 0) {
    console.log("the bug did not reproduce");
  } else {
    console.log(`reproduced: exit ${run.exitCode}`);
    // The failing state, kept: you can clone a fresh box from it even after this one changed.
    const saved = await client.checkpoints.create(name, { description: `report ${report}: failing` });
    checkpoint = saved.id;
    console.log("checkpoint taken: failing state");

    // Role "user" can connect and look; "collaborator" can also stop, start, resize and
    // checkpoint the VM.
    const grant = await client.vms.grantAccess(name, { subject_type: "user", subject_id: colleague, role: "collaborator" });
    console.log(`gave ${colleague} access${grant.user_known ? "" : " (from their first sign-in)"}`);
    console.log(`${colleague} connects with: cove ssh ${name}`);
  }
} catch (err) {
  if (!(err instanceof CoveAPIError)) throw err;
  console.error(`API error ${err.status} ${err.code}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.vms.delete(name);
  if (checkpoint) await client.checkpoints.delete(checkpoint);
  console.log(`deleted ${name}`);
}

function env(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`set ${key} (see the top of this file), or run with --mock`);
    process.exit(1);
  }
  return value;
}
