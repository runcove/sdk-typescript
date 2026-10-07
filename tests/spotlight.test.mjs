// `client.spotlight`: the tree it packs (from a real temporary git repository), the apply exec's
// argv, the order it writes the binding tags in, `off`'s base-commit guard, and the apply script
// itself, run with /bin/sh on this machine with rsync on PATH and without.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { LONG, LONGER, git, makeRepo, tempDir } from "./spotlight-repo.mjs";
import { CoveClient, CoveError, FileTooLargeError, SPOTLIGHT_DEFAULT_PROTECT } from "../dist/index.js";
import {
  SPOTLIGHT_APPLY_SCRIPT,
  applyCommand,
  commitEntries,
  splitNames,
  tagValue,
  worktreeEntries,
} from "../dist/resources/spotlight.js";
import { readTar, writeTar } from "../dist/tar.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

test("unit_spotlight_pack_keeps_untracked_and_drops_ignored_files", async (t) => {
  const dir = makeRepo(t);
  const entries = await worktreeEntries(dir);
  const paths = entries.map((e) => e.path).sort();
  assert.deepEqual(paths, [".gitignore", LONG, LONGER, "link", "run.sh", "tracked.txt", "untracked.txt"].sort());
  const byPath = new Map(entries.map((e) => [e.path, e]));
  assert.equal(byPath.get("run.sh").mode, 0o755);
  assert.equal(byPath.get("tracked.txt").mode & 0o777, lstatSync(join(dir, "tracked.txt")).mode & 0o777);
  assert.deepEqual(byPath.get("link"), { ...byPath.get("link"), kind: "symlink", target: "tracked.txt" });
});

test("unit_spotlight_tar_round_trips_modes_symlinks_and_long_paths_through_gnu_tar", async (t) => {
  const dir = makeRepo(t);
  const entries = await worktreeEntries(dir);
  const tar = writeTar(entries);
  // The SDK's own reader sees what it wrote.
  assert.deepEqual(
    readTar(tar).map((e) => [e.path, e.kind, e.mode]),
    entries.map((e) => [e.path, e.kind, e.mode]),
  );
  // So does GNU tar, the guest's extractor.
  const out = tempDir(t);
  const archive = join(out, "t.tgz");
  writeFileSync(archive, gzipSync(tar));
  mkdirSync(join(out, "x"));
  // -p, as the guest script extracts: modes as packed, whatever the umask.
  execFileSync("tar", ["-xpzf", archive, "-C", join(out, "x")]);
  assert.equal(readFileSync(join(out, "x", LONG), "utf8"), `content of ${LONG.length}\n`);
  assert.equal(readFileSync(join(out, "x", LONGER), "utf8"), `content of ${LONGER.length}\n`);
  assert.equal(lstatSync(join(out, "x/run.sh")).mode & 0o777, 0o755);
  assert.ok(lstatSync(join(out, "x/link")).isSymbolicLink());
  assert.equal(readlinkSync(join(out, "x/link")), "tracked.txt");
  assert.ok(!existsSync(join(out, "x/ignored.log")));
});

test("unit_spotlight_commit_entries_read_git_archive", async (t) => {
  const dir = makeRepo(t);
  const head = git(dir, "rev-parse", "HEAD");
  const entries = await commitEntries(dir, head);
  const paths = entries.map((e) => e.path).sort();
  // The committed tree: gone.txt is back, the untracked file is not there.
  assert.deepEqual(paths, [".gitignore", LONG, LONGER, "gone.txt", "link", "run.sh", "tracked.txt"].sort());
  assert.equal(entries.find((e) => e.path === "link").kind, "symlink");
});

// ---------------------------------------------------------------------------
// The client against a fake server
// ---------------------------------------------------------------------------

const sse = (event, data) => `event: ${event}\n${data.split("\n").map((l) => `data: ${l}\n`).join("")}\n`;

/**
 * A fake server for the routes spotlight calls. `tags` is the VM's tag map; `apply` answers the
 * exec (`{ stdout, stderr, code }`); `upload` answers the PUT file (a Response, or undefined for 200).
 */
