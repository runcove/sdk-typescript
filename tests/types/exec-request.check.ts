// The server refuses a plain exec that carries `selector` (400; sdk/openapi.yaml ExecRequestDto), so
// the public ExecRequestDto is the generated one without it (src/ergonomic.ts), and vms.exec cannot be
// handed one either. Secrets-injected exec is vms.execWithSecrets.
import type { CoveClient, ExecRequestDto } from "../../src/index.js";
const ok: ExecRequestDto = { command: ["true"], timeout_secs: 5 };
void ok;
// @ts-expect-error selector is refused by the server on plain exec; use vms.execWithSecrets
const withSelector: ExecRequestDto = { command: ["true"], selector: { kind: "all" } };
void withSelector;
declare const client: CoveClient;
void client.vms.exec("vm", { command: ["true"], timeoutSecs: 5 });
// @ts-expect-error vms.exec takes no selector either
void client.vms.exec("vm", { command: ["true"], selector: { kind: "all" } });
void client.vms.exec("vm", { command: ["id"], cwd: "/srv", env: { A: "1" }, user: "builder", login: true });
// @ts-expect-error env values are strings
void client.vms.exec("vm", { command: ["id"], env: { A: 1 } });
