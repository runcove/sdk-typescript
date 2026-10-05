#!/usr/bin/env node
// Fails if the published ESM entry cannot be bundled for a browser target.
//
// `verifyWebhookSignature` is re-exported from the package entry and carries a
// Node-only WebCrypto fallback, so a statically visible `node:crypto` in it
// breaks every browser consumer of `CoveClient`, not just webhook users:
// esbuild refuses with "Could not resolve node:crypto" and emits no bundle.
//
// Requires network access the first time (esbuild is fetched via npx), so it is
// a standalone `npm run check:browser` rather than part of `npm test`. The
// suite's `tests/packaging.test.mjs` carries the offline equivalent.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entryPoint = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "cove-sdk-browser-"));
const probe = join(dir, "probe.mjs");
writeFileSync(
  probe,
  `import { CoveClient } from ${JSON.stringify(entryPoint)};\nconsole.log(CoveClient);\n`,
);

try {
  execFileSync(
    "npx",
    [
      "--yes",
      "esbuild",
      "--bundle",
      "--platform=browser",
      "--format=esm",
      `--outfile=${join(dir, "bundle.js")}`,
      probe,
    ],
    { stdio: "inherit" },
  );
  console.log("browser bundle: ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