function fakeServer({ tags = {}, apply = { stdout: '{"files":7,"bytes":99}\n', code: 0 }, upload } = {}) {
  const calls = [];
  const state = new Map(Object.entries(tags));
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const impl = async (url, init) => {
    const u = new URL(url);
    const method = init.method;
    const path = decodeURIComponent(u.pathname);
    const call = { method, path, query: u.searchParams.get("path"), body: init.body };
    calls.push(call);
    let m;
    if (method === "GET" && /^\/api\/vms\/[^/]+\/tags$/.test(path)) {
      return json([...state].map(([key, value]) => ({ key, value, set_by: "alice", set_at: "2026-10-05T00:00:00Z" })));
    }
    if ((m = /^\/api\/vms\/[^/]+\/tags\/(.+)$/.exec(path))) {
      if (method === "PUT") state.set(m[1], JSON.parse(init.body).value);
      if (method === "DELETE") state.delete(m[1]);
      return new Response(null, { status: 204 });
    }
    if (method === "PUT" && path.endsWith("/files")) {
      return upload?.() ?? json({ path: call.query, size: init.body.byteLength, mode: 0o644, sha256: "0".repeat(64) });
    }
    if (method === "POST" && path.endsWith("/exec")) {
      call.command = JSON.parse(init.body).command;
      const { stdout = "", stderr = "", code, timedOut } = apply;
      const exit = timedOut === undefined ? { code } : { code, timed_out: timedOut };
      return new Response((stdout ? sse("stdout", stdout) : "") + (stderr ? sse("stderr", stderr) : "") + sse("exit", JSON.stringify(exit)), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return json({ code: "not_found", message: `no fake route for ${method} ${path}` }, 404);
  };
  return { calls, impl, state };
}

const client = (impl) => new CoveClient({ baseUrl: "https://cove.test", token: "cvk_x", fetch: impl });
const tagWrites = (calls) => calls.filter((c) => c.path.includes("/tags/")).map((c) => `${c.method} ${c.path.split("/tags/")[1]}`);

test("unit_spotlight_apply_argv_carries_dest_and_protect_as_arguments_never_in_the_script", async (t) => {
  const dir = makeRepo(t);
  const { calls, impl } = fakeServer();
  // A dest and protect entries a shell would misread, were they spliced into the script.
  const dest = "/srv/my app;$(touch /tmp/pwned)'\"";
  const protect = ["node_modules/", "$(id)", "a b/"];
  const out = await client(impl).spotlight.on("box", { tree: dir, dest, protect });
  assert.deepEqual(out, { vm: "box", dest, base: git(dir, "rev-parse", "HEAD"), files: 7, bytes: 99 });
  const upload = calls.find((c) => c.method === "PUT" && c.path.endsWith("/files"));
  assert.match(upload.query, /^\/tmp\/cove-spotlight-[0-9a-f]{16}\.tgz$/);
  const exec = calls.find((c) => c.command);
  const [sh, dashC, script, zero, tgz, stage, sentDest, ...sentProtect] = exec.command;
  assert.deepEqual([sh, dashC, zero], ["sh", "-c", "sh"]);
  assert.equal(script, SPOTLIGHT_APPLY_SCRIPT);
  assert.equal(tgz, upload.query);
  assert.equal(stage, `${dest}.cove-stage-${tgz.slice("/tmp/cove-spotlight-".length, -".tgz".length)}`);
  assert.equal(sentDest, dest);
  assert.deepEqual(sentProtect, [...protect, ".git/"]);
  for (const v of [dest, ...protect, tgz]) assert.ok(!script.includes(v), `the script text holds ${v}`);
  assert.deepEqual(applyCommand("/t", "/s", "/d", ["p"]), ["sh", "-c", SPOTLIGHT_APPLY_SCRIPT, "sh", "/t", "/s", "/d", "p"]);
});

test("unit_spotlight_defaults_to_the_cli_protect_list", async (t) => {
  const dir = makeRepo(t);
  const { calls, impl } = fakeServer();
  await client(impl).spotlight.on("box", { tree: dir, dest: "/srv/app/" });
  const exec = calls.find((c) => c.command);
  assert.deepEqual(SPOTLIGHT_DEFAULT_PROTECT, ["node_modules/", "target/", "volumes/", ".venv/", ".env"]);
  assert.deepEqual(exec.command.slice(6), ["/srv/app", ...SPOTLIGHT_DEFAULT_PROTECT, ".git/"]);
});

test("unit_spotlight_first_bind_writes_base_dest_and_source_after_the_apply", async (t) => {
  const dir = makeRepo(t);
  const { calls, impl, state } = fakeServer();
  await client(impl).spotlight.on("box", { tree: dir, dest: "/srv/app" });
  const execAt = calls.findIndex((c) => c.command);
  const firstTag = calls.findIndex((c) => c.path.includes("/tags/"));
  assert.ok(execAt < firstTag, "the tags come after the apply");
  assert.deepEqual(tagWrites(calls), ["PUT spotlight.base", "PUT spotlight.dest", "PUT spotlight.source"]);
  assert.deepEqual(Object.fromEntries(state), {
    "spotlight.base": git(dir, "rev-parse", "HEAD"),
    "spotlight.dest": "/srv/app",
    "spotlight.source": "main",
  });
});

test("unit_spotlight_a_detached_head_is_labelled_by_the_directory_name", async (t) => {
  const dir = makeRepo(t);
  git(dir, "checkout", "-q", "--detach");
  const { impl, state } = fakeServer();
  await client(impl).spotlight.on("box", { tree: dir, dest: "/srv/app" });
  assert.equal(state.get("spotlight.source"), dir.split("/").pop());
});

test("unit_spotlight_a_switch_keeps_the_first_base", async (t) => {
  const dir = makeRepo(t);
  const { calls, impl, state } = fakeServer({ tags: { "spotlight.base": "f".repeat(40), "spotlight.dest": "/srv/app", "spotlight.source": "old" } });
  const out = await client(impl).spotlight.on("box", { tree: dir, dest: "/srv/app" });
  assert.equal(out.base, "f".repeat(40));
  assert.deepEqual(tagWrites(calls), ["PUT spotlight.dest", "PUT spotlight.source"]);
  assert.equal(state.get("spotlight.base"), "f".repeat(40));
  assert.equal(state.get("spotlight.source"), "main");
});

test("unit_spotlight_a_failed_apply_writes_no_tags", async (t) => {
  const dir = makeRepo(t);
  const { calls, impl } = fakeServer({ apply: { stderr: "tar: bad archive\n", code: 2 } });
  await assert.rejects(client(impl).spotlight.on("box", { tree: dir, dest: "/srv/app" }), (err) => {
    assert.ok(err instanceof CoveError);
    assert.match(err.message, /exit 2/);
    assert.match(err.message, /tar: bad archive/);
    return true;
  });
  assert.deepEqual(tagWrites(calls), []);
});

test("unit_spotlight_an_apply_killed_at_its_deadline_says_dest_may_be_half_mirrored", async (t) => {
  const dir = makeRepo(t);
  const { calls, impl } = fakeServer({ apply: { stdout: "", code: 124, timedOut: true } });
  await assert.rejects(client(impl).spotlight.on("box", { tree: dir, dest: "/srv/app", timeoutSecs: 42 }), (err) => {
    assert.ok(err instanceof CoveError);
    assert.match(err.message, /box:\/srv\/app hit its 42 s deadline/);
    assert.match(err.message, /may be half-mirrored; run on again/);
    return true;
  });
  assert.deepEqual(tagWrites(calls), []);
});

test("unit_spotlight_a_tree_over_the_file_cap_is_file_too_large_and_changes_nothing", async (t) => {
  const dir = makeRepo(t);
  const tooLarge = () =>
    new Response(JSON.stringify({ code: "file_too_large", message: "file is larger than 100 MiB" }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    });
  const { calls, impl } = fakeServer({ upload: tooLarge });
  await assert.rejects(client(impl).spotlight.on("box", { tree: dir, dest: "/srv/app" }), FileTooLargeError);
  assert.ok(!calls.some((c) => c.command), "no apply after a refused upload");
  assert.deepEqual(tagWrites(calls), []);
});

test("unit_spotlight_refuses_a_relative_or_root_dest", async (t) => {
  const dir = makeRepo(t);
  const { calls, impl } = fakeServer();
  for (const dest of ["srv/app", "/", "///", "", "-rf", "/srv/../etc", "/srv/./app", "/a\nb", "/a\u0085b", "/a\u009fb"]) {
    await assert.rejects(client(impl).spotlight.on("box", { tree: dir, dest }), CoveError, dest);
  }
  assert.deepEqual(calls, []);
});

test("unit_spotlight_refuses_option_shaped_protect_entries", async (t) => {
  const dir = makeRepo(t);
  const { calls, impl } = fakeServer();
  for (const protect of [["--delete"], ["-e sh"], ["ok/", "-x"], ["a\nb"], ["a\0b"]]) {
    await assert.rejects(client(impl).spotlight.on("box", { tree: dir, dest: "/srv/app", protect }), CoveError, JSON.stringify(protect));
    await assert.rejects(client(impl).spotlight.off("box", { tree: dir, protect }), CoveError, JSON.stringify(protect));
  }
  assert.deepEqual(calls, []);
});

test("unit_spotlight_a_hostile_base_tag_is_refused_before_any_git_call", async () => {
  // The tree does not exist: a git call would fail with a git error, not this one.
  const tree = "/nonexistent/cove-spotlight-tree";
  for (const base of ["--output=/x", "-rf", "HEAD", "abc", "A".repeat(40), `${"a".repeat(40)} `]) {
    const { calls, impl } = fakeServer({ tags: { "spotlight.base": base, "spotlight.dest": "/srv/app" } });
    await assert.rejects(client(impl).spotlight.off("box", { tree }), /spotlight\.base is not a commit id/, base);
    await assert.rejects(client(impl).spotlight.on("box", { tree, dest: "/srv/app" }), /spotlight\.base is not a commit id/, base);
    assert.ok(calls.every((c) => c.method === "GET"), "nothing written");
    await assert.rejects(commitEntries(tree, base), /spotlight\.base is not a commit id/);
  }
});

test("unit_spotlight_a_bound_dest_tag_is_checked_before_off_applies", async (t) => {
  const dir = makeRepo(t);
  const base = git(dir, "rev-parse", "HEAD");
  const { calls, impl } = fakeServer({ tags: { "spotlight.base": base, "spotlight.dest": "-rf" } });
  await assert.rejects(client(impl).spotlight.off("box", { tree: dir }), /dest must be an absolute path/);
  assert.ok(calls.every((c) => c.method === "GET"));
});

test("unit_spotlight_off_resolves_an_abbreviated_base", async (t) => {
  const dir = makeRepo(t);
  const short = git(dir, "rev-parse", "HEAD").slice(0, 10);
  const { calls, impl } = fakeServer({ tags: { "spotlight.base": short, "spotlight.dest": "/srv/app" } });
  assert.deepEqual(await client(impl).spotlight.off("box", { tree: dir }), { vm: "box", dest: "/srv/app", restored: short });
  const { gunzipSync } = await import("node:zlib");
  const upload = calls.find((c) => c.method === "PUT" && c.path.endsWith("/files"));
  assert.ok(readTar(gunzipSync(upload.body)).some((e) => e.path === "gone.txt"));
});

test("unit_spotlight_off_restores_the_recorded_commit_not_a_branch_named_like_it", async (t) => {
  const dir = makeRepo(t);
  const first = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "tracked.txt"), "tracked v2\n");
  git(dir, "commit", "-q", "-am", "second");
  // A branch named like the recorded id's prefix, pointing at the other commit.
  git(dir, "branch", first.slice(0, 10), "HEAD");
  const { calls, impl } = fakeServer({ tags: { "spotlight.base": first.slice(0, 10), "spotlight.dest": "/srv/app" } });
  await client(impl).spotlight.off("box", { tree: dir });
  const { gunzipSync } = await import("node:zlib");
  const upload = calls.find((c) => c.method === "PUT" && c.path.endsWith("/files"));
  const tracked = readTar(gunzipSync(upload.body)).find((e) => e.path === "tracked.txt");
  assert.equal(new TextDecoder().decode(tracked.data), "tracked v1\n");
});

