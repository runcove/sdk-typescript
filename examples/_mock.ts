/**
 * An in-memory fake Cove server for the use-case examples' `--mock` mode.
 *
 * Pass `fetch: mockFetch()` to `new CoveClient(...)`: no network, no mocking framework. It
 * serves just the routes the examples call, and runs their guest commands against a tiny
 * fake guest per VM: a map of files, a few programs (`cat`, `curl` to the guest's own web
 * servers, `git clone`, `git -C <dir> add -A`, `git -C <dir> diff --cached --output=<file>`,
 * `make`, `python3 -m unittest`), and a small shell that runs `sh -c` or `bash -lc` scripts
 * made of `&&`-joined steps, or a script file one line per step, that it knows (`find`,
 * `test -r`, `test -s`, `printf`, `echo`, `mkdir`, `cd`, `exit`, `sleep`, a web server started
 * in the background, and a stand-in for `claude -p` that needs `ANTHROPIC_API_KEY` in its
 * environment and knows one edit). A command it does not know fails, so a wrong path or command
 * in an example fails its `--mock` run. Secrets land where the real guest puts them: in a
 * directory under `/run/cove/secrets/` whose random name the fake guest picks once, as the guest
 * agent does when it starts, for the one command that injects them or when `rotate` pushes a
 * file secret; or, for `exposure: env` with `target_unit: @login`, as an `export` line in
 * `/run/cove/login-env.sh`, which only a login shell (`bash -lc`) reads. A command whose argv
 * holds a stored secret's value is refused (400), so an example that puts a key on a command
 * line fails; the real server does not check this, so it is a test of the examples, not a
 * guarantee of the server. Also a template for stubbing the SDK in your own tests: any
 * `fetch`-shaped function will do. It also serves `vms.files` (upload, download, stat): an
 * upload needs its directory to exist, as on the real server, so an example makes it first
 * with `mkdir -p`.
 *
 * Each VM has a state the routes move it through as the server does, and refuse from the
 * states the server refuses (409): a command or file transfer needs a running VM; a
 * checkpoint or a clone needs a running or paused one; a disk-only checkpoint wakes only a
 * stopped VM and cannot be cloned; a full one wakes only a hibernated VM. A checkpoint keeps
 * a copy of the guest's files, so waking from it or cloning it brings them back, and one a
 * live clone was made from cannot be deleted (409). Tags filter the VM list, ports must be in the server's default allowed list, and a port's URL has the
 * server's shape. It serves a VM's tags too (the same tags the list filters on), and runs
 * `client.spotlight`'s apply script for real in effect: it extracts the uploaded tarball and
 * mirrors it onto the destination with delete semantics and the protect entries the script was
 * given, so a wrong destination or protect list fails the spotlight example.
 * `sdk/python/examples/_mock.py` is the same fake for the Python examples.
 */

import { gunzipSync } from "node:zlib";

type GuestResult = { stdout: string; stderr: string; code: number; timedOut?: number };
type Files = Map<string, string>;
type Dirs = Set<string>;
/**
 * A git work tree in the fake guest, by its directory: `head` is the files as cloned, `index`
 * what `git add -A` last staged (null until then), both keyed by their path in the tree.
 */
type Repo = { head: Files; index: Files | null };
/** Each uploaded file's raw bytes, beside its text in `Files` (a tarball is not text). */
type Blobs = Map<string, Uint8Array>;
/**
 * One fake guest: its file system (with each upload's raw bytes), the web servers running in it
 * (port to directory), and its git work trees.
 */
type Guest = { files: Files; dirs: Dirs; blobs: Blobs; serving: Map<number, string>; repos: Map<string, Repo> };

const ok = (stdout = "", stderr = ""): GuestResult => ({ stdout, stderr, code: 0 });
const fail = (stderr: string, code = 1): GuestResult => ({ stdout: "", stderr, code });

const isPrime = (n: number) => {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
  return true;
};

/**
 * `sh -c <script> <$0> <$1>...`, `bash -lc` (the same, in a login shell), or `sh <file>`. Two
 * scripts are too much for this shell (an awk program), so they are recognised by the files they
 * read and write and computed here instead. `deadline` is the exec's `timeout_secs`: a `sleep`
 * past it times the command out. `env` is the environment the shell starts with: a login shell's
 * holds what `/run/cove/login-env.sh` exports, a plain `sh -c`'s nothing.
 */
