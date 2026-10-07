import { CoveError } from "../errors.js";
import type { RequestOverrides } from "../http.js";
import { readTar, type TarEntry, writeTar } from "../tar.js";
import type { TagsResource } from "./tags.js";
import type { VmsResource } from "./vms.js";

/**
 * The paths a switch never deletes from `dest`, unless the caller passes its own list: the same
 * set as `cove dev spotlight`. A file the tree itself holds under one is still written, as with
 * the CLI; what only the VM has there survives.
 */
export const SPOTLIGHT_DEFAULT_PROTECT: readonly string[] = ["node_modules/", "target/", "volumes/", ".venv/", ".env"];

/** The VM tags that hold a binding. Readable by any client, e.g. `cove tag ls <vm>`. */
export const SPOTLIGHT_TAGS = {
  /** The commit `off` restores: the tree's HEAD at the first bind. Set only when absent. */
  base: "spotlight.base",
  /** The directory in the VM the tree is mirrored onto. */
  dest: "spotlight.dest",
  /** What is bound: the tree's branch, or its directory name when HEAD is detached. */
  source: "spotlight.source",
} as const;

/**
 * The guest side of a switch, run as `sh -c SCRIPT sh TARBALL STAGE DEST [PROTECT...]`. Every
 * value travels as an argument, never inside the script text. It extracts the tarball into a
 * stage directory beside `dest`, mirrors the stage onto `dest` with delete semantics, keeping the
 * protect entries, then removes the stage and the tarball and prints one JSON line,
 * `{"files":N,"bytes":N}`. It mirrors with `rsync -a --checksum --delete` and the CLI's filter
 * rules (`:- .gitignore`, `.git/` excluded, the protect rules) when the image has rsync, so what
 * dest's `.gitignore` files ignore is kept. Without rsync it uses `find`, `rm`, `rmdir` and
 * `cp -a`, and refuses with exit 3 before changing anything when dest holds a `.gitignore`
 * outside a protected path. The Python SDK carries the same text.
 */
