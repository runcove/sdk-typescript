// The worked use cases under examples/: each runs its whole flow offline under `--mock`,
// exists in both SDKs, and is named by the documentation portal's manifest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, makeRepo, tempDir } from "./spotlight-repo.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(root, "../..");
const tsExamples = join(root, "examples");
const pyExamples = join(repoRoot, "sdk/python/examples");

// Each use case, by its TypeScript file's stem, and the lines its `--mock` run must print.
// sdk/python/tests/test_component_examples.py holds the Python twins to the same lines.
const USE_CASES = {
  "agent-sandbox": [
    "created demo-vm",
    "demo-vm is running",
    "attempt 1: tests failed (exit 1)",
    "attempt 2: tests passed",
    "deleted demo-vm",
  ],
  "ci-runner": [
    "created demo-vm for run local",
    "step checkout: ok",
    "registry token available to setup",
    "step setup: ok",
    "step test: ok",
    "ci: passed",
    "deleted demo-vm",
  ],
  "file-processing": [
    "uploaded 2 files to /root/in",
    "apples,12",
    "pears,5",
    "deleted demo-vm",
  ],
  "event-driven": [
    "event: state creating",
    "event: progress booting",
    "event: state running",
    "demo-vm is running, provisioning it",
    "provisioned by an event handler",
    "deleted demo-vm",
  ],
  "fan-out": [
    "created 3 VMs",
    "all 3 running",
    "shard 1: 1229 primes in 1..10000",
    "shard 2: 1033 primes in 10001..20000",
    "shard 3: 983 primes in 20001..30000",
    "total: 3245 primes in 1..30000",
    "deleted 3 VMs",
  ],
  "pet-vm": [
    "created my-pet, pausing after 60 minutes idle",
    "my-pet is running",
    "config: version = 1",
    "checkpoint taken: before upgrade (disk only)",
    "upgrade broke the config, rolling back",
    "rolled back, config: version = 1",
    "my-pet is hibernated",
    "woke my-pet, config: version = 1",
    "deleted my-pet and 2 checkpoints",
  ],
  "code-execution": [
    "created demo-vm",
    "deleted demo-vm",
    "request 1: exit 0: hello from a fresh VM",
    "created demo-vm-2",
    "deleted demo-vm-2",
    "request 2: exit 3: checking the input",
    "created demo-vm-3",
    "deleted demo-vm-3",
    "request 3: killed at its 5 s deadline: starting a long job",
  ],
  "preview": [
    "created pr-123",
    "app is up on port 8080",
    "preview for pull request 123: https://pr-123-8080.cove.mock/",
    "deleted pr-123",
  ],
  "parallel-tries": [
    "created demo-vm",
    "demo-vm is prepared",
    "checkpoint taken: prepared",
    "cloned 3 VMs from the checkpoint",
    "fix 1 on demo-vm-try-1: tests failed (exit 1)",
    "fix 2 on demo-vm-try-2: tests passed",
    "fix 3 on demo-vm-try-3: tests passed",
    "keeping fix 2, on demo-vm-try-2",
    "deleted demo-vm-try-1",
    "deleted demo-vm-try-3",
    "deleted demo-vm-try-2",
    "deleted demo-vm",
  ],
  "repro-box": [
    "created repro-4521 for report 4521",
    "repro-4521 deletes itself in 24 hours",
    "importing 3 rows",
    "expected 3 rows, found 2",
    "reproduced: exit 1",
    "checkpoint taken: failing state",
    "gave alice access",
    "alice connects with: cove ssh repro-4521",
    "deleted repro-4521",
  ],
  "coding-agent": [
    "created demo-vm for task lowercase-slugs",
    "agent: slugify() now lowercases the title, and test_lowercase.py tests it.",
    "deleted demo-vm",
    "task lowercase-slugs: 2 files changed: slugify.py, test_lowercase.py",
    "  -    return \"-\".join(title.split())",
    "  +    return \"-\".join(title.lower().split())",
    "  +import unittest",
    "  +from slugify import slugify",
    "created demo-vm-2 for task contributing-typo",
    "agent: Nothing in this repository matches the task, so I changed no files.",
    "deleted demo-vm-2",
    "task contributing-typo: no changes",
  ],
  spotlight: [
    "created demo-vm",
    "demo-vm is running",
    "spotlight on: main -> demo-vm:/srv/app (2 files)",
    "app.txt: version: base",
    "switched to feature",
    "app.txt: version: feature",
    "node_modules/marker: installed",
    "status: feature on /srv/app",
    "spotlight off: base tree restored on /srv/app",
    "app.txt after off: version: base",
    "status: nothing bound",
    "deleted demo-vm",
  ],
};