function runShell(script: string, args: string[], guest: Guest, deadline: number, env: Map<string, string> = new Map()): GuestResult {
  if (script.startsWith("# cove spotlight apply v2")) return spotlightApply(args, guest);
  const { files, dirs } = guest;
  if (script.includes("cat /root/in/*.csv") && script.includes("> /root/out/totals.csv")) {
    const totals = new Map<string, number>();
    for (const [path, text] of files) {
      if (!/^\/root\/in\/[^/]+\.csv$/.test(path)) continue;
      for (const row of text.split("\n").filter(Boolean)) {
        const [item = "", qty = "0"] = row.split(",");
        totals.set(item, (totals.get(item) ?? 0) + Number(qty));
      }
    }
    const rows = [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k},${v}\n`);
    files.set("/root/out/totals.csv", rows.join(""));
    return ok();
  }
  if (script.startsWith('seq "$1" "$2" | awk')) {
    let count = 0;
    for (let n = Number(args[0]); n <= Number(args[1]); n++) if (isPrime(n)) count++;
    return ok(`${count}\n`);
  }

  const vars = new Map<string, string>();
  const word = (w: string): string => {
    const quoted = /^"(.*)"$/.exec(w) ?? /^'(.*)'$/.exec(w);
    const inner = quoted ? quoted[1]! : w;
    if (w.startsWith("'")) return inner;
    return inner.replace(/\$(\d|\w+)/g, (_, v: string) => (/^\d$/.test(v) ? (args[Number(v) - 1] ?? "") : (vars.get(v) ?? env.get(v) ?? "")));
  };
  let stdout = "";
  let cwd = "/root";
  // A script file runs one line per step; blank lines and comments are skipped.
  const steps = script.includes("\n") ? script.split("\n") : script.split(" && ");
  for (const step of steps.map((s) => s.trim()).filter((s) => s !== "" && !s.startsWith("#"))) {
    let m: RegExpExecArray | null;
    if ((m = /^(\w+)=\$\(find (\S+) -name (\S+) -type f \| head -n 1\)$/.exec(step))) {
      const [, name = "", dir = "", file = ""] = m;
      vars.set(name, [...files.keys()].sort().find((p) => p.startsWith(`${dir}/`) && p.endsWith(`/${file}`)) ?? "");
    } else if ((m = /^test -r (\S+)$/.exec(step))) {
      if (!files.has(word(m[1]!))) return { stdout, stderr: "", code: 1 };
    } else if ((m = /^test -s (\S+)$/.exec(step))) {
      if (!files.get(word(m[1]!))) return { stdout, stderr: "", code: 1 };
    } else if (/^mkdir -p /.test(step)) {
      addDirs(dirs, word(step.slice("mkdir -p ".length)));
    } else if ((m = /^printf %s (\S+) > (\S+)$/.exec(step))) {
      files.set(word(m[2]!), word(m[1]!));
    } else if ((m = /^echo (.+?)(?: \| tee (\S+))?$/.exec(step))) {
      const line = `${word(m[1]!)}\n`;
      if (m[2]) files.set(word(m[2]), line);
      stdout += line;
    } else if ((m = /^exit (\d+)$/.exec(step))) {
      return { stdout, stderr: "", code: Number(m[1]) };
    } else if ((m = /^sleep (\d+)$/.exec(step))) {
      if (Number(m[1]) > deadline) return { stdout, stderr: "", code: -1, timedOut: deadline };
    } else if ((m = /^cd (\S+)$/.exec(step))) {
      if (!dirs.has(word(m[1]!))) return { stdout, stderr: `sh: cd: ${word(m[1]!)}: No such file or directory\n`, code: 1 };
      cwd = word(m[1]!);
    } else if ((m = /^claude -p (\S+) --permission-mode acceptEdits$/.exec(step))) {
      const run = fakeClaude(word(m[1]!), cwd, env, guest);
      stdout += run.stdout;
      if (run.code !== 0) return { ...run, stdout };
    } else if ((m = /^setsid -f python3 -m http\.server (\S+) --directory (\S+) > (\S+) 2>&1$/.exec(step))) {
      // Starts in the background and answers at once, as `setsid -f` does.
      guest.serving.set(Number(word(m[1]!)), word(m[2]!));
      files.set(word(m[3]!), "");
    } else {
      return { stdout, stderr: `sh: the fake guest cannot run: ${step}\n`, code: 127 };
    }
  }
  return ok(stdout);
}

/** Mark `dir` and every directory above it as existing. */
function addDirs(dirs: Dirs, dir: string): void {
  for (let at = dir; at !== ""; at = at.slice(0, at.lastIndexOf("/"))) dirs.add(at);
}

/**
 * The regular files and symlinks of a tar archive (ustar, with pax headers for long names), as
 * path -> [text, size]; a symlink's text is its target, as the fake guest has no links.
 */
function untar(archive: Uint8Array): Map<string, [string, number]> {
  const out = new Map<string, [string, number]>();
  const dec = new TextDecoder();
  const field = (h: Uint8Array, at: number, n: number) => dec.decode(h.subarray(at, at + n)).replace(/\0.*$/s, "");
  let pax = new Map<string, string>();
  for (let at = 0; at + 512 <= archive.length; ) {
    const h = archive.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(field(h, 124, 12).trim() || "0", 8);
    const type = field(h, 156, 1) || "0";
    const data = archive.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = new Map(dec.decode(data).split("\n").filter(Boolean).map((r) => r.slice(r.indexOf(" ") + 1).split(/=(.*)/s).slice(0, 2) as [string, string]));
      continue;
    }
    const prefix = field(h, 345, 155);
    const path = pax.get("path") ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    if (type === "0") out.set(path, [dec.decode(data), size]);
    if (type === "2") out.set(path, [pax.get("linkpath") ?? field(h, 157, 100), 0]);
    pax = new Map();
  }
  return out;
}

/**
 * Is `rel` (a path under the destination) kept by one of `protect`, rsync protect patterns: a bare
 * name matches at any depth, a trailing `/` matches a directory only, a leading `/` anchors;
 * everything below a match is kept too.
 */
function isProtected(rel: string, protect: string[]): boolean {
  const parts = rel.split("/");
  return protect.some((entry) => {
    const dirOnly = entry.endsWith("/");
    const anchored = entry.startsWith("/");
    const pat = entry.replace(/^\/|\/$/g, "").split("/");
    for (let end = pat.length; end <= parts.length; end++) {
      if (anchored && end !== pat.length) break;
      // A file is not a directory: a dir-only pattern matches only a component above it.
      if (dirOnly && end === parts.length) break;
      if (pat.every((p, i) => p === parts[end - pat.length + i])) return true;
    }
    return false;
  });
}

/** `client.spotlight`'s apply script, `sh -c SCRIPT sh TARBALL STAGE DEST [PROTECT...]`, in effect. */
function spotlightApply(args: string[], guest: Guest): GuestResult {
  const { files, dirs, blobs } = guest;
  const [tgz = "", stage = "", dest = "", ...protect] = args;
  if (!/^\/./.test(dest)) return fail(`spotlight: dest must be an absolute path other than /, got: ${dest}\n`, 2);
  if (dest.includes("//") || dest.endsWith("/") || dest.split("/").some((c) => c === "." || c === "..")) {
    return fail(`spotlight: dest must not end in / or hold an empty, . or .. component, got: ${dest}\n`, 2);
  }
  if (!stage.startsWith(`${dest}.cove-stage-`)) return fail(`the fake guest expects the stage beside dest, got ${stage}\n`, 2);
  const blob = blobs.get(tgz);
  if (!blob) return fail(`tar: ${tgz}: Cannot open: No such file or directory\n`, 2);
  const tree = untar(gunzipSync(blob));
  for (const path of [...files.keys()]) {
    if (!path.startsWith(`${dest}/`)) continue;
    const rel = path.slice(dest.length + 1);
    if (!tree.has(rel) && !isProtected(rel, protect)) files.delete(path);
  }
  let bytes = 0;
  for (const [rel, [text, size]] of tree) {
    bytes += size;
    // Protect only keeps paths from deletion: the tree's own files are all written.
    files.set(`${dest}/${rel}`, text);
    addDirs(dirs, `${dest}/${rel}`.slice(0, `${dest}/${rel}`.lastIndexOf("/")));
  }
  files.delete(tgz);
  blobs.delete(tgz);
  return ok(`${JSON.stringify({ files: tree.size, bytes })}\n`);
}

// What `git clone` puts in the destination: a Makefile, and a small Python module whose
// lowercasing is missing, with its unit test.
const CLONED: Record<string, string> = {
  Makefile: "build:\n\t@echo build done\ntest:\n\t@echo all tests passed\n",
  "index.html": "<h1>demo</h1>\n",
  "slugify.py": 'def slugify(title):\n    return "-".join(title.split())\n',
  "test_slugify.py": "import unittest\nfrom slugify import slugify\n",
};

/** The files under `dir`, keyed by their path below it. */
function treeOf(files: Files, dir: string): Files {
  const tree: Files = new Map();
  for (const [path, text] of files) if (path.startsWith(`${dir}/`)) tree.set(path.slice(dir.length + 1), text);
  return tree;
}

/**
 * `git diff` between two trees, in git's format with the whole of each small file as context
 * (git's own three lines of context cover these files whole), but without the `index` lines,
 * which name blob hashes the fake does not compute.
 */
function unifiedDiff(from: Files, to: Files): string {
  const lines = (text: string | undefined) => (text === undefined ? [] : text.replace(/\n$/, "").split("\n"));
  const range = (n: number) => (n === 0 ? "0,0" : n === 1 ? "1" : `1,${n}`);
  let out = "";
  for (const path of [...new Set([...from.keys(), ...to.keys()])].sort()) {
    const a = from.get(path);
    const b = to.get(path);
    if (a === b) continue;
    const old = lines(a);
    const neu = lines(b);
    let pre = 0;
    while (pre < old.length && pre < neu.length && old[pre] === neu[pre]) pre++;
    let suf = 0;
    while (suf < old.length - pre && suf < neu.length - pre && old[old.length - 1 - suf] === neu[neu.length - 1 - suf]) suf++;
    out += `diff --git a/${path} b/${path}\n`;
    if (a === undefined) out += "new file mode 100644\n";
    if (b === undefined) out += "deleted file mode 100644\n";
    out += `--- ${a === undefined ? "/dev/null" : `a/${path}`}\n+++ ${b === undefined ? "/dev/null" : `b/${path}`}\n`;
    out += `@@ -${range(old.length)} +${range(neu.length)} @@\n`;
    for (const l of old.slice(0, pre)) out += ` ${l}\n`;
    for (const l of old.slice(pre, old.length - suf)) out += `-${l}\n`;
    for (const l of neu.slice(pre, neu.length - suf)) out += `+${l}\n`;
    for (const l of old.slice(old.length - suf)) out += ` ${l}\n`;
  }
  return out;
}

// The test the fake coding agent adds.
const LOWERCASE_TEST =
  'import unittest\nfrom slugify import slugify\n\n\nclass TestLowercase(unittest.TestCase):\n    def test_lowercases(self):\n        self.assertEqual(slugify("Hello World"), "hello-world")\n';

/**
 * `claude -p <prompt> --permission-mode acceptEdits`, run in `cwd`. It needs `ANTHROPIC_API_KEY`
 * in its environment, as the real one does, and knows one edit: asked to lowercase, it makes
 * `slugify()` lowercase the title and adds a test for it. Any other prompt changes nothing.
 */
function fakeClaude(prompt: string, cwd: string, env: Map<string, string>, guest: Guest): GuestResult {
  if (!env.get("ANTHROPIC_API_KEY")) return fail("Invalid API key · Please run /login\n");
  const source = guest.files.get(`${cwd}/slugify.py`);
  if (!/lowercase/i.test(prompt) || source === undefined) {
    return ok("Nothing in this repository matches the task, so I changed no files.\n");
  }
  guest.files.set(`${cwd}/slugify.py`, source.replace("title.split()", "title.lower().split()"));
  guest.files.set(`${cwd}/test_lowercase.py`, LOWERCASE_TEST);
  return ok("slugify() now lowercases the title, and test_lowercase.py tests it.\n");
}

/** What a login shell's profile exports: the `export NAME='value'` lines of the `@login` env file. */
function loginEnv(files: Files): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of (files.get(LOGIN_ENV) ?? "").split("\n")) {
    const m = /^export (\w+)='(.*)'$/.exec(line);
    if (m) env.set(m[1]!, m[2]!.replaceAll("'\\''", "'"));
  }
  return env;
}

/** One exec in the fake guest. */
function runInGuest(command: string[], guest: Guest, deadline: number): GuestResult {
  const { files, dirs } = guest;
  const [program = "", ...rest] = command;
  if (program === "sh" && rest[0] === "-c") return runShell(rest[1] ?? "", rest.slice(3), guest, deadline);
  // A login shell reads the profile, which sources the `@login` env file if there is one.
  if (program === "bash" && rest[0] === "-lc") return runShell(rest[1] ?? "", rest.slice(3), guest, deadline, loginEnv(files));
  if (program === "sh" && rest.length === 1) {
    const script = files.get(rest[0]!);
    if (script === undefined) return fail(`sh: 0: cannot open ${rest[0]}: No such file\n`, 2);
    return runShell(`${script}\n`, [], guest, deadline);
  }
  if (program === "curl") {
    // `curl -fsS [--retry N --retry-delay N --retry-connrefused] -o /dev/null <url>`, against the guest's own
    // web servers.
    const m = /^-fsS (?:--retry \d+ (?:--retry-delay \d+ )?--retry-connrefused )?-o \/dev\/null (\S+)$/.exec(rest.join(" "));
    if (!m) return fail(`curl: the fake guest cannot run: curl ${rest.join(" ")}\n`, 2);
    const url = /^http:\/\/127\.0\.0\.1:(\d+)\/$/.exec(m[1]!);
    const dir = url ? guest.serving.get(Number(url[1])) : undefined;
    if (dir === undefined) return fail(`curl: (7) Failed to connect to ${m[1]}\n`, 7);
    if (!dirs.has(dir)) return fail("curl: (22) The requested URL returned error: 404\n", 22);
    return ok();
  }
  if (program === "mkdir" && rest[0] === "-p" && rest.length === 2) {
    addDirs(dirs, rest[1]!);
    return ok();
  }
  if (program === "cat") {
    const text = files.get(rest[0] ?? "");
    return text === undefined ? fail(`cat: ${rest[0]}: No such file or directory\n`) : ok(text);
  }
  if (program === "python3" && rest.join(" ").startsWith("-m unittest discover -s ")) {
    const dir = rest[4] ?? "";
    if (!files.has(`${dir}/test_slugify.py`)) return fail("\nRan 0 tests\n\nNO TESTS RAN\n", 5);
    return files.get(`${dir}/slugify.py`)?.includes(".lower()")
      ? ok("", "..\nRan 2 tests\n\nOK\n")
      : fail("F.\nFAIL: test_lowercases\nRan 2 tests\n\nFAILED (failures=1)\n");
  }
  if (program === "git" && rest[0] === "clone") {
    const dest = rest.at(-1) ?? "";
    addDirs(dirs, dest);
    for (const [file, text] of Object.entries(CLONED)) files.set(`${dest}/${file}`, text);
    guest.repos.set(dest, { head: treeOf(files, dest), index: null });
    return ok("", `Cloning into '${dest}'...\n`);
  }
  if (program === "git" && rest[0] === "-C") {
    // `git -C <dir> add -A` stages the whole tree; `git -C <dir> diff --cached --output=<file>`
    // writes what is staged against HEAD (nothing, before an add).
    const [, dir = "", ...args] = rest;
    const repo = guest.repos.get(dir);
    if (!repo) return fail("fatal: not a git repository (or any of the parent directories): .git\n", 128);
    if (args.join(" ") === "add -A") {
      repo.index = treeOf(files, dir);
      return ok();
    }
    const out = /^diff --cached --output=(\S+)$/.exec(args.join(" "));
    if (out) {
      const file = out[1]!;
      if (!dirs.has(file.slice(0, file.lastIndexOf("/")) || "/")) return fail(`fatal: could not open '${file}' for writing: No such file or directory\n`, 128);
      files.set(file, unifiedDiff(repo.head, repo.index ?? repo.head));
      return ok();
    }
    return fail(`git: the fake guest cannot run: git ${rest.join(" ")}\n`, 129);
  }
  if (program === "make" && rest[0] === "-C" && (rest[2] === "test" || rest[2] === "build") && rest.length === 3) {
    if (!files.has(`${rest[1]}/Makefile`)) return fail(`make: *** ${rest[1]}: No such file or directory.  Stop.\n`, 2);
    return ok(rest[2] === "test" ? "all tests passed\n" : "build done\n");
  }
  return fail(`${program}: command not found in the fake guest\n`, 127);
}

/** One server-sent event. A chunk "a\nb\n" is three `data:` fields, the last one empty. */
const sse = (event: string, data: string) =>
  `event: ${event}\n${data.split("\n").map((line) => `data: ${line}\n`).join("")}\n`;

/** The guest agent's secrets directory: 16 random letters and digits, picked when it starts. */
/** Where the guest agent's `@login` env sink writes the exports every login shell sources. */
const LOGIN_ENV = "/run/cove/login-env.sh";

const secretsDir = () =>
  `/run/cove/secrets/${Array.from({ length: 16 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("")}`;

/** The server's default `[service.proxy] allowed_ports`. */
const ALLOWED_PORTS = [80, 443, 3000, 3001, 5173, 8000, 8080, 9000];
/** The primary port, the one with a portless URL: the server's default. */
const PRIMARY_PORT = 80;
const AT = "2026-10-01T00:00:00Z";

type Vm = Guest & {
  id: string;
  state: string;
  polls: number;
  tags: Record<string, string>;
  ports: number[];
  autoPause: unknown;
  ttl: { max_lifetime_secs?: number | null; on_stop?: unknown } | null;
  /** The checkpoint this VM was cloned from, if it is a clone. */
  cloneOf?: Checkpoint;
};
/** `clones`: the live VMs cloned from it. While there are any, it cannot be deleted. */
type Checkpoint = { id: string; vm: string; vmId: string; diskOnly: boolean; description: string | null; guest: Guest; clones: number };

/** A copy of a guest, for a checkpoint. A disk-only one keeps no running server. */
const copyGuest = (g: Guest, withMemory: boolean): Guest => ({
  files: new Map(g.files),
  dirs: new Set(g.dirs),
  blobs: new Map(g.blobs),
  serving: withMemory ? new Map(g.serving) : new Map(),
  repos: new Map([...g.repos].map(([dir, r]) => [dir, { head: new Map(r.head), index: r.index && new Map(r.index) }])),
});

export function mockFetch(): typeof fetch {
  const vms = new Map<string, Vm>();
  const checkpoints = new Map<string, Checkpoint>();
  const secrets = new Map<string, { value: string; setupTag: string | null }>();
  // A test of the examples, not the server's behaviour: a stored secret's value in a command's
  // argv is refused, so an example that passes a key on the command line fails its --mock run.
  const leaked = (command: string[]) =>
    [...secrets].find(([, s]) => s.value !== "" && command.some((arg) => arg.includes(s.value)))?.[0];
  const secretsRoot = secretsDir();
  let created = 0;
  let ids = 0;
  const nextId = (prefix: string) => `${prefix}-0000-7000-8000-${String(++ids).padStart(12, "0")}`;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const error = (status: number, code: string, message: string) => json({ code, message }, status);
  const invalidState = (name: string, vm: Vm, doing: string) =>
    error(409, "invalid_state_transition", `${name} is ${vm.state}: cannot ${doing}`);
  const stream = (body: string) =>
    new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  // The fields the contract requires of a VmDetail, plus the IP the examples print.
  const vmDetail = (name: string, vm: Vm) => ({
    auto_pause_policy: vm.autoPause,
    created_at: AT,
    disk_size_gb: 10,
    image: "fedora-43",
    ip_address: "10.99.0.7",
    mac_address: "02:00:00:00:00:01",
    memory_mb: 2048,
    name,
    state: vm.state,
    tags: vm.tags,
    updated_at: AT,
    vcpus: 2,
    vm_id: vm.id,
  });
  const checkpointBody = (c: Checkpoint) => ({
    id: c.id,
    vm_id: c.vmId,
    state: "available",
    owner_username: "demo",
    created_at: AT,
    completed_at: AT,
    description: c.description,
    disk_only: c.diskOnly,
    vm_name_at_creation: c.vm,
  });
  const newVm = (name: string, guest: Guest, state: string, fields: Partial<Vm> = {}): Vm => {
    const vm: Vm = {
      ...guest,
      id: nextId("0199a000"),
      state,
      polls: 0,
      tags: {},
      ports: [],
      autoPause: { type: "auto_pause", idle_timeout_secs: 600 },
      ttl: null,
      ...fields,
    };
    vms.set(name, vm);
    return vm;
  };

  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    // A file upload's body is the file, not JSON.
    const body = method !== "PUT" && typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const [, api, collection, name = "", action = "", key = "", sub = ""] = url.pathname.split("/");
    if (api !== "api") return error(404, "resource_not_found", `no mock route for ${url.pathname}`);

    if (collection === "checkpoints" && method === "DELETE" && name !== "") {
      const c = checkpoints.get(name);
      if (!c) return error(404, "vm_not_found", `VM '${name}' not found`);
      if (c.clones > 0) return error(409, "checkpoint_conflict", `checkpoint ${name} has ${c.clones} live clones`);
      checkpoints.delete(name);
      return new Response(null, { status: 204 });
    }
    if (collection !== "vms") return error(404, "resource_not_found", `no mock route for ${url.pathname}`);

    if (method === "POST" && name === "") {
      created += 1;
      const vmName: string = body.name ?? (created === 1 ? "demo-vm" : `demo-vm-${created}`);
      if (vms.has(vmName)) return error(409, "vm_name_taken", `${vmName} is taken`);
      const vm = newVm(vmName, { files: new Map(), dirs: new Set(["/root", "/tmp"]), blobs: new Map(), serving: new Map(), repos: new Map() }, "creating", {
        tags: { ...(body.initial_tags ?? {}) },
        ...(body.auto_pause_policy ? { autoPause: body.auto_pause_policy } : {}),
        ttl: body.ttl_policy ?? null,
      });
      return json({ name: vmName, vm_id: vm.id }, 202);
    }
    if (method === "GET" && name === "") {
      // `?tag=key=value`, repeatable, all must match.
      const wanted = url.searchParams.getAll("tag").map((t) => [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1)]);
      const rows = [...vms]
        .filter(([, vm]) => wanted.every(([k, v]) => vm.tags[k!] === v))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([n, vm]) => ({ name: n, state: vm.state, image: "fedora-43", tags: vm.tags }));
      return json({ vms: rows, next_cursor: null });
    }

    const vm = vms.get(name);
    if (!vm) return error(404, "vm_not_found", `no VM named ${name}`);
    const running = vm.state === "running";

    if (action === "files") {
      if (!running) return invalidState(name, vm, "transfer files");
      const path = url.searchParams.get("path") ?? "";
      if (method === "PUT") {
        const dir = path.slice(0, path.lastIndexOf("/")) || "/";
        if (!vm.dirs.has(dir)) return error(404, "file_not_found", `${dir}: no such directory`);
        const bytes = typeof init?.body === "string" ? new TextEncoder().encode(init.body) : (init?.body as Uint8Array);
        vm.files.set(path, new TextDecoder().decode(bytes));
        vm.blobs.set(path, bytes);
        return json({ path, size: bytes.byteLength, mode: 0o644, sha256: "0".repeat(64) });
      }
      const text = vm.files.get(path);
      if (text === undefined) return error(404, "file_not_found", `${path}: no such file`);
      const bytes = new TextEncoder().encode(text);
      const headers = { "Content-Length": String(bytes.byteLength), "X-Cove-File-Mode": "0644" };
      return new Response(method === "HEAD" ? null : bytes, { status: 200, headers });
    }
    if (action === "tags") {
      // The VM's own tags, the ones the list filters on and its detail shows.
      if (method === "GET" && key === "") {
        return json(Object.entries(vm.tags).sort().map(([k, value]) => ({ key: k, value, set_by: "mock", set_at: AT })));
      }
      if (method === "PUT") vm.tags[decodeURIComponent(key)] = JSON.parse(String(init?.body)).value;
      if (method === "DELETE") delete vm.tags[decodeURIComponent(key)];
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && action === "") {
      // A new VM is creating for two polls, then running; a stopping VM is stopped by the next.
      vm.polls += 1;
      if (vm.state === "creating" && vm.polls > 2) vm.state = "running";
      const seen = vmDetail(name, vm);
      if (vm.state === "stopping") vm.state = "stopped";
      return json(seen);
    }
    if (method === "DELETE" && action === "") {
      if (vm.cloneOf) vm.cloneOf.clones -= 1;
      vms.delete(name);
      return new Response(null, { status: 202 });
    }
    if (method === "GET" && action === "events") {
      // The stream ends on `running`, so the VM is running by the time a reader acts on it.
      vm.state = "running";
      return stream(
        sse("state", JSON.stringify({ state: "creating", timestamp: AT })) +
          sse("progress", JSON.stringify({ stage: "booting", message: "starting the guest" })) +
          sse("state", JSON.stringify({ state: "running", timestamp: AT })),
      );
    }
    if (method === "POST" && action === "stop") {
      if (!running && vm.state !== "paused") return invalidState(name, vm, "stop");
      vm.state = "stopping";
      vm.serving.clear();
      return new Response(null, { status: 202 });
    }
    if (method === "POST" && (action === "checkpoints" || action === "hibernate")) {
      if (!running && vm.state !== "paused") return invalidState(name, vm, action === "hibernate" ? "hibernate" : "checkpoint");
      const diskOnly = action === "checkpoints" && body.disk_only === true;
      const c: Checkpoint = {
        id: nextId("0199a001"),
        vm: name,
        vmId: vm.id,
        diskOnly,
        description: action === "checkpoints" ? (body.description ?? null) : null,
        guest: copyGuest(vm, !diskOnly),
        clones: 0,
      };
      checkpoints.set(c.id, c);
      if (action === "hibernate") {
        vm.state = "hibernated";
        vm.serving.clear();
      }
      return json(checkpointBody(c));
    }
    if (method === "POST" && action === "wake") {
      // A named checkpoint, or the VM's newest one.
      const own = [...checkpoints.values()].filter((c) => c.vmId === vm.id);
      // A checkpoint that does not exist is a 404; one that belongs to another VM is a 409, as
      // on the real server.
      const named = body.checkpoint_id ? checkpoints.get(body.checkpoint_id) : undefined;
      if (body.checkpoint_id && !named) return error(404, "wake_target_not_found", `not found: ${body.checkpoint_id}`);
      if (named && named.vmId !== vm.id) return invalidState(name, vm, "wake from a checkpoint of another VM");
      const c = named ?? own.at(-1);
      if (!c) return error(409, "invalid_state_transition", `no available checkpoint to wake ${name} from`);
      // Without an id, a stopped VM whose newest checkpoint is disk-only is refused: waking it
      // would roll the disk back without the checkpoint being named.
      if (!named && c.diskOnly && vm.state === "stopped") {
        return error(
          409,
          "disk_rollback_not_named",
          `${name} is stopped and its latest checkpoint ${c.id} is disk-only: start the VM (\`start_vm\`) to boot its current disk, or pass checkpoint_id ${c.id} to roll back`,
        );
      }
      // A disk-only checkpoint replaces a stopped VM's disk and boots it; a full one wakes a
      // hibernated VM with its memory.
      if (vm.state !== (c.diskOnly ? "stopped" : "hibernated")) return invalidState(name, vm, "wake from that checkpoint");
      Object.assign(vm, copyGuest(c.guest, !c.diskOnly));
      vm.state = "running";
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && action === "clone") {
      if (!running && vm.state !== "paused") return invalidState(name, vm, "clone");
      const target: string = body.new_vm_name;
      // The server's body: create's `vm_name_taken`, which carries the name.
      if (vms.has(target)) {
        return json({ code: "vm_name_taken", message: `name "${target}" is already taken`, name: target }, 409);
      }
      // A clone without a checkpoint id is made from an implicit checkpoint of the source now.
      let from: Checkpoint;
      if (body.source_checkpoint_id) {
        const c = checkpoints.get(body.source_checkpoint_id);
        if (!c) return error(404, "clone_source_not_found", `not found: ${body.source_checkpoint_id}`);
        if (c.vmId !== vm.id) return invalidState(name, vm, "clone from a checkpoint of another VM");
        if (c.diskOnly) return error(409, "invalid_state_transition", "a disk-only checkpoint cannot be cloned; stop the VM and wake it from this checkpoint");
        from = c;
      } else {
        from = { id: nextId("0199a001"), vm: name, vmId: vm.id, diskOnly: false, description: "pre_clone", guest: copyGuest(vm, true), clones: 0 };
        checkpoints.set(from.id, from);
      }
      from.clones += 1;
      const copy = newVm(target, copyGuest(from.guest, true), "running", { cloneOf: from });
      return json({ new_vm: vmDetail(target, copy), fingerprints: [] });
    }
    if (method === "POST" && action === "ports") {
      if (!ALLOWED_PORTS.includes(body.port)) {
        return json({ code: "port_not_allowed", message: `port ${body.port} is not allowed`, port: body.port, allowed: ALLOWED_PORTS }, 422);
      }
      if (!vm.ports.includes(body.port)) vm.ports.push(body.port);
      return new Response(null, { status: 201 });
    }
    if (method === "GET" && action === "url") {
      // The primary port's URL is portless; another port's is a subdomain of its own.
      const ports = vm.ports.map((port) => ({
        port,
        public: false,
        is_primary: port === PRIMARY_PORT,
        url: port === PRIMARY_PORT ? `https://${name}.cove.mock/` : `https://${name}-${port}.cove.mock/`,
      }));
      return json({ vm_name: name, ssh_url: `ssh://demo@cove.mock:2222/${name}`, ports });
    }
    if (method === "POST" && action === "access") {
      if (!["user", "team"].includes(body.subject_type) || !["user", "collaborator"].includes(body.role)) {
        return error(400, "validation_failed", "subject_type is user or team, role is user or collaborator");
      }
      return json({ user_known: true }, 201);
    }
    if (method === "GET" && action === "expiry") {
      const policy = { max_lifetime_secs: vm.ttl?.max_lifetime_secs ?? null, on_stop: vm.ttl?.on_stop ?? { type: "never" } };
      // The fake's clock never moves, so the whole lifetime is left.
      return json({ policy, max_life_expires_in_secs: policy.max_lifetime_secs, deletes_in_secs: null });
    }
    if (method === "POST" && action === "secrets" && key !== "" && (sub === "" || sub === "rotate")) {
      const secret = decodeURIComponent(key);
      if (body.exposure === "env" && !body.target_unit) return error(400, "validation_failed", "exposure env needs a target_unit");
      const value = new TextDecoder().decode(Uint8Array.from(atob(body.value_b64), (c) => c.charCodeAt(0)));
      secrets.set(secret, { value, setupTag: body.setup_tag ?? null });
      // `set` stores the secret for the VM's next lifecycle event; `rotate` also pushes it into the
      // running guest now: a file under the secrets directory by default, an `export` line in the
      // `@login` env file for `exposure: env` with `target_unit: @login`.
      if (sub === "") return new Response(null, { status: 204 });
      if (!running) return json({ vm_count: 0, unconfirmed: [], skipped: [vm.id] });
      if (body.exposure === "env" && body.target_unit === "@login") {
        const kept = (vm.files.get(LOGIN_ENV) ?? "").split("\n").filter((l) => l !== "" && !l.startsWith(`export ${secret}=`));
        vm.files.set(LOGIN_ENV, [...kept, `export ${secret}='${value.replaceAll("'", "'\\''")}'`].join("\n") + "\n");
      } else if ((body.exposure ?? "file") === "file") {
        vm.files.set(`${secretsRoot}/${secret}`, value);
      }
      return json({ vm_count: 1, unconfirmed: [], skipped: [] });
    }
    if (method === "POST" && action === "exec-with-secrets") {
      if (!running) return invalidState(name, vm, "run a command");
      const inArgv = leaked(body.command);
      if (inArgv) return error(400, "validation_failed", `mock: the value of secret ${inArgv} is in the command's argv`);
      // Inject the selected secrets, run the command, then wipe them, as the server does.
      const { selector } = body;
      const dir = secretsRoot;
      const injected = [...secrets].filter(([n, s]) =>
        selector.kind === "setup_tag" ? s.setupTag === selector.tag : selector.kind === "all" || selector.names.includes(n),
      );
      for (const [n, s] of injected) vm.files.set(`${dir}/${n}`, s.value);
      // The guest agent's deadline is `timeout_secs`, 30 s when it is left out; the secrets are
      // wiped either way.
      const { stdout, stderr, code, timedOut } = runInGuest(body.command, vm, body.timeout_secs ?? 30);
      for (const [n] of injected) vm.files.delete(`${dir}/${n}`);
      const timed_out = timedOut !== undefined;
      return json({ stdout, stderr, exit_code: timed_out ? 124 : code, timed_out });
    }
    if (method === "POST" && action === "exec") {
      if (!running) return invalidState(name, vm, "run a command");
      const inArgv = leaked(body.command);
      if (inArgv) return error(400, "validation_failed", `mock: the value of secret ${inArgv} is in the command's argv`);
      // The guest agent's deadline is `timeout_secs`, 30 s when it is left out.
      const { stdout, stderr, code, timedOut } = runInGuest(body.command, vm, body.timeout_secs ?? 30);
      // At the deadline the agent kills the command and the stream ends with exit 124, `timed_out`.
      const end = timedOut === undefined
        ? sse("exit", JSON.stringify({ code, timed_out: false }))
        : sse("exit", JSON.stringify({ code: 124, timed_out: true }));
      return stream((stdout ? sse("stdout", stdout) : "") + (stderr ? sse("stderr", stderr) : "") + end);
    }
    return error(404, "resource_not_found", `no mock route for ${method} ${url.pathname}`);
  };
}