test("unit_spotlight_an_empty_base_tag_counts_as_no_base", async (t) => {
  const dir = makeRepo(t);
  const { calls, impl, state } = fakeServer({ tags: { "spotlight.base": "" } });
  const out = await client(impl).spotlight.on("box", { tree: dir, dest: "/srv/app" });
  assert.equal(out.base, git(dir, "rev-parse", "HEAD"));
  assert.deepEqual(tagWrites(calls), ["PUT spotlight.base", "PUT spotlight.dest", "PUT spotlight.source"]);
  assert.equal(state.get("spotlight.base"), out.base);
  const unbound = fakeServer({ tags: { "spotlight.base": "", "spotlight.dest": "/srv/app" } });
  assert.equal(await client(unbound.impl).spotlight.off("box", { tree: dir }), null);
});

test("unit_spotlight_a_file_over_8_gib_is_refused_with_a_clear_message", () => {
  const huge = { kind: "file", path: "big.bin", mode: 0o644, data: { byteLength: 2 ** 33 } };
  assert.throws(() => writeTar([huge]), /big\.bin is 8589934592 bytes; spotlight's tar carries files up to 8 GiB/);
});

test("unit_spotlight_refuses_a_file_name_that_is_not_utf8", () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.deepEqual(splitNames(new Uint8Array([...enc("a.txt"), 0, ...enc("é/b"), 0])), ["a.txt", "é/b"]);
  const bad = new Uint8Array([...enc("ok"), 0, 0x66, 0xff, 0x6f, 0]);
  assert.throws(() => splitNames(bad), /spotlight cannot send .*file name is not valid UTF-8/);
});