export const SPOTLIGHT_APPLY_SCRIPT = [
  "# cove spotlight apply v2: sh -c SCRIPT sh TARBALL STAGE DEST [PROTECT...]",
  "# Extracts TARBALL into STAGE, mirrors STAGE onto DEST with delete semantics (every path of DEST",
  "# the tree lacks is removed), except that a path matching a PROTECT entry is never deleted (rsync",
  "# protect rules, as the CLI uses: a bare name matches at any depth, a trailing / matches",
  "# directories only, a leading / anchors at DEST); a file the tree holds is still written there.",
  "# With rsync it also keeps what DEST's own .gitignore files ignore, and never touches .git/, as",
  "# the CLI does (the same filter rules, in the same order). Without rsync it cannot read",
  "# .gitignore, so it refuses (exit 3, before changing anything) when DEST holds one outside a",
  "# protected path. It removes the stage dirs an earlier, killed run left beside DEST, and tarballs",
  "# of this name in TARBALL's directory older than an hour. It then removes STAGE and TARBALL and",
  "# prints {\"files\":N,\"bytes\":N}. Every value is a quoted positional parameter; every path reaching a",
  "# command is absolute or starts with ./, and rm, rmdir, mkdir, cp and rsync get -- before their",
  "# operands, so no value can be read as an option.",
  "set -eu",
  "tgz=$1 stage=$2 dest=$3",
  "shift 3",
  "case $dest in /?*) ;; *) echo \"spotlight: dest must be an absolute path other than /, got: $dest\" >&2; exit 2 ;; esac",
  "case $dest in //*|*//*|*/|*/.|*/..|*/./*|*/../*) echo \"spotlight: dest must not end in / or hold an empty, . or .. component, got: $dest\" >&2; exit 2 ;; esac",
  "case $stage in \"$dest\".cove-stage-?*) ;; *) echo \"spotlight: stage must be $dest.cove-stage-<suffix>, got: $stage\" >&2; exit 2 ;; esac",
  "case $tgz in /?*) ;; *) echo \"spotlight: tarball must be an absolute path, got: $tgz\" >&2; exit 2 ;; esac",
  "trap 'rm -rf -- \"$stage\"; rm -f -- \"$tgz\"' EXIT",
  "n=$#",
  "if command -v rsync >/dev/null 2>&1; then",
  "  rsync=1",
  "  # A protect rule for the entry, and one for everything below it: rsync otherwise deletes",
  "  # untracked files inside a protected directory the tree also holds.",
  "  for p do set -- \"$@\" \"--filter=P $p\" \"--filter=P ${p%/}/**\"; done",
  "else",
  "  rsync=",
  "  # A find expression for \"not protected, nor below a protected path\".",
  "  for p do",
  "    case $p in /*) base=./${p#/} ;; *) base=*/$p ;; esac",
  "    case $base in */) base=${base%/} dir=1 ;; *) dir= ;; esac",
  "    set -- \"$@\" -o -path \"$base/*\"",
  "    if [ -n \"$dir\" ]; then set -- \"$@\" -o \\( -path \"$base\" -type d \\); else set -- \"$@\" -o -path \"$base\"; fi",
  "  done",
  "fi",
  "shift \"$n\"",
  "if [ -z \"$rsync\" ] && [ $# -gt 0 ]; then shift; set -- ! \\( \"$@\" \\); fi",
  "if [ -z \"$rsync\" ] && [ -d \"$dest\" ]; then",
  "  ignore=$(cd \"$dest\" && find . ! -path . \"$@\" -name .gitignore -print)",
  "  if [ -n \"$ignore\" ]; then",
  "    nl='",
  "'",
  "    echo \"spotlight: rsync is not installed on the VM, and $dest holds ${ignore%%\"$nl\"*}: without rsync a switch would delete the files it ignores. Install rsync on the VM and run again; nothing was changed.\" >&2",
  "    exit 3",
  "  fi",
  "fi",
  "# Two `on` calls onto the same DEST at once are not supported: the sweep removes the other run's stage, and the last tag write wins.",
  "# Debris of an earlier run killed at its deadline (its EXIT trap never ran).",
  "for old in \"$dest\".cove-stage-*; do",
  "  if [ \"$old\" != \"$stage\" ] && { [ -e \"$old\" ] || [ -L \"$old\" ]; }; then rm -rf -- \"$old\"; fi",
  "done",
  "for old in \"${tgz%/*}\"/cove-spotlight-*.tgz; do",
  "  if [ \"$old\" != \"$tgz\" ] && [ -f \"$old\" ] && [ -n \"$(find \"$old\" -prune -mmin +60 2>/dev/null)\" ]; then rm -f -- \"$old\"; fi",
  "done",
  "rm -rf -- \"$stage\"",
  "mkdir -p -- \"$stage\" \"$dest\"",
  "tar -xpzf \"$tgz\" -C \"$stage\"",
  "# Everything in the stage lands in DEST, so these count what the switch writes.",
  "files=0",
  "for n in $(find \"$stage\" ! -type d -exec sh -c 'echo \"$#\"' sh {} +); do files=$((files + n)); done",
  "bytes=$(find \"$stage\" -type f -exec cat -- {} + | wc -c)",
  "if [ -n \"$rsync\" ]; then",
  "  rsync -a --checksum --delete \"--filter=:- .gitignore\" --exclude=.git/ \"$@\" -- \"$stage/\" \"$dest/\"",
  "else",
  "  # The delete pass: every path of DEST, deepest first, except protected ones and what lies",
  "  # below them; STALE removes each the stage lacks (or holds as another kind of file).",
  "  STALE='stage=$1; shift",
  "for p do",
  "  s=$stage/${p#./}",
  "  if [ -d \"$p\" ] && [ ! -L \"$p\" ]; then",
  "    if [ -d \"$s\" ] && [ ! -L \"$s\" ]; then continue; fi",
  "    rmdir -- \"$p\" 2>/dev/null || :",
  "  else",
  "    if [ -f \"$p\" ] && [ ! -L \"$p\" ] && [ -f \"$s\" ] && [ ! -L \"$s\" ]; then continue; fi",
  "    rm -f -- \"$p\"",
  "  fi",
  "done'",
  "  (cd \"$dest\" && find . -depth ! -path . \"$@\" -exec sh -c \"$STALE\" sh \"$stage\" {} +)",
  "  cp -a -- \"$stage/.\" \"$dest/\"",
  "fi",
  "printf '{\"files\":%d,\"bytes\":%d}\\n' \"$files\" \"$((bytes + 0))\"",
].join("\n");

