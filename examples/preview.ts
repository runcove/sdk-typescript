#!/usr/bin/env node
// A preview for every pull request: when a pull request opens, create a VM tagged with its
// number, check out its branch, start the app, and publish the app's port; the URL is what
// you post on the pull request. When it closes, delete every VM with that tag. Your CI or
// your forge's webhook calls the two functions; this program calls both in turn.
//
//   COVE_URL=http://127.0.0.1:8090 COVE_TOKEN=cvk_... \
//     PREVIEW_REPO_URL=https://example.com/your/repo.git PR_NUMBER=123 PR_BRANCH=my-change \
//     node examples/preview.ts
//   node examples/preview.ts --mock     # offline, against an in-memory fake server
//
// Needs git, python3 and curl in the VM's image, and the app's port in the host's allowed
// list. The app is `python3 -m http.server`, serving the checkout; start yours with its own
// command. Node 22.18 or later runs this file as it is; run `npm run build` first.
import { CoveClient, CoveAPIError } from "@runcove/sdk";

// The port the app listens on. The host refuses a port that is not in its allowed list.
const PORT = 8080;

const mock = process.argv.includes("--mock");
const client = mock
  ? // The in-memory fake server, loaded only for --mock: a copy of this file needs no _mock.ts.
    new CoveClient({ baseUrl: "https://cove.mock", token: "cvk_mock", fetch: (await import("./_mock.ts")).mockFetch() })
  : new CoveClient({ baseUrl: env("COVE_URL"), token: env("COVE_TOKEN"), timeoutMs: 30_000 });
const repoUrl = mock ? "https://example.com/demo.git" : env("PREVIEW_REPO_URL");
const pr = mock ? "123" : env("PR_NUMBER");
const branch = mock ? "my-change" : env("PR_BRANCH");

try {
  const url = await opened(pr, branch);
  console.log(`preview for pull request ${pr}: ${url}`);
} catch (err) {
  if (!(err instanceof CoveAPIError)) throw err;
  console.error(`API error ${err.status} ${err.code}: ${err.message}`);
  process.exitCode = 1;
} finally {
  // Here at once, so a demo run leaves nothing; for real, when the pull request closes.
  await closed(pr);
}

/** The pull request opened: build its preview and return the URL. */
async function opened(pr: string, branch: string): Promise<string> {
  const { name } = await client.vms.create({ name: `pr-${pr}`, initial_tags: { pr } });
  console.log(`created ${name}`);
  await client.vms.waitForState(name, ["running"], { timeoutMs: 300_000, intervalMs: mock ? 10 : 1000 });

  await run(name, ["git", "clone", "--depth", "1", "--branch", branch, repoUrl, "/root/app"]);
  // `setsid -f` starts the server in the background, in a session of its own, so it keeps
  // running after this command returns. Then wait until it answers, retrying for about 10 s.
  await run(name, ["sh", "-c", `setsid -f python3 -m http.server ${PORT} --directory /root/app > /root/app.log 2>&1`]);
  await run(name, ["curl", "-fsS", "--retry", "10", "--retry-delay", "1", "--retry-connrefused", "-o", "/dev/null", `http://127.0.0.1:${PORT}/`]);
  console.log(`app is up on port ${PORT}`);

  // Publish the port: the host proxies HTTPS to it. Only you, the people you share the VM
  // with and administrators can open the URL, after signing in, until you make it public or
  // send an invite link.
  await client.vms.addPort(name, { port: PORT });
  const info = await client.vms.getUrl(name);
  const published = info.ports.find((p) => p.port === PORT);
  if (!published) throw new Error(`port ${PORT} is not in ${name}'s URLs`);
  return published.url;
}

/** The pull request closed: delete every VM tagged with its number. */
async function closed(pr: string): Promise<void> {
  const names: string[] = [];
  for await (const vm of client.vms.iter({ tag: `pr=${pr}` })) names.push(vm.name);
  for (const name of names) {
    await client.vms.delete(name);
    console.log(`deleted ${name}`);
  }
}

/** Run a command in the VM and fail if it fails. */
async function run(vm: string, command: string[]): Promise<void> {
  const out = await client.vms.execCollect(vm, { command, timeoutSecs: 600 });
  if (out.exitCode !== 0) throw new Error(`${command.join(" ")} failed (exit ${out.exitCode}): ${out.stderr}`);
}

function env(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.error(`set ${key} (see the top of this file), or run with --mock`);
    process.exit(1);
  }
  return value;
}