test("unit_spotlight_a_long_label_is_cut_at_a_code_point", () => {
  const label = `${"a".repeat(254)}😀😀`;
  const cut = tagValue(label);
  assert.equal(cut, "a".repeat(254));
  assert.ok(new TextEncoder().encode(cut).byteLength <= 256);
  assert.ok(!/[\uD800-\uDFFF]$/.test(tagValue(`${"a".repeat(253)}😀😀`)));
  assert.equal(tagValue(`${"a".repeat(252)}😀`), `${"a".repeat(252)}😀`);
});

test("unit_spotlight_a_missing_tree_directory_is_named", async () => {
  const { impl } = fakeServer();
  const tree = "/nonexistent/cove-spotlight-tree";
  await assert.rejects(client(impl).spotlight.on("box", { tree, dest: "/srv/app" }), (err) => {
    assert.ok(err instanceof CoveError);
    assert.equal(err.message, `git rev-parse failed: the tree directory ${tree} does not exist`);
    return true;
  });
});

test("unit_spotlight_status_reads_the_tags", async () => {
  const bound = fakeServer({ tags: { "spotlight.base": "abc", "spotlight.dest": "/srv/app", "spotlight.source": "feat", other: "x" } });
  assert.deepEqual(await client(bound.impl).spotlight.status("box"), { dest: "/srv/app", base: "abc", source: "feat" });
  const unbound = fakeServer({ tags: { other: "x" } });
  assert.equal(await client(unbound.impl).spotlight.status("box"), null);
});

