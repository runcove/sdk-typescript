// COVE_API_VERSION and ERROR_CODES are generated from sdk/openapi.yaml (scripts/sync-sdk-core.sh).
// This is the Q5 drift test: useful before the gate runs and on machines that skip it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COVE_API_VERSION } from "../dist/generated/api-version.gen.js";
import { ERROR_CODES } from "../dist/generated/error-codes.gen.js";

const yaml = readFileSync(fileURLToPath(new URL("../../openapi.yaml", import.meta.url)), "utf8");

test("COVE_API_VERSION equals info.version of sdk/openapi.yaml", () => {
  const m = yaml.match(/\ninfo:\n(?:(?: {2,}.*)?\n)*? {2}version: '?([^'\n]+)'?\n/);
  assert.ok(m, "info.version not found");
  assert.equal(COVE_API_VERSION, m[1]);
});

test("ERROR_CODES matches the published ErrorCode schema in sdk/openapi.yaml", () => {
  const match = yaml.match(/\n {4}ErrorCode:\n(?:.*\n)*? {6}enum:\n((?: {6}- .+\n)+)/);
  assert.ok(match, "ErrorCode schema with an enum list not found in sdk/openapi.yaml");
  const published = match[1].split("\n").filter(Boolean).map((l) => l.replace(/^ {6}- /, "").replace(/^'(.*)'$/, "$1"));
  assert.deepEqual([...ERROR_CODES].sort(), [...published].sort(),
    "src/generated/error-codes.gen.ts has drifted from sdk/openapi.yaml — run ./scripts/sync-sdk-core.sh");
});
