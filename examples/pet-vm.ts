#!/usr/bin/env node
// A personal pet VM: one long-lived box you keep. It pauses itself when idle, and before a
// risky change you take a disk-only checkpoint, so a change that breaks it is undone by
// rolling the disk back. The "upgrade" here is scripted to break the config file; the
// program notices, rolls back, then hibernates the VM and wakes it again.
//
//   COVE_URL=http://127.0.0.1:8090 COVE_TOKEN=cvk_... node examples/pet-vm.ts
//   node examples/pet-vm.ts --mock     # offline, against an in-memory fake server
//
// A real pet is kept. This program deletes the VM and its checkpoints at the end, so a demo
// run leaves nothing behind. Node 22.18 or later runs this file as it is; run
// `npm run build` first.
import { CoveClient, CoveAPIError } from "@runcove/sdk";

const NAME = "my-pet";
const CONFIG = "/root/app/config.toml";
const IDLE_SECS = 3600;

const mock = process.argv.includes("--mock");
const client = mock
  ? // The in-memory fake server, loaded only for --mock: a copy of this file needs no _mock.ts.
    new CoveClient({ baseUrl: "https://cove.mock", token: "cvk_mock", fetch: (await import("./_mock.ts")).mockFetch() })
  : new CoveClient({ baseUrl: env("COVE_URL"), token: env("COVE_TOKEN"), timeoutMs: 30_000 });
const wait = { timeoutMs: 300_000, intervalMs: mock ? 10 : 1000 };

// Pause the VM after an hour without traffic: its memory is kept, and it resumes where it was.
await client.vms.create({ name: NAME, auto_pause_policy: { type: "auto_pause", idle_timeout_secs: IDLE_SECS } });
console.log(`created ${NAME}, pausing after ${IDLE_SECS / 60} minutes idle`);
const checkpoints: string[] = [];
try {
  await client.vms.waitForState(NAME, ["running"], wait);
  console.log(`${NAME} is running`);

  await writeFile(CONFIG, "version = 1\n");
  console.log(`config: ${await readConfig()}`);

  // Disk only: cheaper than a full checkpoint, and enough to undo a change on disk. Rolling
  // back to it boots the VM fresh, so programs that were running start again.
  const before = await client.checkpoints.create(NAME, { disk_only: true, description: "before upgrade" });
  checkpoints.push(before.id);
  console.log("checkpoint taken: before upgrade (disk only)");

  // The risky change, and the check that it worked. This "upgrade" empties the config.
  await sh(`printf %s "$1" > ${CONFIG}`, "");
  if ((await sh(`test -s ${CONFIG}`)) !== 0) {
    console.log("upgrade broke the config, rolling back");
    // A disk-only checkpoint restores onto a stopped VM: its disk is replaced and it boots.
    await client.vms.stop(NAME);
    await client.vms.waitForState(NAME, ["stopped"], wait);
    await client.vms.wake(NAME, { checkpoint_id: before.id });
    await client.vms.waitForState(NAME, ["running"], wait);
    console.log(`rolled back, config: ${await readConfig()}`);
  }

  // Hibernate: the memory goes to disk and the VM holds no RAM until it is woken.
  const hibernation = await client.checkpoints.hibernate(NAME);
  checkpoints.push(hibernation.id);
  console.log(`${NAME} is hibernated`);
  // No checkpoint id: wake from the newest, the one hibernating just took.
  await client.vms.wake(NAME);
  await client.vms.waitForState(NAME, ["running"], wait);
  console.log(`woke ${NAME}, config: ${await readConfig()}`);
} catch (err) {
  if (!(err instanceof CoveAPIError)) throw err;
  console.error(`API error ${err.status} ${err.code}: ${err.message}`);
  process.exitCode = 1;
} finally {
  // A real pet stays. Checkpoints outlive their VM, so delete them too.
  await client.vms.delete(NAME);
  for (const id of checkpoints) await client.checkpoints.delete(id);
  console.log(`deleted ${NAME} and ${checkpoints.length} checkpoints`);
}

/** Run a shell script in the VM, with `args` as $1...; return its exit code. */
async function sh(script: string, ...args: string[]): Promise<number> {
  const run = await client.vms.execCollect(NAME, { command: ["sh", "-c", script, "sh", ...args], timeoutSecs: 60 });
  return run.exitCode;
}

async function readConfig(): Promise<string> {
  const run = await client.vms.execCollect(NAME, { command: ["cat", CONFIG] });
  if (run.exitCode !== 0) throw new Error(`reading ${CONFIG} failed: ${run.stderr}`);
  return run.stdout.trim();
}

/** Write `content` to `path` with `vms.files.upload`, after making its directory. */
async function writeFile(path: string, content: string): Promise<void> {
  const mkdir = await client.vms.execCollect(NAME, { command: ["mkdir", "-p", path.slice(0, path.lastIndexOf("/")) || "/"] });
  if (mkdir.exitCode !== 0) throw new Error(`creating the directory for ${path} failed: ${mkdir.stderr}`);
  await client.vms.files.upload(NAME, path, content);
}

function env(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error("set COVE_URL and COVE_TOKEN (a cvk_ API key), or run with --mock");
    process.exit(1);
  }
  return value;
}
