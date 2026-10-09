// What the README, the agent guide and the examples tell a user: code a user copies must work
// from an installed package, against any host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sdk = join(root, "..");
const read = (rel) => readFileSync(join(sdk, rel), "utf8");
const readme = read("typescript/README.md");

// Every example a user may copy, in both SDKs; `_mock.*` is the fake server, not user code.
const exampleFiles = () =>
  ["typescript/examples", "python/examples"].flatMap((dir) =>
    readdirSync(join(sdk, dir))
      .filter((f) => /\.(ts|mjs|py)$/.test(f) && !f.startsWith("_"))
      .map((f) => `${dir}/${f}`),
  );
// The fenced code blocks of a markdown file.
const codeBlocks = (md) => [...md.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1]);
// An image name written into a create call: `image: "x"` (TypeScript) or `image="x"` (Python).
const HARDCODED_IMAGE = /\bimage\s*[:=]\s*["'`][^"'`]/;

test("unit_no_example_or_readme_code_hardcodes_an_image_name", () => {
  const offenders = [];
  for (const f of exampleFiles()) if (HARDCODED_IMAGE.test(read(f))) offenders.push(f);
  for (const md of ["typescript/README.md", "typescript/AGENTS.md", "python/README.md", "python/AGENTS.md", "README.md"]) {
    if (codeBlocks(read(md)).some((c) => HARDCODED_IMAGE.test(c))) offenders.push(md);
  }
  assert.deepEqual(offenders, [], "omit `image` for the host's default: a name one host has 404s on another");
  // Positive control.
  assert.ok(HARDCODED_IMAGE.test('client.vms.create({ image: "ubuntu-24.04" })'));
  assert.ok(!HARDCODED_IMAGE.test("client.vms.create({ image: process.env.COVE_IMAGE })"));
});

// A TypeScript or JavaScript file without its comments, so an import shown in a doc comment
// (flue-sandbox.ts has one) never stands in for a real one.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("unit_no_typescript_example_imports_the_build_by_a_relative_path", () => {
  const relative = /\bfrom\s+["']\.{1,2}\/[^"']*dist\b|import\(\s*["']\.{1,2}\/[^"']*dist\b/;
  const ts = exampleFiles().filter((f) => f.startsWith("typescript/"));
  const offenders = ts.filter((f) => relative.test(code(read(f))));
  assert.deepEqual(offenders, [], 'import "@runcove/sdk": an installed user has no ../dist');
  for (const f of ts) assert.match(code(read(f)), /^import[^;]*\sfrom\s+["']@runcove\/sdk["'];/m, `${f} imports the package by its name`);
  // Positive control: an import inside a comment does not count.
  assert.doesNotMatch(code('/**\n * import { CoveClient } from "@runcove/sdk";\n */\n'), /from\s+["']@runcove\/sdk["']/);
});

test("unit_readme_lists_every_resource_group_on_the_client", () => {
  const client = readFileSync(join(root, "src/client.ts"), "utf8");
  const groups = [...client.matchAll(/^\s+readonly (\w+): \w+Resource;/gm)].map((m) => m[1]);
  assert.ok(groups.length >= 13, `found ${groups.length} groups on CoveClient`);
  const line = readme.split("\n").find((l) => l.startsWith("- Resource groups"));
  assert.ok(line, "the README lists the resource groups");
  const listed = [...line.matchAll(/`(\w+)`/g)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), [...groups].sort());
});

test("unit_readme_install_section_installs_the_tarball_a_server_serves", () => {
  const install = readme.slice(readme.indexOf("## Install"), readme.indexOf("\n## ", readme.indexOf("## Install") + 1));
  assert.match(install, /npm install "https:\/\/<cove-web-host>\/public\/sdk\/cove-sdk-<version>\.tgz"/);
  assert.match(install, /\/public\/sdk\/index\.json/);
  assert.doesNotMatch(install, /monorepo/);
});
