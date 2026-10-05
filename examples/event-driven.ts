#!/usr/bin/env node
// Event-driven provisioning: instead of polling a new VM until it runs, follow its event
// stream, which reports each creation stage as it happens, and provision the VM the moment
// the stream says it is running. A failed creation arrives on the same stream as an
// `error` event, or as state `failed`; a stream that ends on `deleted` has no VM to provision.
//
//   COVE_URL=http://127.0.0.1:8090 COVE_TOKEN=cvk_... node examples/event-driven.ts
//   node examples/event-driven.ts --mock     # offline, against an in-memory fake server
//
// Node 22.18 or later runs this file as it is; run `npm run build` first.
import { CoveClient, CoveAPIError } from "@runcove/sdk";

// What to run once the VM is up.
const PROVISION = "echo 'provisioned by an event handler' | tee /etc/motd";

const mock = process.argv.includes("--mock");
const client = mock
  ? // The in-memory fake server, loaded only for --mock: a copy of this file needs no _mock.ts.
    new CoveClient({ baseUrl: "https://cove.mock", token: "cvk_mock", fetch: (await import("./_mock.ts")).mockFetch() })
  : new CoveClient({ baseUrl: env("COVE_URL"), token: env("COVE_TOKEN"), timeoutMs: 30_000 });

const { name } = await client.vms.create({});
console.log(`created ${name}`);
let provisioned = false;
try {
  // The stream sends the VM's current state first on every connect, so nothing is missed
  // between `create` and here. Give up after five minutes.
  for await (const evt of client.events.vm(name, { signal: AbortSignal.timeout(300_000) })) {
    if (evt.kind === "progress") console.log(`event: progress ${evt.stage}`);
    else if (evt.kind === "error") throw new Error(`creating ${name} failed at ${evt.stage}: ${evt.message}`);
    else if (evt.kind === "state") {
      console.log(`event: state ${evt.state}`);
      if (evt.state === "failed") throw new Error(`creating ${name} failed: the VM is in state failed`);
      if (evt.state === "deleted") break; // The stream ends here; the check below reports it.
      if (evt.state !== "running") continue;
      console.log(`${name} is running, provisioning it`);
      const run = await client.vms.execCollect(name, { command: ["sh", "-c", PROVISION, "provision"] });
      process.stdout.write(run.stdout);
      provisioned = true;
      break; // Leaving the loop closes the stream.
    }
    // After `reconnected` the stream resends the current state. After `lagged` (the server
    // dropped events for a slow reader), a handler that must not miss one re-reads `vms.get`.
  }
  if (!provisioned) throw new Error(`${name} was never provisioned: the event stream ended first`);
} catch (err) {
  if (!(err instanceof CoveAPIError)) throw err;
  console.error(`API error ${err.status} ${err.code}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.vms.delete(name);
  console.log(`deleted ${name}`);
}

function env(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error("set COVE_URL and COVE_TOKEN (a cvk_ API key), or run with --mock");
    process.exit(1);
  }
  return value;
}