// Use cases whose programs the portal does not show yet. The portal shows a program pair under the
// page its manifest entry names, which need not share the program's name; take a stem out of this
// set when its pair is added to docs-portal/use-cases.json.
const NOT_IN_PORTAL_YET = new Set([]);

// Not use cases: the shared fake server and the examples that predate them.
const NOT_USE_CASES = new Set(["_mock", "create-exec-destroy", "flue-sandbox"]);
const tsStem = (f) => f.replace(/\.(ts|mjs)$/, "");
const pyTwin = (stem) => `${stem.replaceAll("-", "_")}.py`;

function runMock(file) {
  // A credential in the caller's environment must not matter under --mock.
  // Nor may a hook's GIT_DIR and friends, which would point the examples' git at the real repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COVE_") && !k.startsWith("GIT_")));
  return spawnSync(process.execPath, [file, "--mock"], { encoding: "utf8", timeout: 60_000, env });
}

for (const [stem, lines] of Object.entries(USE_CASES)) {
  test(`component_use_case_${stem}_runs_offline_under_mock`, (t) => {
    if (!process.features?.typescript) {
      // CI must run these: a green skip on an older Node would drop the coverage unseen.
      assert.ok(!process.env.COVE_CI, `node ${process.version} cannot run .ts files, and COVE_CI forbids skipping`);
      return t.skip(`node ${process.version} cannot run .ts files`);
    }
    const file = join(tsExamples, `${stem}.ts`);
    assert.ok(existsSync(file), `missing example ${file}`);
    const run = runMock(file);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const printed = run.stdout.split("\n");
    for (const line of lines) assert.ok(printed.includes(line), `${stem} printed "${line}":\n${run.stdout}`);
    // The lines come in the order the program does its steps.
    const at = lines.map((l) => printed.indexOf(l));
    assert.deepEqual([...at].sort((a, b) => a - b), at, `${stem} prints its steps in order:\n${run.stdout}`);
  });
}

test("unit_every_use_case_exists_in_both_languages", () => {
  const ts = readdirSync(tsExamples).filter((f) => /\.(ts|mjs)$/.test(f)).map(tsStem).filter((s) => !NOT_USE_CASES.has(s));
  const py = readdirSync(pyExamples).filter((f) => f.endsWith(".py") && !f.startsWith("_"));
  for (const stem of ts) assert.ok(py.includes(pyTwin(stem)), `examples/${stem}.ts has no Python twin ${pyTwin(stem)}`);
  const pyKnown = new Set([...ts.map(pyTwin), "create_exec_destroy.py", "create_exec_destroy_async.py"]);
  for (const f of py) assert.ok(pyKnown.has(f), `sdk/python/examples/${f} has no TypeScript twin`);
  assert.deepEqual(ts.sort(), Object.keys(USE_CASES).sort(), "every use case is run under --mock above");
});

