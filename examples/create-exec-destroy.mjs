#!/usr/bin/env node
// "Hello VM" — create a VM, wait for it to boot, run a command, destroy it.
//
// Against a real host — pick the credential matching the listener behind COVE_URL:
//   bearer listener ([api] bind):    COVE_URL=... COVE_TOKEN=cvk_... node examples/create-exec-destroy.mjs
//   Warpgate-fronted main listener:  COVE_URL=... COVE_TICKET=... node examples/create-exec-destroy.mjs
// (COVE_TICKET falls back to the ticket the `cove` CLI stores after `cove login`.)
//
// Without a host (in-memory fake server, demonstrates the full flow offline):
//   node examples/create-exec-destroy.mjs --mock
//
// Run `npm run build` first: inside this package, `@runcove/sdk` resolves to its own
// build (dist/) through the package's "exports"; an installed user gets the same import.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { CoveClient, CoveAPIError } from "@runcove/sdk";

const mock = process.argv.includes("--mock");

const client = new CoveClient(
  mock
    ? { baseUrl: "https://cove.mock", token: "cvk_mock", fetch: mockFetch() }
    : { baseUrl: requireEnv("COVE_URL"), ...credential(), timeoutMs: 30_000 },
);

// 1. Create (202 — creation continues in the background).
// COVE_IMAGE picks a specific golden image; omitted -> the host's default.
const { name } = await client.vms.create({ image: process.env.COVE_IMAGE });
console.log(`created ${name}`);

try {
  // 2. Wait until it leaves "creating" (bounded: throws CoveError after 5 minutes).
  const vm = await client.vms.waitForState(name, ["running"], {
    timeoutMs: 300_000,
    intervalMs: mock ? 100 : 1000,
  });
  console.log(`${name} is ${vm.state} at ${vm.ip_address}`);

  // 3. Exec, streaming output live. stdout/stderr events carry raw chunks
  // (newlines included) — write them verbatim, don't println.
  for await (const evt of client.vms.exec(name, { command: ["uname", "-a"] })) {
    if (evt.kind === "stdout") process.stdout.write(evt.data);
    else if (evt.kind === "stderr") process.stderr.write(evt.data);
    else if (evt.kind === "exit") console.log(`exit code ${evt.code}`);
  }

  // Or buffered, if you don't need streaming:
  const { stdout } = await client.vms.execCollect(name, { command: ["hostname"] });
  console.log(`hostname: ${stdout.trim()}`);
} catch (err) {
  if (err instanceof CoveAPIError) console.error(`API error ${err.status}: ${err.message}`);
  else throw err;
} finally {
  // 4. Destroy.
  await client.vms.delete(name);
  console.log(`deleted ${name}`);
}

function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    console.error(`Set ${key} (or run with --mock). See header comment for usage.`);
    process.exit(1);
  }
  return value;
}

function credential() {
  if (process.env.COVE_TOKEN) return { token: process.env.COVE_TOKEN };
  if (process.env.COVE_TICKET) return { ticket: process.env.COVE_TICKET };
  const cliTicketPath =
    process.platform === "darwin"
      ? `${homedir()}/Library/Application Support/cove/ticket`
      : `${homedir()}/.config/cove/ticket`;
  try {
    return { ticket: readFileSync(cliTicketPath, "utf8").trim() };
  } catch {
    console.error("Set COVE_TOKEN or COVE_TICKET (or `cove login` first). See header comment.");
    process.exit(1);
  }
}

/**
 * Minimal in-memory Cove daemon: just enough routing for this example.
 * Also a template for stubbing the SDK in your own tests — pass any
 * `fetch`-shaped function via `new CoveClient({ fetch })`.
 */
function mockFetch() {
  let polls = 0;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const vm = {
    vm_id: "0198c0de-0000-7000-8000-000000000000",
    name: "demo-vm",
    ip_address: "10.99.0.7",
  };
  return async (url, init) => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    if (method === "POST" && pathname === "/api/vms") return json({ name: vm.name }, 202);
    if (method === "GET" && pathname === `/api/vms/${vm.name}`)
      return json({ ...vm, state: polls++ < 2 ? "creating" : "running" });
    if (method === "POST" && pathname === `/api/vms/${vm.name}/exec`) {
      const { command } = JSON.parse(init.body);
      const line = command[0] === "uname" ? "Linux demo-vm 6.8.0 x86_64 GNU/Linux" : "demo-vm";
      // Wire-faithful: the server sends the chunk "line\n", which SSE
      // encodes as two data: fields (the second one empty).
      return new Response(
        `event: stdout\ndata: ${line}\ndata: \n\nevent: exit\ndata: {"code":0}\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }
    if (method === "DELETE" && pathname === `/api/vms/${vm.name}`)
      return new Response(null, { status: 202 });
    return json({ code: "not_found", message: `no mock route for ${method} ${pathname}` }, 404);
  };
}
