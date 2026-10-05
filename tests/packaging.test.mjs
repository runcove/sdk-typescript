// What the package ships and what a bundler can do with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Every .js file in the ESM build (dist/cjs is a separate, Node-only target). */
function esmBuildFiles(dir = join(root, "dist"), out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "cjs") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) esmBuildFiles(path, out);
    else if (entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

test("the ESM build names no built-in module a bundler must resolve", () => {
  // The `node:crypto` fallback in webhook.ts is reachable from the package
  // entry, so a static specifier here fails `esbuild --platform=browser`
  // outright — for every consumer, whether or not they verify webhooks.
  // `npm run check:browser` is the real bundle; this is the offline guard.
  const staticSpecifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']node:[^"']+["']/;
  const offenders = esmBuildFiles().filter((file) =>
    staticSpecifier.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(offenders, [], "static node: specifier in the browser-facing build");
});

test("npm pack builds first, so the tarball is never empty", () => {
  // `files: ["dist"]` plus a gitignored dist packs README and package.json and
  // nothing else, silently, from a clean checkout.
  assert.equal(pkg.scripts.prepack, "npm run build");
  assert.deepEqual(pkg.files, ["dist", "LICENSE"]);
});

test("the package is Apache-2.0 and ships the licence text", () => {
  // npm always packs a LICENSE at the root; listing it in `files` makes that
  // explicit, and the release tarball is built from this same file list.
  assert.equal(pkg.license, "Apache-2.0");
  assert.match(readFileSync(join(root, "LICENSE"), "utf8"), /^\s+Apache License\n\s+Version 2\.0, January 2004\n/);
});