test("unit_spotlight_off_restores_the_base_and_deletes_the_tags", async (t) => {
  const dir = makeRepo(t);
  const base = git(dir, "rev-parse", "HEAD");
  const { calls, impl, state } = fakeServer({ tags: { "spotlight.base": base, "spotlight.dest": "/srv/app", "spotlight.source": "feat" } });
  const out = await client(impl).spotlight.off("box", { tree: dir });
  assert.deepEqual(out, { vm: "box", dest: "/srv/app", restored: base });
  const exec = calls.find((c) => c.command);
  assert.equal(exec.command[6], "/srv/app");
  // The upload is the committed tree: gone.txt is in it, untracked.txt is not.
  const upload = calls.find((c) => c.method === "PUT" && c.path.endsWith("/files"));
  const { gunzipSync } = await import("node:zlib");
  const paths = readTar(gunzipSync(upload.body)).map((e) => e.path);
  assert.ok(paths.includes("gone.txt") && !paths.includes("untracked.txt"), paths.join(","));
  const execAt = calls.indexOf(exec);
  assert.ok(calls.findIndex((c) => c.method === "DELETE") > execAt, "the tags go after the restore");
  assert.deepEqual(tagWrites(calls), ["DELETE spotlight.base", "DELETE spotlight.source", "DELETE spotlight.dest"]);
  assert.equal(state.size, 0);
});

test("unit_spotlight_off_with_a_missing_base_commit_says_to_fetch_and_changes_nothing", async (t) => {
  const dir = makeRepo(t);
  const missing = "0123456789abcdef0123456789abcdef01234567";
  const { calls, impl } = fakeServer({ tags: { "spotlight.base": missing, "spotlight.dest": "/srv/app" } });
  await assert.rejects(client(impl).spotlight.off("box", { tree: dir }), (err) => {
    assert.ok(err instanceof CoveError);
    assert.equal(err.message, `restore commit ${missing} not present locally — run \`git fetch\``);
    return true;
  });
  assert.ok(!calls.some((c) => c.method !== "GET"), "nothing written");
});

test("unit_spotlight_off_with_no_binding_is_a_no_op_that_answers_null", async (t) => {
  const dir = makeRepo(t);
  const { calls, impl } = fakeServer();
  assert.equal(await client(impl).spotlight.off("box", { tree: dir }), null);
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
});