/** What `spotlight.on` sends: the tree, where it goes, and what a switch keeps. */
export interface SpotlightOnOptions {
  /** A path inside a git checkout. Its whole worktree is sent: tracked files plus untracked ones git does not ignore. */
  tree: string;
  /** The absolute directory in the VM to mirror the tree onto. Created when missing. */
  dest: string;
  /**
   * Paths in `dest` a switch never deletes, as rsync protect patterns: a bare name matches at
   * any depth, a trailing `/` matches a directory only, a leading `/` anchors at `dest`; nothing
   * below a match is deleted either. A file the tree holds there is still written. Replaces
   * {@link SPOTLIGHT_DEFAULT_PROTECT} when given.
   */
  protect?: readonly string[];
  /** The server's deadline, in seconds, on the guest command that applies the tree. Default 300. */
  timeoutSecs?: number;
}

/** What `spotlight.off` needs: a checkout that holds the base commit. */
export interface SpotlightOffOptions {
  /** A path inside a git checkout of the same repository, holding the base commit. */
  tree: string;
  /** As for {@link SpotlightOnOptions.protect}. */
  protect?: readonly string[];
  /** As for {@link SpotlightOnOptions.timeoutSecs}. */
  timeoutSecs?: number;
}

/** The outcome of `spotlight.on`. */
export interface SpotlightOnResult {
  vm: string;
  dest: string;
  /** The commit `off` restores. */
  base: string;
  /** Regular files and symlinks sent. */
  files: number;
  /** Bytes of regular-file content sent (before compression). */
  bytes: number;
}

/** The outcome of `spotlight.off`. */
export interface SpotlightOffResult {
  vm: string;
  dest: string;
  /** The base commit now on `dest`. */
  restored: string;
}

/** A VM's binding, read from its tags. */
export interface SpotlightStatus {
  dest: string;
  base: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Node built-ins, loaded on first use so the browser build never names them.
// ---------------------------------------------------------------------------

interface NodeStats {
  mode: number;
  mtimeMs: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}
interface NodeModules {
  execFile(
    file: string,
    args: readonly string[],
    opts: { cwd: string; encoding: "buffer"; maxBuffer: number; env: Record<string, string | undefined> },
    cb: (err: (Error & { code?: unknown }) | null, stdout: Uint8Array, stderr: Uint8Array) => void,
  ): unknown;
  lstat(path: string): Promise<NodeStats>;
  readFile(path: string): Promise<Uint8Array>;
  readlink(path: string): Promise<string>;
  gzipSync(data: Uint8Array): Uint8Array;
  randomHex(bytes: number): string;
  env: Record<string, string | undefined>;
}

const isNode = (): boolean =>
  typeof (globalThis as { process?: { versions?: { node?: unknown } } }).process?.versions?.node === "string";

let nodeModules: Promise<NodeModules> | undefined;

/** Node's `child_process`, `fs/promises`, `zlib` and `crypto`; throws in a browser. */
function loadNode(): Promise<NodeModules> {
  if (!isNode()) {
    return Promise.reject(
      new CoveError(
        "client.spotlight needs Node.js: it runs git and reads the working tree, which a browser cannot",
      ),
    );
  }
  // Assembled at runtime, as in webhook.ts: a statically visible `node:` specifier would break
  // every browser bundle of the package, not just spotlight callers.
  const load = (name: string): Promise<Record<string, unknown>> =>
    import(/* webpackIgnore: true */ /* @vite-ignore */ "node:" + name) as Promise<Record<string, unknown>>;
  nodeModules ??= Promise.all([load("child_process"), load("fs/promises"), load("zlib"), load("crypto")]).then(
    ([cp, fs, zlib, crypto]) => {
      const fn = <T>(mod: Record<string, unknown>, key: string): T => (mod[key] ?? (mod.default as Record<string, unknown>)?.[key]) as T;
      const randomBytes = fn<(n: number) => { toString(enc: string): string }>(crypto, "randomBytes");
      return {
        execFile: fn(cp, "execFile"),
        lstat: fn(fs, "lstat"),
        readFile: fn(fs, "readFile"),
        readlink: fn(fs, "readlink"),
        gzipSync: fn(zlib, "gzipSync"),
        randomHex: (n: number) => randomBytes(n).toString("hex"),
        env: (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env,
      };
    },
  );
  return nodeModules;
}

// Variables that would point git at another repository than the one `tree` is in.
const GIT_ROUTING_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
];

/** Run `git args` in `cwd` (an argument list, no shell) and return its stdout; throw on failure. */
function git(node: NodeModules, cwd: string, args: readonly string[]): Promise<Uint8Array> {
  const env = { ...node.env };
  for (const v of GIT_ROUTING_ENV) delete env[v];
  return new Promise((resolve, reject) => {
    node.execFile("git", args, { cwd, encoding: "buffer", maxBuffer: 1 << 30, env }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === "ENOENT") {
        // A spawn ENOENT is a missing cwd or a missing git: say which.
        node.lstat(cwd).then(
          () => reject(new CoveError(`git ${args[0]} failed: git is not installed or not on PATH`)),
          () => reject(new CoveError(`git ${args[0]} failed: the tree directory ${cwd} does not exist`)),
        );
        return;
      }
      const detail = new TextDecoder().decode(stderr).trim() || err.message;
      reject(new CoveError(`git ${args[0]} in ${cwd} failed: ${detail}`));
    });
  });
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();

