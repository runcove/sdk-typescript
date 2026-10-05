// `client.teams`, `client.meta.users()`, `client.meta.openapi()` and the VM
// sharing methods: round trips against a fake fetch. For every operation, the
// verb, the path (with encoded segments where the path has them), the body
// sent, and that the server's response comes back unchanged. Response bodies
// use the field names of each operation's response schema in
// `sdk/openapi.yaml`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CoveClient } from "../dist/index.js";

/** Fake fetch that records calls and replays queued responses (last one sticks). */
function fakeFetch(...responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return next();
  };
  return { calls, impl };
}

const json = (body, status = 200) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const empty = (status = 204) => () => new Response(null, { status });

function makeClient(fetchImpl) {
  return new CoveClient({ baseUrl: "https://cove.test/", token: "cvk_x", fetch: fetchImpl });
}

const pathOf = (call) => new URL(call.url).pathname;
const bodyOf = (call) => JSON.parse(call.init.body);

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

const team = {
  id: "t-1",
  name: "platform",
  created_at: "2026-09-30T10:00:00Z",
  created_by: "alice",
  member_count: 2,
};

test("teams.list reads /api/teams", async () => {
  const { calls, impl } = fakeFetch(json([team]));
  const out = await makeClient(impl).teams.list();
  assert.equal(calls[0].init.method, "GET");
  assert.equal(pathOf(calls[0]), "/api/teams");
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(out, [team]);
});

test("teams.create posts the team name to /api/teams", async () => {
  const { calls, impl } = fakeFetch(json(team, 201));
  const out = await makeClient(impl).teams.create({ name: "platform" });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(pathOf(calls[0]), "/api/teams");
  assert.equal(calls[0].init.headers.get("Content-Type"), "application/json");
  assert.deepEqual(bodyOf(calls[0]), { name: "platform" });
  assert.deepEqual(out, team);
});

test("teams.delete deletes /api/teams/{name} and returns the outcome", async () => {
  const reply = { revoked_vm_count: 0, unconfirmed_edges: ["edge-1"], unconfirmed_sessions: [] };
  const { calls, impl } = fakeFetch(json(reply));
  const out = await makeClient(impl).teams.delete("a b");
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(pathOf(calls[0]), "/api/teams/a%20b");
  assert.deepEqual(out, reply);
});

test("teams.listMembers reads /api/teams/{name}/members", async () => {
  const reply = [{ username: "bob", added_at: "2026-09-30T10:00:00Z", added_by: "alice" }];
  const { calls, impl } = fakeFetch(json(reply));
  const out = await makeClient(impl).teams.listMembers("a b");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(pathOf(calls[0]), "/api/teams/a%20b/members");
  assert.deepEqual(out, reply);
});

test("teams.createMember posts the username to /api/teams/{name}/members", async () => {
  // The server answers 201 with no body.
  const { calls, impl } = fakeFetch(empty(201));
  const out = await makeClient(impl).teams.createMember("a b", { username: "bob" });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(pathOf(calls[0]), "/api/teams/a%20b/members");
  assert.deepEqual(bodyOf(calls[0]), { username: "bob" });
  assert.equal(out, undefined);
});

test("teams.deleteMember deletes /api/teams/{name}/members/{username}", async () => {
  const reply = { removed: true, unconfirmed_edges: [], unconfirmed_sessions: ["s-1"] };
  const { calls, impl } = fakeFetch(json(reply));
  const out = await makeClient(impl).teams.deleteMember("a b", "c/d");
  assert.equal(calls[0].init.method, "DELETE");
  // `/` inside a segment is encoded, so a username cannot retarget the path.
  assert.equal(pathOf(calls[0]), "/api/teams/a%20b/members/c%2Fd");
  assert.deepEqual(out, reply);
});

// ---------------------------------------------------------------------------
// Users and the contract
// ---------------------------------------------------------------------------

test("meta.users reads /api/users and returns the usernames", async () => {
  const { calls, impl } = fakeFetch(json(["alice", "bob"]));
  const out = await makeClient(impl).meta.users();
  assert.equal(calls[0].init.method, "GET");
  assert.equal(pathOf(calls[0]), "/api/users");
  assert.deepEqual(out, ["alice", "bob"]);
});

test("meta.meConnectedApps reads /api/me/connected-apps and returns the apps", async () => {
  const apps = [
    {
      id: "app_1",
      client_id: "https://claude.ai/oauth/mcp-client-metadata",
      client_name: "Claude",
      access: "non_destructive",
      created_at: "2026-10-01T00:00:00Z",
      expires_at: "2026-12-30T00:00:00Z",
      last_used_at: null,
    },
  ];
  const { calls, impl } = fakeFetch(json(apps));
  const out = await makeClient(impl).meta.meConnectedApps();
  assert.equal(calls[0].init.method, "GET");
  assert.equal(pathOf(calls[0]), "/api/me/connected-apps");
  assert.deepEqual(out, apps);
});

test("meta.openapi reads /api/openapi.json and returns the parsed document", async () => {
  const doc = { openapi: "3.1.0", info: { title: "cove", version: "5" }, paths: {} };
  const { calls, impl } = fakeFetch(json(doc));
  const out = await makeClient(impl).meta.openapi();
  assert.equal(calls[0].init.method, "GET");
  assert.equal(pathOf(calls[0]), "/api/openapi.json");
  assert.equal(out.openapi, "3.1.0");
  assert.deepEqual(out, doc);
});

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

