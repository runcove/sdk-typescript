// The coverage gate: the SDK has a call site for every operation the bearer
// (`external`) listener serves, calls nothing else, and the README lists
// exactly the operations it leaves out.
//
// Both sides are read from source, never from a hand-kept list: the contract
// from `sdk/openapi.yaml` (each operation's verb, path, `operationId` and
// `x-listeners`), the SDK from the `.request*("VERB", …)` call sites in
// `src/resources/*.ts`. Counts are deliberately not pinned (on the contract
// this gate was last updated against: 144 operations, 137 of them external, 7
// not), so another lane adding an operation fails this gate only if the SDK
// does not cover it. The README test pins the exact not-external list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Operations another lane is about to put on `external` before this SDK
 * covers them (spec R4): operationId -> bead id. Empty unless such a pull
 * request is in flight; the lane that adds the SDK methods removes the entry.
 */
const PENDING_OTHER_LANE = new Map([]);

// ---------------------------------------------------------------------------
// 1a — the contract
// ---------------------------------------------------------------------------

/**
 * `${anything}` and then `{name}` normalise to `${}` (in that order: the
 * second pattern would otherwise eat the braces of the first); a query string
 * is dropped.
 */
const normalise = (path) =>
  path
    .replace(/\$\{[^}]*\}/g, "${}")
    .replace(/\{[^}]+\}/g, "${}")
    .split("?")[0];

/**
 * Parse `sdk/openapi.yaml` line by line into one record per operation. The
 * file is generated (`scripts/sync-openapi.sh`) with a fixed layout: path keys
 * at 2 spaces under `paths:`, verbs at 4, an operation's fields at 6, and the
 * `x-listeners` entries as `      - <listener>` lines under their key.
 */
function parseContract() {
  const yaml = readFileSync(fileURLToPath(new URL("../../openapi.yaml", import.meta.url)), "utf8");
  const ops = [];
  let inPaths = false;
  let path = null;
  let op = null;
  let inListeners = false;
  for (const line of yaml.split("\n")) {
    if (/^\S/.test(line)) {
      inPaths = line === "paths:";
      path = null;
      op = null;
      inListeners = false;
      continue;
    }
    if (!inPaths) continue;
    let m = line.match(/^ {2}(\/[^\s:]*):$/);
    if (m) {
      path = m[1];
      op = null;
      inListeners = false;
      continue;
    }
    m = path && line.match(/^ {4}(get|post|put|patch|delete|head|options):$/);
    if (m) {
      op = { verb: m[1].toUpperCase(), path, operationId: null, listeners: [] };
      ops.push(op);
      inListeners = false;
      continue;
    }
    if (!op) continue;
    if ((m = line.match(/^ {6}operationId: (\S+)$/))) {
      op.operationId = m[1];
      inListeners = false;
    } else if (/^ {6}x-listeners:$/.test(line)) {
      inListeners = true;
    } else if (inListeners && (m = line.match(/^ {6}- (\S+)$/))) {
      op.listeners.push(m[1]);
    } else if (/^ {6}\S/.test(line)) {
      inListeners = false;
    }
  }
  return ops;
}

const ops = parseContract();
const key = (op) => `${op.verb} ${normalise(op.path)}`;
const external = ops.filter((op) => op.listeners.includes("external"));
const notExternal = ops.filter((op) => !op.listeners.includes("external"));
const externalKeys = new Set(external.map(key));

test("the contract parser finds the operations and their listeners", () => {
  // Positive control for every test below: an empty or half-read contract
  // would make "nothing is missing" pass vacuously.
  console.log(
    `contract: ${ops.length} operations, ${external.length} external, ${notExternal.length} not`,
  );
  assert.ok(external.length > 100, `only ${external.length} external operations parsed`);
  assert.ok(notExternal.length > 0, "no operation outside the bearer listener was parsed");
  for (const op of ops) {
    assert.ok(op.operationId, `${op.verb} ${op.path} has no operationId`);
    assert.ok(op.listeners.length > 0, `${op.operationId} has no x-listeners`);
  }
  // A known operation reads back exactly as the contract spells it.
  const listVms = ops.find((op) => op.operationId === "listVms");
  assert.deepEqual(listVms && { verb: listVms.verb, path: listVms.path }, {
    verb: "GET",
    path: "/api/vms",
  });
  assert.ok(listVms.listeners.includes("external"));
});