/** A packed tree: its gzip tar, how many entries and bytes it holds. */
export interface PackedTree {
  tgz: Uint8Array;
  files: number;
  bytes: number;
}

function pack(node: NodeModules, entries: TarEntry[]): PackedTree {
  let bytes = 0;
  for (const e of entries) if (e.kind === "file") bytes += e.data.byteLength;
  return { tgz: node.gzipSync(writeTar(entries)), files: entries.length, bytes };
}

/** The top of the checkout `tree` is in. */
async function topLevel(node: NodeModules, tree: string): Promise<string> {
  return text(await git(node, tree, ["rev-parse", "--show-toplevel"]));
}

/**
 * The worktree at `root` as tar entries: `git ls-files -co --exclude-standard -z`, so tracked
 * files plus untracked ones git does not ignore. A listed path that is gone from disk, or is a
 * directory (a submodule), is left out. Files keep their permission bits and mtime; symlinks stay
 * symlinks.
 */
export async function worktreeEntries(root: string): Promise<TarEntry[]> {
  const node = await loadNode();
  // The listing is read here and never put on a command line: each name only reaches lstat/readFile.
  const listed = await git(node, root, ["ls-files", "-co", "--exclude-standard", "-z", "--"]);
  const paths = [...new Set(splitNames(listed))].sort();
  const entries: TarEntry[] = [];
  for (const path of paths) {
    const full = `${root}/${path}`;
    let st: NodeStats;
    try {
      st = await node.lstat(full);
    } catch (err) {
      // Tracked, but deleted in the worktree (or a parent turned into a file); anything else is real.
      const code = (err as { code?: unknown }).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw err;
    }
    const mtime = Math.floor(st.mtimeMs / 1000);
    if (st.isSymbolicLink()) {
      entries.push({ kind: "symlink", path, mode: 0o777, mtime, target: await node.readlink(full) });
    } else if (st.isFile()) {
      entries.push({ kind: "file", path, mode: st.mode & 0o7777, mtime, data: await node.readFile(full) });
    }
  }
  return entries;
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Refuse a base commit that is not a hex object name before it goes near git: the
 * `spotlight.base` tag comes back from the VM, so it is untrusted, and a value such as
 * `--output=/x` would otherwise reach `git archive` as an option.
 */
export function checkBase(sha: string): string {
  if (typeof sha !== "string" || !/^[0-9a-f]{7,64}$/.test(sha)) {
    throw new CoveError(`spotlight.base is not a commit id (7 to 64 lowercase hex digits): ${JSON.stringify(sha)}`);
  }
  return sha;
}

/**
 * The NUL-separated names of `git ls-files -z`. A name that is not valid UTF-8 is refused rather
 * than skipped (a lossy decode would name a file that does not exist), as the Python SDK does.
 */
export function splitNames(listed: Uint8Array): string[] {
  const strict = new TextDecoder("utf-8", { fatal: true });
  const names: string[] = [];
  let start = 0;
  for (let i = 0; i <= listed.byteLength; i++) {
    if (i < listed.byteLength && listed[i] !== 0) continue;
    if (i > start) {
      const raw = listed.subarray(start, i);
      try {
        names.push(strict.decode(raw));
      } catch {
        const shown = new TextDecoder().decode(raw);
        throw new CoveError(`spotlight cannot send ${JSON.stringify(shown)}: its file name is not valid UTF-8; rename it or ignore it in .gitignore`);
      }
    }
    start = i + 1;
  }
  return names;
}

/**
 * The tree of commit `sha` (`git archive`), after checking the commit is present. `sha` must
 * pass {@link checkBase}, before any git call. It is resolved as an object id only
 * (`git rev-parse --disambiguate`), never as a ref, so a branch that happens to be named like an
 * abbreviated id cannot move what `off` restores; exactly one commit must match.
 */
export async function commitEntries(root: string, sha: string): Promise<TarEntry[]> {
  checkBase(sha);
  const node = await loadNode();
  const full = await resolveCommit(node, root, sha);
  return readTar(await git(node, root, ["archive", "--format=tar", full]));
}

/** The one commit whose id starts with `sha`, or `CoveError`. */
async function resolveCommit(node: NodeModules, root: string, sha: string): Promise<string> {
  const candidates = text(await git(node, root, ["rev-parse", `--disambiguate=${sha}`])).split("\n").filter((c) => FULL_SHA.test(c));
  const commits: string[] = [];
  for (const c of candidates) {
    if (text(await git(node, root, ["cat-file", "-t", c])) === "commit") commits.push(c);
  }
  if (commits.length === 0) throw new CoveError(`restore commit ${sha} not present locally — run \`git fetch\``);
  if (commits.length > 1) throw new CoveError(`restore commit ${sha} is ambiguous: ${commits.join(", ")}`);
  return commits[0]!;
}

/**
 * `dest` without trailing slashes, refused unless it is absolute (so it can never start with
 * `-`), not `/`, free of `.` and `..` components and control characters, and fits a tag value.
 */
export function checkDest(dest: string): string {
  if (typeof dest !== "string" || !dest.startsWith("/") || dest.startsWith("-")) {
    throw new CoveError(`spotlight dest must be an absolute path, got ${JSON.stringify(dest)}`);
  }
  const trimmed = dest.replace(/\/+$/, "");
  if (trimmed === "") throw new CoveError("spotlight dest cannot be /");
  if (trimmed.split("/").some((c) => c === "." || c === "..")) {
    throw new CoveError(`spotlight dest cannot hold . or .. components, got ${JSON.stringify(dest)}`);
  }
  // \p{Cc} is C0, DEL and C1 (U+0080-U+009F): the server refuses all of them in a tag value.
  if (/\p{Cc}/u.test(trimmed)) throw new CoveError("spotlight dest cannot hold control characters");
  if (new TextEncoder().encode(trimmed).byteLength > 256) {
    throw new CoveError("spotlight dest is longer than a tag value's 256 bytes");
  }
  return trimmed;
}

/**
 * The protect list to send, plus `.git/`. An entry starting with `-`, or holding a NUL or a
 * line break, is refused: each reaches rsync only inside one `--filter=P <entry>` argument, and find
 * only as a `-path` operand, but an option-shaped pattern is never what a caller means.
 */
export function checkProtect(protect: readonly string[] | undefined): string[] {
  const list = [...(protect ?? SPOTLIGHT_DEFAULT_PROTECT)];
  for (const p of list) {
    if (typeof p !== "string" || p === "" || p.startsWith("-") || /[\0\n\r]/.test(p)) {
      throw new CoveError(
        `a spotlight protect entry must be a non-empty pattern, not starting with - and without NUL or line breaks, got ${JSON.stringify(p)}`,
      );
    }
  }
  // The checkout's own .git is never part of the tree, and a switch never deletes one in dest.
  if (!list.includes(".git/")) list.push(".git/");
  return list;
}

/** `label` cut to a tag value's 256 UTF-8 bytes. */
export function tagValue(label: string): string {
  // By code point, so a cut never splits a surrogate pair.
  const points = Array.from(label);
  while (new TextEncoder().encode(points.join("")).byteLength > 256) points.pop();
  return points.join("");
}

/**
 * `client.spotlight`: put a local git worktree onto a long-lived VM at a path, switch it to
 * another worktree, and restore the base tree with `off`, all over the HTTP API (`vms.files`
 * upload plus one `exec`). Nothing on the VM is restarted. Node.js only: in a browser every
 * method throws `CoveError`.
 *
 * The binding lives in the VM's tags (`spotlight.base`, `spotlight.dest`, `spotlight.source`),
 * so any client can read it, and `off` works from another process or machine. The CLI's
 * `cove dev spotlight` keeps its binding on the laptop instead: the two do not see each other's.
 *
 * Scopes: `tags:read` and `tags:write` (the binding), `files:write` (the upload) and `vms:exec`
 * (the apply).
 * Each switch sends the whole tree. A tree larger than the host's file limit fails with
 * `FileTooLargeError` (413 `file_too_large`) before anything changes on the VM.
 */
export class SpotlightResource {
  constructor(
    private readonly vms: VmsResource,
    private readonly tags: TagsResource,
  ) {}

  /**
   * Mirror `tree` onto `dest` in VM `vm`: every path of `dest` the tree lacks is deleted, except
   * the protect entries. The first bind records the tree's HEAD as the base `off` restores; a
   * later `on` (a switch to another worktree) keeps it. The tags are written only after the tree
   * is in place, so a failed switch leaves the binding as it was.
   */
  async on(vm: string, opts: SpotlightOnOptions, overrides: RequestOverrides = {}): Promise<SpotlightOnResult> {
    const dest = checkDest(opts.dest);
    const protect = checkProtect(opts.protect);
    const node = await loadNode();
    // The base tag comes back from the VM: a bound one is checked before any git call.
    const bound = await this.#binding(vm, overrides);
    // An empty tag counts as no base, as in the Python SDK.
    const boundBase = bound.get(SPOTLIGHT_TAGS.base) || undefined;
    if (boundBase !== undefined) checkBase(boundBase);
    const root = await topLevel(node, opts.tree);
    const head = text(await git(node, root, ["rev-parse", "--verify", "HEAD"]));
    if (!FULL_SHA.test(head)) throw new CoveError(`git rev-parse HEAD answered ${JSON.stringify(head)}, not a commit id`);
    const branch = text(await git(node, root, ["rev-parse", "--abbrev-ref", "HEAD"]));
    const source = tagValue(branch === "HEAD" ? (root.split("/").pop() ?? root) : branch);
    const packed = pack(node, await worktreeEntries(root));
    const base = boundBase ?? head;
    const applied = await this.#apply(node, vm, dest, packed, protect, opts.timeoutSecs, overrides);
    if (boundBase === undefined) await this.tags.set(vm, SPOTLIGHT_TAGS.base, base, overrides);
    await this.tags.set(vm, SPOTLIGHT_TAGS.dest, dest, overrides);
    await this.tags.set(vm, SPOTLIGHT_TAGS.source, source, overrides);
    return { vm, dest, base, ...applied };
  }

  /**
   * Restore the base commit onto the bound `dest` (`git archive <base>` from `tree`, applied as
   * `on` applies a tree), then delete the three tags. With no binding on the VM it does nothing
   * and resolves `null`, as `cove dev spotlight off` does. A base commit missing from `tree`'s
   * repository throws `CoveError` ("run `git fetch`") before anything changes.
   */
  async off(vm: string, opts: SpotlightOffOptions, overrides: RequestOverrides = {}): Promise<SpotlightOffResult | null> {
    const protect = checkProtect(opts.protect);
    const node = await loadNode();
    const bound = await this.#binding(vm, overrides);
    const base = bound.get(SPOTLIGHT_TAGS.base);
    const dest = bound.get(SPOTLIGHT_TAGS.dest);
    if (!base || !dest) return null;
    // Both tags come back from the VM: check them before any git call or upload.
    checkBase(base);
    checkDest(dest);
    const root = await topLevel(node, opts.tree);
    const packed = pack(node, await commitEntries(root, base));
    await this.#apply(node, vm, checkDest(dest), packed, protect, opts.timeoutSecs, overrides);
    // Base first, dest last: a failure part-way leaves no base, so `off` answers null, while
    // status still shows the dest and the next `on` records a fresh base.
    for (const key of [SPOTLIGHT_TAGS.base, SPOTLIGHT_TAGS.source, SPOTLIGHT_TAGS.dest]) {
      await this.tags.delete(vm, key, overrides);
    }
    return { vm, dest, restored: base };
  }

  /** The VM's binding, from its tags, or `null` when nothing is bound. Scope `tags:read`. */
  async status(vm: string, overrides: RequestOverrides = {}): Promise<SpotlightStatus | null> {
    const bound = await this.#binding(vm, overrides);
    const dest = bound.get(SPOTLIGHT_TAGS.dest);
    if (!dest) return null;
    return { dest, base: bound.get(SPOTLIGHT_TAGS.base) ?? "", source: bound.get(SPOTLIGHT_TAGS.source) ?? "" };
  }

  async #binding(vm: string, overrides: RequestOverrides): Promise<Map<string, string>> {
    const tags = await this.tags.listForVm(vm, overrides);
    return new Map(tags.filter((t) => t.key.startsWith("spotlight.")).map((t) => [t.key, t.value]));
  }

  /** Upload the tarball and run the apply script; resolve its counts, or throw. */
  async #apply(
    node: NodeModules,
    vm: string,
    dest: string,
    packed: PackedTree,
    protect: string[],
    timeoutSecs: number | undefined,
    overrides: RequestOverrides,
  ): Promise<{ files: number; bytes: number }> {
    const nonce = node.randomHex(8);
    const tgz = `/tmp/cove-spotlight-${nonce}.tgz`;
    const stage = `${dest}.cove-stage-${nonce}`;
    await this.vms.files.upload(vm, tgz, packed.tgz, {}, overrides);
    const deadline = timeoutSecs ?? 300;
    const run = await this.vms.execCollect(
      vm,
      { command: applyCommand(tgz, stage, dest, protect), timeoutSecs: deadline },
      overrides,
    );
    if (run.timedOut) {
      throw new CoveError(
        `spotlight: applying the tree to ${vm}:${dest} hit its ${deadline} s deadline and was killed, so ${dest} may be half-mirrored; run on again (with a larger timeoutSecs if the tree is big)`,
      );
    }
    if (run.exitCode !== 0) {
      throw new CoveError(`spotlight: applying the tree to ${vm}:${dest} failed (exit ${run.exitCode}): ${run.stderr.trim()}`);
    }
    const last = run.stdout.trim().split("\n").pop() ?? "";
    try {
      const summary = JSON.parse(last) as { files?: unknown; bytes?: unknown };
      if (typeof summary.files === "number" && typeof summary.bytes === "number") {
        return { files: summary.files, bytes: summary.bytes };
      }
    } catch {
      // fall through
    }
    throw new CoveError(`spotlight: the apply script printed no summary: ${JSON.stringify(run.stdout)}`);
  }
}

/** The apply exec's argv. Every value is its own argument; the script text is fixed. */
export function applyCommand(tgz: string, stage: string, dest: string, protect: readonly string[]): string[] {
  return ["sh", "-c", SPOTLIGHT_APPLY_SCRIPT, "sh", tgz, stage, dest, ...protect];
}