test("vms.listShared reads /api/vms/shared-with-me", async () => {
  const reply = [{ name: "box", owner: "alice", image: "fedora-43", state: "running" }];
  const { calls, impl } = fakeFetch(json(reply));
  const out = await makeClient(impl).vms.listShared();
  assert.equal(calls[0].init.method, "GET");
  assert.equal(pathOf(calls[0]), "/api/vms/shared-with-me");
  assert.deepEqual(out, reply);
});

test("vms.listAccess reads /api/vms/{name}/access", async () => {
  const reply = [
    {
      subject_type: "user",
      subject_id: "bob",
      role: "collaborator",
      granted_at: "2026-09-30T10:00:00Z",
      granted_by: "alice",
    },
  ];
  const { calls, impl } = fakeFetch(json(reply));
  const out = await makeClient(impl).vms.listAccess("a b");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(pathOf(calls[0]), "/api/vms/a%20b/access");
  assert.deepEqual(out, reply);
});

test("vms.grantAccess posts the grant and returns GrantShareOutcome", async () => {
  const { calls, impl } = fakeFetch(json({ user_known: false }, 201));
  const out = await makeClient(impl).vms.grantAccess("a b", {
    subject_type: "user",
    subject_id: "bob",
    role: "collaborator",
  });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(pathOf(calls[0]), "/api/vms/a%20b/access");
  assert.deepEqual(bodyOf(calls[0]), {
    subject_type: "user",
    subject_id: "bob",
    role: "collaborator",
  });
  assert.deepEqual(out, { user_known: false });
});

test("vms.revokeAccess deletes /api/vms/{name}/access/{subject_type}/{subject_id}", async () => {
  const reply = { revoked: true, unconfirmed_edges: [], unconfirmed_sessions: [] };
  const { calls, impl } = fakeFetch(json(reply));
  const out = await makeClient(impl).vms.revokeAccess("a b", "team", "x/y");
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(pathOf(calls[0]), "/api/vms/a%20b/access/team/x%2Fy");
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(out, reply);
});

// ---------------------------------------------------------------------------
// Sessions and the caller's permissions
// ---------------------------------------------------------------------------

test("meta.sessions reads /api/me/sessions and returns the list unchanged", async () => {
  const sessions = [
    {
      id: "s-1",
      created_at: "2026-10-01T10:00:00Z",
      expires_at: null,
      last_used_at: "2026-10-01T11:00:00Z",
      last_used_ip: "<ip>",
      state: "active",
      target_name: "dev-vm",
    },
  ];
  const { calls, impl } = fakeFetch(json(sessions));
  const out = await makeClient(impl).meta.sessions();
  assert.equal(calls[0].init.method, "GET");
  assert.equal(pathOf(calls[0]), "/api/me/sessions");
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(out, sessions);
});

test("hasScope reads a key's complete scope list, and answers true for a session", async () => {
  const { hasScope } = await import("../dist/index.js");
  const key = (scopes) => ({ username: "alice", permissions: { kind: "key", scopes } });
  assert.equal(hasScope(key(["vms:read"]), "vms:read"), true);
  assert.equal(hasScope(key(["vms:read", "tags:read"]), "tags:read"), true);
  assert.equal(hasScope(key([]), "vms:read"), false);
  // Exact match: holding one permission says nothing about another.
  assert.equal(hasScope(key(["vms:read"]), "vms:write"), false);
  // A session has no scope list: not restricted.
  assert.equal(hasScope({ username: "alice", permissions: { kind: "session" } }, "vms:write"), true);
});

test("hasScope: bare admin satisfies every admin:… permission and nothing else", async () => {
  const { hasScope } = await import("../dist/index.js");
  const me = { username: "root", is_admin: true, permissions: { kind: "key", scopes: ["admin"] } };
  assert.equal(hasScope(me, "admin:users:read"), true);
  assert.equal(hasScope(me, "admin"), true);
  assert.equal(hasScope(me, "vms:read"), false);
  // `admin:quotas` is not a hierarchy: holding one admin:… permission gives no other.
  const narrow = {
    username: "op",
    is_admin: true,
    permissions: { kind: "key", scopes: ["admin:quotas:read"] },
  };
  assert.equal(hasScope(narrow, "admin:quotas:read"), true);
  assert.equal(hasScope(narrow, "admin:quotas:write"), false);
});

test("hasScope: an admin permission needs the admin check too (is_admin), on a key or a session", async () => {
  const { hasScope } = await import("../dist/index.js");
  // An ordinary key (not minted as an admin key) that lists `admin`: the
  // server's admin check refuses it, so `/me` reports is_admin false.
  const unflagged = { username: "root", is_admin: false, permissions: { kind: "key", scopes: ["admin", "vms:read"] } };
  assert.equal(hasScope(unflagged, "admin"), false);
  assert.equal(hasScope(unflagged, "admin:users:read"), false);
  // Positive control: its non-admin permissions are unaffected.
  assert.equal(hasScope(unflagged, "vms:read"), true);
  // A field-less is_admin is not an admin either.
  assert.equal(hasScope({ username: "root", permissions: { kind: "key", scopes: ["admin"] } }, "admin"), false);
  // A session holds an admin permission only when its user passes the admin check.
  const session = (is_admin) => ({ username: "u", is_admin, permissions: { kind: "session" } });
  assert.equal(hasScope(session(false), "admin:users:read"), false);
  assert.equal(hasScope(session(true), "admin:users:read"), true);
  assert.equal(hasScope(session(false), "vms:write"), true);
});

test("hasScope throws when /me carries no permissions (a server older than the field)", async () => {
  const { hasScope, CoveError } = await import("../dist/index.js");
  assert.throws(() => hasScope({ username: "alice" }, "vms:read"), CoveError);
  assert.throws(() => hasScope({ username: "alice", permissions: null }, "vms:read"), CoveError);
});