// ---------------------------------------------------------------------------
// 1b — the SDK's call sites
// ---------------------------------------------------------------------------

const resourcesDir = fileURLToPath(new URL("../src/resources", import.meta.url));

/**
 * Every `"VERB path"` the SDK can send. Two forms exist:
 *
 * - `.request*("VERB", apiPath`…`)` — every resource method. `tests/client.test.mjs`
 *   refuses a plain-string path, so this is the only form outside `SecretsScope`.
 * - `.request*("VERB", `${this.base}<suffix>`)` inside `class SecretsScope`
 *   (`src/resources/secrets.ts`). It must not use `apiPath`, which would
 *   percent-encode the `/` in its pre-encoded base. Each suffix expands over
 *   every base `SecretsResource` hands it (`new SecretsScope(this.http, apiPath`…`)`),
 *   read from the same file so a fifth scope is picked up without editing this test.
 *
 * Any `.request*(` call matching neither form fails the scan, so a new call
 * shape cannot drop out of the gate unseen.
 */
function scanCallSites() {
  const sites = new Set();
  const unrecognised = [];
  const direct =
    /\.request(?:SSE|Raw)?(?:<(?:[^<>]|<[^<>]*>)*>)?\(\s*"(GET|HEAD|POST|PUT|PATCH|DELETE)"\s*,\s*apiPath`([^`]+)`/g;
  const scoped =
    /\.request(?:SSE|Raw)?(?:<(?:[^<>]|<[^<>]*>)*>)?\(\s*"(GET|HEAD|POST|PUT|PATCH|DELETE)"\s*,\s*`\$\{this\.base\}([^`]*)`/g;
  let scopeBases = [];
  for (const file of readdirSync(resourcesDir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(`${resourcesDir}/${file}`, "utf8");
    let matched = 0;
    for (const m of src.matchAll(direct)) {
      sites.add(`${m[1]} ${normalise(m[2])}`);
      matched += 1;
    }
    const scopeClass = src.match(/export class SecretsScope\b[\s\S]*?\n}\n/);
    if (scopeClass) {
      scopeBases = [...src.matchAll(/new SecretsScope\(\s*this\.http\s*,\s*apiPath`([^`]+)`/g)].map(
        (m) => normalise(m[1]),
      );
      for (const m of scopeClass[0].matchAll(scoped)) {
        for (const base of scopeBases) sites.add(`${m[1]} ${normalise(base + m[2])}`);
        matched += 1;
      }
    }
    // Counted with no generic in the pattern, so a call shape the two forms
    // above cannot parse (say, a deeper type argument) still counts here.
    const total = [...src.matchAll(/\.request(?:SSE|Raw)?\s*[<(]/g)].length;
    if (total !== matched) unrecognised.push(`${file}: ${total} call sites, ${matched} recognised`);
  }
  return { sites, unrecognised, scopeBases };
}

const { sites: covered, unrecognised, scopeBases } = scanCallSites();

test("the call-site scanner recognises every request the resources make", () => {
  assert.deepEqual(unrecognised, [], "call sites the coverage scanner cannot read");
  // Positive controls: the scanner found the plain form, and the secrets
  // scopes expanded over at least the four known bases. A fifth scope is
  // picked up without editing this test; the gate then checks its paths.
  for (const base of ["/api/vms/${}", "/api/users/${}", "/api/teams/${}", "/api/projects/${}"]) {
    assert.ok(scopeBases.includes(base), `no secrets scope base ${base} in: ${scopeBases.join(", ")}`);
  }
  assert.ok(scopeBases.length >= 4);
  assert.ok(covered.has("GET /api/vms"));
  assert.ok(covered.has("POST /api/projects/${}/secrets/${}/rotate"));
  assert.ok(covered.has("GET /api/users/${}/secrets"));
  console.log(`SDK: ${covered.size} distinct call sites`);
});

test("every request call in src/ lives where the scanner reads", () => {
  // The scanner reads only `src/resources/*.ts`. A `.request*(` call anywhere
  // else under `src/` (a new top-level module, a subdirectory) would escape
  // the gate, so it fails here. `src/http.ts` defines the methods and is the
  // one exception.
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const outside = [];
  let seen = 0;
  // A hand walk rather than `readdirSync(…, { recursive: true })`, which
  // Node 18 before 18.17 lacks (`package.json` engines: `>=18`).
  const walk = (dir) =>
    readdirSync(`${srcDir}/${dir}`, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${dir}${e.name}/`) : [`${dir}${e.name}`],
    );
  for (const file of walk("")) {
    if (!file.endsWith(".ts") || file === "http.ts") continue;
    const src = readFileSync(`${srcDir}/${file}`, "utf8");
    const calls = [...src.matchAll(/\.request(?:SSE|Raw)?\s*[<(]/g)].length;
    seen += calls;
    if (calls > 0 && !/^resources\/[^/]+\.ts$/.test(file)) outside.push(`src/${file}: ${calls}`);
  }
  // Positive control: the walk reached the resource files' calls.
  assert.ok(seen > 100, `only ${seen} request calls found under src/`);
  assert.deepEqual(
    outside,
    [],
    "request calls outside src/resources/*.ts, which the coverage scanner does not read",
  );
});

// ---------------------------------------------------------------------------
// 1c — the gate, both directions, and the README
// ---------------------------------------------------------------------------

test("every operation served on the bearer listener has an SDK call site", () => {
  const missing = external.filter(
    (op) => !covered.has(key(op)) && !PENDING_OTHER_LANE.has(op.operationId),
  );
  assert.deepEqual(
    missing.map((op) => op.operationId),
    [],
    "no SDK method for these external operations",
  );
});

test("every SDK call site is an external operation", () => {
  const stray = [...covered].filter((k) => !externalKeys.has(k));
  assert.deepEqual(stray, [], "SDK calls operations the bearer listener does not serve");
});

test("PENDING_OTHER_LANE names only external operations the SDK does not cover yet", () => {
  // A stale entry would silently exempt an operation once its methods land.
  const stale = [...PENDING_OTHER_LANE.keys()].filter((id) => {
    const op = external.find((o) => o.operationId === id);
    return !op || covered.has(key(op));
  });
  assert.deepEqual(stale, [], "remove these from PENDING_OTHER_LANE");
});

test("the README's 'Not covered' list is exactly the operations not served on the bearer listener", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  const start = readme.indexOf("## Not covered, and why");
  assert.notEqual(start, -1, "README has no '## Not covered, and why' section");
  const section = readme.slice(start).split(/\n## /)[0];
  const listed = [...section.matchAll(/^- `(\w+)`/gm)].map((m) => m[1]).sort();
  assert.deepEqual(listed, notExternal.map((op) => op.operationId).sort());
});

test("no SDK doc names the retired full_surface gate", () => {
  // `[api] full_surface` is no longer a setting, and the contract's
  // `x-requires-full-surface` marker is gone: the bearer listener serves the
  // whole surface on every host. A JSDoc or README
  // sentence that still says an operation is reachable "only where the host
  // enables full_surface" tells callers to expect a 404 that never comes.
  const retired = /full_surface|x-requires-full-surface/;
  const yaml = readFileSync(fileURLToPath(new URL("../../openapi.yaml", import.meta.url)), "utf8");
  // The premise: the contract no longer carries the marker.
  assert.ok(!/x-requires-full-surface/.test(yaml), "sdk/openapi.yaml carries the x-requires-full-surface marker again");
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const walk = (dir) =>
    readdirSync(`${srcDir}/${dir}`, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === "generated" ? [] : walk(`${dir}${e.name}/`)) : [`src/${dir}${e.name}`],
    );
  const files = [...walk(""), "README.md", "../README.md", "AGENTS.md"];
  // Positive control: the walk reached the resource files.
  assert.ok(files.includes("src/resources/admin.ts") && files.length > 20, `only ${files.length} files`);
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
    text.split("\n").forEach((line, i) => {
      if (retired.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], "sentences that still name the retired full_surface gate");
});