test("unit_the_python_sdk_carries_the_same_apply_script", () => {
  const py = readFileSync(join(repoRoot, "sdk/python/src/cove_sdk/_spotlight.py"), "utf8");
  const m = /^APPLY_SCRIPT = r"""\\?\n([\s\S]*?)"""$/m.exec(py);
  assert.ok(m, "APPLY_SCRIPT found in _spotlight.py");
  assert.equal(m[1].replace(/\n$/, ""), SPOTLIGHT_APPLY_SCRIPT);
});

// ---------------------------------------------------------------------------
// The apply script, run by /bin/sh on this machine
// ---------------------------------------------------------------------------

/** The first directory on PATH holding an executable `name`. */
function which(name) {
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    const p = join(d, name);
    if (d && existsSync(p)) return p;
  }
  return undefined;
}

/** A PATH directory with just the tools the fallback path needs, and no rsync. */
function pathWithoutRsync(t) {
  const bin = join(tempDir(t), "bin");
  mkdirSync(bin);
  for (const tool of ["sh", "tar", "gzip", "find", "cat", "wc", "rm", "rmdir", "mkdir", "cp", "printf", "echo"]) {
    const at = which(tool);
    if (at) symlinkSync(at, join(bin, tool));
  }
  return bin;
}

function runScript(t, { withRsync }) {
  const work = tempDir(t);
  const dest = join(work, "app");
  // The VM's dest before the switch.
  for (const [p, body] of Object.entries({
    "keep.txt": "old\n",
    "stale.txt": "stale\n",
    "olddir/x.txt": "old dir\n",
    "node_modules/x": "installed\n",
    // A .gitignore under a protected path: the fallback does not refuse for it.
    "node_modules/pkg/.gitignore": "*.tmp\n",
    "web/node_modules/y": "nested install\n",
    ".env": "SECRET=1\n",
    "sub/.env": "SECRET=2\n",
    "--delete": "stale, named like an option\n",
    "volumes/db": "VM-only data\n",
  })) {
    mkdirSync(join(dest, p, ".."), { recursive: true });
    writeFileSync(join(dest, p), body);
  }
  // The tree: same-size edit of keep.txt, a new executable, a symlink, and a tracked .env and
  // volumes/seed under protected paths, which land (protect only stops deletion, as in the CLI).
  const tgz = join(work, "t.tgz");
  writeFileSync(
    tgz,
    gzipSync(
      writeTar([
        { kind: "file", path: "keep.txt", mode: 0o644, data: new TextEncoder().encode("new\n") },
        { kind: "file", path: "bin/run", mode: 0o755, data: new TextEncoder().encode("#!/bin/sh\n") },
        { kind: "symlink", path: "latest", mode: 0o777, target: "keep.txt" },
        { kind: "file", path: ".env", mode: 0o644, data: new TextEncoder().encode("FROM_TREE=1\n") },
        // File names that read as options to rm, cp, tar or rsync if a path were ever unprefixed.
        { kind: "file", path: "-rf", mode: 0o644, data: new TextEncoder().encode("plain\n") },
        { kind: "file", path: "--checksum", mode: 0o644, data: new TextEncoder().encode("plain\n") },
        { kind: "file", path: "volumes/seed", mode: 0o644, data: new TextEncoder().encode("tracked\n") },
      ]),
    ),
  );
  const stage = `${dest}.cove-stage-test`;
  const env = { ...process.env, PATH: withRsync ? process.env.PATH : pathWithoutRsync(t) };
  const run = spawnSync("/bin/sh", ["-c", SPOTLIGHT_APPLY_SCRIPT, "sh", tgz, stage, dest, "node_modules/", ".env", "volumes/"], {
    encoding: "utf8",
    env,
  });
  return { run, dest, tgz, stage };
}