test("unit_portal_manifest_names_both_files_of_every_use_case", () => {
  const useCases = JSON.parse(readFileSync(join(repoRoot, "docs-portal/use-cases.json"), "utf8"));
  // A page may show no programs (both fields absent); one that does names a TypeScript use case
  // and its Python twin.
  const shown = [];
  for (const u of useCases.filter((u) => u.typescript !== undefined || u.python !== undefined)) {
    const m = /^sdk\/typescript\/examples\/([\w-]+)\.ts$/.exec(u.typescript ?? "");
    assert.ok(m, `${u.slug} names the TypeScript program ${u.typescript}`);
    assert.equal(u.python, `sdk/python/examples/${pyTwin(m[1])}`);
    for (const f of [u.typescript, u.python]) assert.ok(existsSync(join(repoRoot, f)), `the manifest names ${f}, which does not exist`);
    shown.push(m[1]);
  }
  for (const stem of NOT_IN_PORTAL_YET) assert.ok(!shown.includes(stem), `${stem} is in the portal now: take it out of NOT_IN_PORTAL_YET`);
  assert.deepEqual([...shown, ...NOT_IN_PORTAL_YET].sort(), Object.keys(USE_CASES).sort());
});

test("component_fake_server_refuses_to_delete_a_checkpoint_a_live_clone_was_made_from", async (t) => {
  if (!process.features?.typescript) {
    assert.ok(!process.env.COVE_CI, `node ${process.version} cannot run .ts files, and COVE_CI forbids skipping`);
    return t.skip(`node ${process.version} cannot run .ts files`);
  }
  const { CoveClient } = await import("../dist/index.js");
  const { mockFetch } = await import("../examples/_mock.ts");
  const client = new CoveClient({ baseUrl: "https://cove.mock", token: "cvk_mock", fetch: mockFetch() });
  await client.vms.create({ name: "src-vm" });
  await client.vms.waitForState("src-vm", ["running"], { intervalMs: 1 });
  const ckpt = await client.checkpoints.create("src-vm", {});
  await client.vms.clone("src-vm", { new_vm_name: "copy-vm", source_checkpoint_id: ckpt.id });
  // As the server: 409 while the clone lives, then deletable once it is gone.
  await assert.rejects(client.checkpoints.delete(ckpt.id), (e) => e.status === 409 && e.code === "checkpoint_conflict");
  await client.vms.delete("copy-vm");
  await client.checkpoints.delete(ckpt.id);
});

test("component_fake_server_applies_the_wake_state_rule_and_the_checkpoint_status_codes", async (t) => {
  if (!process.features?.typescript) {
    assert.ok(!process.env.COVE_CI, `node ${process.version} cannot run .ts files, and COVE_CI forbids skipping`);
    return t.skip(`node ${process.version} cannot run .ts files`);
  }
  const { CoveClient } = await import("../dist/index.js");
  const { mockFetch } = await import("../examples/_mock.ts");
  const client = new CoveClient({ baseUrl: "https://cove.mock", token: "cvk_mock", fetch: mockFetch() });
  for (const name of ["vm-a", "vm-b"]) {
    await client.vms.create({ name });
    await client.vms.waitForState(name, ["running"], { intervalMs: 1 });
  }
  const full = await client.checkpoints.create("vm-a", {});
  const diskOnly = await client.checkpoints.create("vm-a", { disk_only: true });
  const refused = (status, code) => (e) => e.status === status && e.code === code;
  // As the server: a full checkpoint wakes only a hibernated VM, a disk-only one only a stopped VM.
  await assert.rejects(client.vms.wake("vm-a", { checkpoint_id: full.id }), refused(409, "invalid_state_transition"));
  await assert.rejects(client.vms.wake("vm-a", { checkpoint_id: diskOnly.id }), refused(409, "invalid_state_transition"));
  await client.vms.stop("vm-a");
  await client.vms.waitForState("vm-a", ["stopped"], { intervalMs: 1 });
  await assert.rejects(client.vms.wake("vm-a", { checkpoint_id: full.id }), refused(409, "invalid_state_transition"));
  // The newest checkpoint is disk-only, so a wake that does not name it is refused.
  await assert.rejects(client.vms.wake("vm-a"), refused(409, "disk_rollback_not_named"));
  await client.vms.wake("vm-a", { checkpoint_id: diskOnly.id });
  // A checkpoint that does not exist is a 404; one taken of another VM is a 409.
  const missing = "00000000-0000-7000-8000-000000000000";
  await assert.rejects(client.vms.wake("vm-b", { checkpoint_id: missing }), refused(404, "wake_target_not_found"));
  await assert.rejects(client.vms.wake("vm-b", { checkpoint_id: full.id }), refused(409, "invalid_state_transition"));
  await assert.rejects(
    client.vms.clone("vm-b", { new_vm_name: "copy", source_checkpoint_id: missing }),
    refused(404, "clone_source_not_found"),
  );
  await assert.rejects(
    client.vms.clone("vm-b", { new_vm_name: "copy", source_checkpoint_id: full.id }),
    refused(409, "invalid_state_transition"),
  );
});

