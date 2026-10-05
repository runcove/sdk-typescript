import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  BearerAuth,
  CoveClient,
  CoveConfigError,
  resolveAuth,
  TicketAuth,
} from "../dist/index.js";

async function appliedHeaders(auth) {
  const headers = new Headers();
  await auth.apply(headers);
  return headers;
}

test("token resolves to BearerAuth with Bearer header", async () => {
  const auth = resolveAuth({ token: "cvk_abc" });
  assert.ok(auth instanceof BearerAuth);
  const headers = await appliedHeaders(auth);
  assert.equal(headers.get("Authorization"), "Bearer cvk_abc");
});

test("ticket resolves to TicketAuth with Warpgate header", async () => {
  const auth = resolveAuth({ ticket: "t123" });
  assert.ok(auth instanceof TicketAuth);
  const headers = await appliedHeaders(auth);
  assert.equal(headers.get("Authorization"), "Warpgate t123");
});

test("custom auth strategy passes through untouched", () => {
  const custom = { apply() {} };
  assert.equal(resolveAuth({ auth: custom }), custom);
});

test("no credential throws", () => {
  assert.throws(() => resolveAuth({}), CoveConfigError);
});

test("two credentials throw", () => {
  assert.throws(() => resolveAuth({ token: "a", ticket: "b" }), /exactly one/);
});

test("empty token throws", () => {
  assert.throws(() => resolveAuth({ token: "" }), /non-empty/);
});

test("empty ticket throws", () => {
  assert.throws(() => resolveAuth({ ticket: "" }), /non-empty/);
});

test("the credential never reaches JSON.stringify or util.inspect of the client", () => {
  // TypeScript `private` is erased at compile time, so the token used to be an
  // ordinary enumerable property — printed once per resource group by any log
  // line that stringified the client.
  const client = new CoveClient({
    baseUrl: "https://cove.test",
    token: "cvk_supersecretvalue",
    fetch: async () => new Response("[]"),
  });
  for (const rendering of [JSON.stringify(client), inspect(client, { depth: null })]) {
    assert.equal(rendering.includes("cvk_supersecretvalue"), false, rendering);
  }
});

test("a Warpgate ticket is hidden the same way", () => {
  const client = new CoveClient({
    baseUrl: "https://cove.test",
    ticket: "wgt_supersecretticket",
    fetch: async () => new Response("[]"),
  });
  for (const rendering of [JSON.stringify(client), inspect(client, { depth: null })]) {
    assert.equal(rendering.includes("wgt_supersecretticket"), false, rendering);
  }
});

test("the auth strategies expose no credential of their own", () => {
  assert.equal(JSON.stringify(new BearerAuth("cvk_secret")), "{}");
  assert.equal(inspect(new BearerAuth("cvk_secret")).includes("cvk_secret"), false);
  assert.equal(JSON.stringify(new TicketAuth("wgt_secret")), "{}");
  assert.equal(inspect(new TicketAuth("wgt_secret")).includes("wgt_secret"), false);
});