for (const withRsync of [true, false]) {
  test(`component_spotlight_apply_script_mirrors_with_delete_and_protect_${withRsync ? "rsync" : "sh_fallback"}`, (t) => {
    if (withRsync && !which("rsync")) return t.skip("rsync is not installed here");
    const { run, dest, tgz, stage } = runScript(t, { withRsync });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").pop()), { files: 7, bytes: 4 + 10 + 12 + 6 + 6 + 8 });
    const read = (p) => readFileSync(join(dest, p), "utf8");
    // Option-shaped names land as plain files, and the stale one is deleted like any other.
    assert.equal(read("-rf"), "plain\n");
    assert.equal(read("--checksum"), "plain\n");
    assert.ok(!existsSync(join(dest, "--delete")), "--delete removed");
    assert.equal(read("keep.txt"), "new\n");
    assert.equal(lstatSync(join(dest, "bin/run")).mode & 0o777, 0o755);
    assert.equal(readlinkSync(join(dest, "latest")), "keep.txt");
    // Delete semantics: what the tree lacks is gone.
    assert.ok(!existsSync(join(dest, "stale.txt")), "stale.txt removed");
    assert.ok(!existsSync(join(dest, "olddir")), "olddir removed");
    // Protect: nothing the VM alone has under a protected path is deleted, at any depth, even in
    // a directory the tree also holds; a file the tree holds there is written.
    assert.equal(read("node_modules/x"), "installed\n");
    assert.equal(read("web/node_modules/y"), "nested install\n");
    assert.equal(read(".env"), "FROM_TREE=1\n");
    assert.equal(read("sub/.env"), "SECRET=2\n");
    assert.equal(read("volumes/seed"), "tracked\n");
    assert.equal(read("volumes/db"), "VM-only data\n");
    // The stage and the tarball are cleaned up.
    assert.ok(!existsSync(stage) && !existsSync(tgz));
  });
}

