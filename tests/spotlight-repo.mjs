// A temporary git repository for the spotlight tests, shared by the packer tests and the examples harness.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDir(t, prefix = "cove-spotlight-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    // A hook's GIT_DIR and friends would point git at the real repository, so drop every GIT_ variable.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();

// A path over 100 bytes that the ustar prefix field can carry, and one over 255 that needs pax.
export const LONG = `${"d".repeat(60)}/${"e".repeat(60)}/long-file.txt`;
export const LONGER = `${"x".repeat(120)}/${"y".repeat(120)}/${"z".repeat(120)}.txt`;

/** A repository with one commit and a worktree holding every kind of path the packer sorts. */
export function makeRepo(t) {
  const dir = tempDir(t);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), "ignored.log\nbuild/\n");
  writeFileSync(join(dir, "tracked.txt"), "tracked v1\n");
  writeFileSync(join(dir, "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(dir, "run.sh"), 0o755);
  writeFileSync(join(dir, "gone.txt"), "deleted after the commit\n");
  symlinkSync("tracked.txt", join(dir, "link"));
  for (const p of [LONG, LONGER]) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), `content of ${p.length}\n`);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  writeFileSync(join(dir, "untracked.txt"), "not yet added\n");
  writeFileSync(join(dir, "ignored.log"), "ignored\n");
  mkdirSync(join(dir, "build"));
  writeFileSync(join(dir, "build/out.bin"), "ignored dir\n");
  rmSync(join(dir, "gone.txt"));
  return dir;
}