test("component_fake_server_gives_the_agent_its_key_only_through_the_secrets_route", async (t) => {
  if (!process.features?.typescript) {
    assert.ok(!process.env.COVE_CI, `node ${process.version} cannot run .ts files, and COVE_CI forbids skipping`);
    return t.skip(`node ${process.version} cannot run .ts files`);
  }
  const { CoveClient } = await import("../dist/index.js");
  const { mockFetch } = await import("../examples/_mock.ts");
  const client = new CoveClient({ baseUrl: "https://cove.mock", token: "cvk_mock", fetch: mockFetch() });
  await client.vms.create({ name: "agent-vm" });
  await client.vms.waitForState("agent-vm", ["running"], { intervalMs: 1 });
  await client.vms.execCollect("agent-vm", { command: ["git", "clone", "https://example.com/demo.git", "/root/work"] });
  const agent = (shell) => [shell, shell === "bash" ? "-lc" : "-c", 'cd "$1" && claude -p "$2" --permission-mode acceptEdits', "agent", "/root/work", "lowercase"];
  // No key yet: the fake agent refuses, as the real one does.
  assert.equal((await client.vms.execCollect("agent-vm", { command: agent("bash") })).exitCode, 1);
  await client.secrets.vm("agent-vm").rotate("ANTHROPIC_API_KEY", {
    value_b64: Buffer.from("sk-ant-test-key").toString("base64"),
    exposure: "env",
    target_unit: "@login",
  });
  // A plain `sh -c` is no login shell, so the key is not in its environment.
  assert.equal((await client.vms.execCollect("agent-vm", { command: agent("sh") })).exitCode, 1);
  // The key's value on a command line is refused.
  await assert.rejects(
    client.vms.execCollect("agent-vm", { command: ["echo", "sk-ant-test-key"] }),
    (e) => e.status === 400 && /ANTHROPIC_API_KEY/.test(e.message),
  );
  assert.equal((await client.vms.execCollect("agent-vm", { command: agent("bash") })).exitCode, 0);
});

// Every file under `dir` with its bytes, so a stray write shows as a difference.
function snapshot(dir) {
  const out = {};
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const p = join(e.parentPath ?? e.path, e.name);
    out[p] = e.isDirectory() ? "dir" : readFileSync(p).toString("base64");
  }
  return out;
}

test("component_spotlight_git_leaves_a_decoy_repository_alone_under_hook_variables", (t) => {
  if (!process.features?.typescript) {
    assert.ok(!process.env.COVE_CI, `node ${process.version} cannot run .ts files, and COVE_CI forbids skipping`);
    return t.skip(`node ${process.version} cannot run .ts files`);
  }
  const decoy = join(tempDir(t, "cove-decoy-"), "decoy.git");
  mkdirSync(decoy);
  git(decoy, "init", "-q", "--bare");
  const before = snapshot(decoy);
  // What a git hook exports; all of them point at the decoy, never at a real repository.
  const hook = {
    GIT_DIR: decoy,
    GIT_WORK_TREE: decoy,
    GIT_INDEX_FILE: join(decoy, "index"),
    GIT_OBJECT_DIRECTORY: join(decoy, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(decoy, "objects"),
    GIT_COMMON_DIR: decoy,
  };
  const saved = Object.fromEntries(Object.keys(hook).map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  Object.assign(process.env, hook);
  const repo = makeRepo(t);
  assert.equal(git(repo, "log", "-1", "--format=%s"), "base");
  const run = runMock(join(tsExamples, "spotlight.ts"));
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(snapshot(decoy), before);
});