test("component_spotlight_apply_script_refuses_dot_components_and_a_stray_stage_touching_nothing", (t) => {
  const work = tempDir(t);
  const dest = join(work, "app");
  mkdirSync(dest);
  writeFileSync(join(dest, "keep"), "kept\n");
  const tgz = join(work, "t.tgz");
  writeFileSync(tgz, gzipSync(writeTar([])));
  const cases = [
    [`${dest}/.`, `${dest}/..cove-stage-x`],
    ["/.", "/..cove-stage-x"],
    ["//", "//.cove-stage-x"],
    [`${work}/../app`, `${work}/../app.cove-stage-x`],
    [`${work}//app`, `${work}//app.cove-stage-x`],
    [dest, join(work, "elsewhere.cove-stage-x")],
    [dest, `${dest}.cove-stage-`],
    // A trailing slash would put the stage inside dest.
    [`${dest}/`, `${dest}/.cove-stage-x`],
  ];
  for (const [d, stage] of cases) {
    const run = spawnSync("/bin/sh", ["-c", SPOTLIGHT_APPLY_SCRIPT, "sh", tgz, stage, d], { encoding: "utf8" });
    assert.equal(run.status, 2, `${d} ${stage}: ${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /^spotlight: (dest must not end in \/|stage must be)/, d);
    assert.ok(!existsSync(stage), `${stage} created`);
  }
  // Nothing touched: dest, its file and the tarball are all still there.
  assert.equal(readFileSync(join(dest, "keep"), "utf8"), "kept\n");
  assert.ok(existsSync(tgz));
});

test("component_spotlight_apply_script_refuses_a_relative_dest", (t) => {
  const { run } = (() => {
    const work = tempDir(t);
    const tgz = join(work, "t.tgz");
    writeFileSync(tgz, gzipSync(writeTar([])));
    return { run: spawnSync("/bin/sh", ["-c", SPOTLIGHT_APPLY_SCRIPT, "sh", tgz, join(work, "s"), "rel/dest"], { encoding: "utf8" }) };
  })();
  assert.equal(run.status, 2);
  assert.match(run.stderr, /dest must be an absolute path/);
});

/** Write `files` (path to body) under `root`. */
function writeTree(root, files) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), body);
  }
}

/** Every file under `root`, as path to body, to compare a dest before and after. */
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
      const p = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else out[p] = readFileSync(join(root, p), "utf8");
    }
  };
  walk("");
  return out;
}

const IGNORE = "dist/\n*.log\n.env.local\n";

/** A dest holding a .gitignore and the files it ignores, a tarball of the tree, and the run. */
function runGitignored(t, { withRsync, gitignore = true }) {
  const work = tempDir(t);
  const dest = join(work, "app");
  writeTree(dest, {
    ...(gitignore ? { ".gitignore": IGNORE } : {}),
    "dist/bundle.js": "built on the box\n",
    "debug.log": "box log\n",
    ".env.local": "BOX=1\n",
    "stale.txt": "tracked once, gone from the tree\n",
  });
  const tgz = join(work, "t.tgz");
  const file = (path, body) => ({ kind: "file", path, mode: 0o644, data: new TextEncoder().encode(body) });
  writeFileSync(tgz, gzipSync(writeTar([file(".gitignore", IGNORE), file("src.txt", "source\n")])));
  const before = snapshot(dest);
  const stage = `${dest}.cove-stage-test`;
  const env = { ...process.env, PATH: withRsync ? process.env.PATH : pathWithoutRsync(t) };
  const run = spawnSync("/bin/sh", ["-c", SPOTLIGHT_APPLY_SCRIPT, "sh", tgz, stage, dest, ...SPOTLIGHT_DEFAULT_PROTECT, ".git/"], {
    encoding: "utf8",
    env,
  });
  return { run, dest, before, stage };
}

test("component_spotlight_apply_script_with_rsync_keeps_what_dest_gitignore_ignores", (t) => {
  if (!which("rsync")) return t.skip("rsync is not installed here");
  const { run, dest } = runGitignored(t, { withRsync: true });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  // As the CLI's rsync does: the box's ignored files survive, the stale tracked-looking one goes.
  assert.deepEqual(snapshot(dest), {
    ".gitignore": IGNORE,
    "dist/bundle.js": "built on the box\n",
    "debug.log": "box log\n",
    ".env.local": "BOX=1\n",
    "src.txt": "source\n",
  });
});

test("component_spotlight_apply_script_without_rsync_refuses_a_dest_with_a_gitignore_touching_nothing", (t) => {
  const { run, dest, before, stage } = runGitignored(t, { withRsync: false });
  assert.equal(run.status, 3, run.stdout + run.stderr);
  assert.match(run.stderr, /^spotlight: rsync is not installed on the VM, and .* holds \.\/\.gitignore: .*Install rsync on the VM/);
  assert.deepEqual(snapshot(dest), before);
  assert.ok(!existsSync(stage));
});

test("component_spotlight_apply_script_without_rsync_and_no_gitignore_mirrors_as_before", (t) => {
  const { run, dest } = runGitignored(t, { withRsync: false, gitignore: false });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  // Nothing tells the fallback what is ignored, so everything the tree lacks goes.
  assert.deepEqual(snapshot(dest), { ".gitignore": IGNORE, "src.txt": "source\n" });
});

test("component_spotlight_apply_script_clears_debris_of_a_run_killed_at_its_deadline", (t) => {
  const work = tempDir(t);
  const dest = join(work, "app");
  writeTree(work, {
    "app/kept.txt": "x\n",
    "app.cove-stage-0123abcd/half/copied.txt": "debris\n",
    "app-other/kept.txt": "a neighbour\n",
    "cove-spotlight-old.tgz": "an old tarball\n",
    "cove-spotlight-fresh.tgz": "another run's tarball, in flight\n",
  });
  const hoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  utimesSync(join(work, "cove-spotlight-old.tgz"), hoursAgo, hoursAgo);
  const tgz = join(work, "cove-spotlight-cur.tgz");
  writeFileSync(tgz, gzipSync(writeTar([{ kind: "file", path: "kept.txt", mode: 0o644, data: new TextEncoder().encode("x\n") }])));
  const stage = `${dest}.cove-stage-cur`;
  const run = spawnSync("/bin/sh", ["-c", SPOTLIGHT_APPLY_SCRIPT, "sh", tgz, stage, dest, ".git/"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.ok(!existsSync(join(work, "app.cove-stage-0123abcd")), "the stale stage is removed");
  assert.ok(!existsSync(join(work, "cove-spotlight-old.tgz")), "the stale tarball is removed");
  assert.ok(existsSync(join(work, "cove-spotlight-fresh.tgz")), "a tarball under an hour old is kept");
  assert.equal(readFileSync(join(work, "app-other/kept.txt"), "utf8"), "a neighbour\n");
  assert.ok(!existsSync(stage) && !existsSync(tgz));
});

test("component_spotlight_apply_script_with_rsync_never_deletes_dest_git_even_unprotected", (t) => {
  if (!which("rsync")) return t.skip("rsync is not installed here");
  const work = tempDir(t);
  const dest = join(work, "app");
  writeTree(dest, { ".git/HEAD": "ref: refs/heads/main\n", "stale.txt": "gone\n" });
  const tgz = join(work, "t.tgz");
  writeFileSync(tgz, gzipSync(writeTar([])));
  // No protect entries at all: the CLI's own --exclude=.git/ is what keeps it.
  const run = spawnSync("/bin/sh", ["-c", SPOTLIGHT_APPLY_SCRIPT, "sh", tgz, `${dest}.cove-stage-x`, dest], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(snapshot(dest), { ".git/HEAD": "ref: refs/heads/main\n" });
});
