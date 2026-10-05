// The public type surface is the explicit generated schema list plus the hand-written ergonomic
// types, joined by two star re-exports so that a name collision is a TS2308 build error (a named
// export beside a star export would shadow it silently instead); named exports in index.ts
// (CoveClient, the error classes, ExecOptions, ...) are checked separately.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCHEMA_BARREL_EXCLUSIONS } from "../scripts/schema-barrel-exclusions.mjs";

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const src = (p) => read(`../src/${p}`);
const stars = (f) => [...src(f).matchAll(/^export \* from "([^"]+)";$/gm)].map((m) => m[1]);
const schemaList = () =>
  [...src("generated/schemas.gen.ts").matchAll(/^ {2}(\w+),$/gm)].map((m) => m[1]);

test("types.ts joins the generated schema list and the ergonomic types, and nothing else", () => {
  assert.deepEqual(stars("types.ts"), ["./generated/schemas.gen.js", "./ergonomic.js"]);
  assert.doesNotMatch(src("types.ts"), /export (type )?\{/, "a named type export would shadow a schema silently");
});

test("index.ts reaches types only through types.ts", () => {
  assert.deepEqual(stars("index.ts"), ["./types.js"]);
  assert.doesNotMatch(src("index.ts"), /from "\.\/generated\//);
});

test("no name index.ts exports explicitly is also a schema name (that would shadow it silently)", () => {
  const schemas = new Set(schemaList());
  assert.ok(schemas.size > 100, `positive control: the schema list parsed (${schemas.size} names)`);
  const named = [...src("index.ts").matchAll(/export (?:type )?\{([^}]*)\}/g)]
    .flatMap((m) => m[1].split(",").map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  assert.ok(named.includes("CoveClient"), "positive control: index.ts's named exports parsed");
  assert.deepEqual(named.filter((n) => schemas.has(n)), []);
});

test("the public schema list is exactly components.schemas minus the documented exclusions (per-operation helpers stay internal)", () => {
  const listed = schemaList().sort();
  const yaml = read("../../openapi.yaml");
  const block = yaml.slice(yaml.indexOf("\n  schemas:\n"));
  const end = block.slice(1).search(/\n {2}[a-zA-Z]/);
  const names = [...block.slice(0, end + 1).matchAll(/^ {4}([A-Za-z0-9_]+):$/gm)].map((m) => m[1]).sort();
  assert.ok(names.length > 100, `positive control: components.schemas parsed (${names.length} names)`);
  const excluded = Object.keys(SCHEMA_BARREL_EXCLUSIONS);
  assert.ok(excluded.includes("ExecRequestDto"), "positive control: the exclusion list parsed");
  for (const n of excluded) assert.ok(names.includes(n), `exclusion ${n} is a schema`);
  assert.deepEqual(listed, names.filter((n) => !excluded.includes(n)));
});

test("every excluded schema is still public, as a corrected type in ergonomic.ts", () => {
  for (const n of Object.keys(SCHEMA_BARREL_EXCLUSIONS)) {
    assert.match(src("ergonomic.ts"), new RegExp(`^export type ${n}\\b`, "m"), `${n} must be exported from ergonomic.ts`);
  }
  assert.match(src("ergonomic.ts"), /^export type ExecRequestDto = Omit<GeneratedExecRequestDto, "selector">;$/m);
});

test("COVE_API_VERSION comes from the generated core", () => {
  assert.match(src("http.ts"), /from "\.\/generated\/api-version\.gen\.js"/);
  assert.doesNotMatch(src("http.ts"), /COVE_API_VERSION = "\d+"/);
});

test("the public barrel exports ERROR_CODES, the generated list", async () => {
  const sdk = await import("../dist/index.js");
  const gen = await import("../dist/generated/error-codes.gen.js");
  assert.equal(sdk.ERROR_CODES, gen.ERROR_CODES);
  assert.ok(sdk.ERROR_CODES.includes("vm_name_taken"));
});

test("the public barrel exports COVE_API_VERSION, the generated API version", async () => {
  const sdk = await import("../dist/index.js");
  const gen = await import("../dist/generated/api-version.gen.js");
  assert.equal(typeof gen.COVE_API_VERSION, "string");
  assert.equal(sdk.COVE_API_VERSION, gen.COVE_API_VERSION);
});
