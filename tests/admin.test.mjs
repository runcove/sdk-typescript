// `client.admin` round trips against a fake fetch: for every admin operation,
// the verb, the path (with an encoded segment where the path has one), the
// query or body sent, and that the server's response comes back unchanged.
// Response bodies use the field names of each operation's response schema in
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
const queryOf = (call) => Object.fromEntries(new URL(call.url).searchParams);
const bodyOf = (call) => JSON.parse(call.init.body);

// ---------------------------------------------------------------------------
// 1a — fleet
// ---------------------------------------------------------------------------

test("admin.updateAutoPauseTimeouts posts the retimeout request", async () => {
  const reply = {
    dry_run: true,
    target_secs: 900,
    total_auto_pause: 3,
    changed: [{ vm_name: "a", from_secs: 600 }],
    skipped_custom: [],
    by_current_value: { "600": 3 },
  };
  const { calls, impl } = fakeFetch(json(reply));
  const out = await makeClient(impl).admin.updateAutoPauseTimeouts({
    dry_run: true,
    from_secs: 600,
    to_secs: 900,
  });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(pathOf(calls[0]), "/api/admin/auto-pause/retimeout");
  assert.equal(calls[0].init.headers.get("Content-Type"), "application/json");
  assert.deepEqual(bodyOf(calls[0]), { dry_run: true, from_secs: 600, to_secs: 900 });
  assert.deepEqual(out, reply);
});

test("admin.drainHost posts to /api/admin/drain with an optional budget", async () => {
  const reply = { budget_secs: 30, attempted: 2, succeeded: 2, failed: 0, timed_out: 0, targets: [] };
  const { calls, impl } = fakeFetch(json(reply));
  const client = makeClient(impl);
  const out = await client.admin.drainHost({ budget_secs: 30 });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(pathOf(calls[0]), "/api/admin/drain");
  assert.deepEqual(queryOf(calls[0]), { budget_secs: "30" });
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(out, reply);
  // No budget: no query at all, so the host's configured budget applies.
  await client.admin.drainHost();
  assert.deepEqual(queryOf(calls[1]), {});
});

test("admin.getHostState reads /api/admin/host-state", async () => {
  const reply = {
    ttl_pending_count: 1,
    audit_emit_failed_total: 0,
    snapshot_images: [],
    broadcast_lag: 0,
    orphaned_checkpoint_count: 2,
    orphaned_checkpoint_bytes: 4096,
  };
  const { calls, impl } = fakeFetch(json(reply));
  const out = await makeClient(impl).admin.getHostState();
  assert.equal(calls[0].init.method, "GET");
  assert.equal(pathOf(calls[0]), "/api/admin/host-state");
  assert.deepEqual(out, reply);
});

test("admin.updateVmAgents posts the raw bytes to /api/admin/update-agents", async () => {
  const reply = { updated: 2, failed: 0, results: [{ vm_name: "a", ok: true }] };
  const { calls, impl } = fakeFetch(json(reply));
  const bytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
  const out = await makeClient(impl).admin.updateVmAgents(bytes);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(pathOf(calls[0]), "/api/admin/update-agents");
  assert.equal(calls[0].init.headers.get("Content-Type"), "application/octet-stream");
  assert.equal(calls[0].init.body, bytes);
  assert.deepEqual(out, reply);
});

test("admin.bulkDeleteVms posts the scope to /api/admin/vms/delete-bulk", async () => {
  const req = { scope: { type: "user", username: "a b" }, dry_run: true };
  const reply = {
    dry_run: true,
    scope: { type: "user", username: "a b" },
    attempted: 1,
    succeeded: 1,
    failed: 0,
    targets: [{ vm_id: "v1", vm_name: "web", state_before: "running", result: "would_delete" }],
  };
  const { calls, impl } = fakeFetch(json(reply));
  const out = await makeClient(impl).admin.bulkDeleteVms(req);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(pathOf(calls[0]), "/api/admin/vms/delete-bulk");
  assert.deepEqual(bodyOf(calls[0]), req);
  assert.deepEqual(out, reply);
});

test("admin.bulkStopVms posts the scope to /api/admin/vms/stop-bulk", async () => {
  const req = { scope: { type: "vms", vm_names: ["a", "b"] } };
  const reply = { dry_run: false, scope: req.scope, attempted: 2, succeeded: 1, failed: 1, targets: [] };
  const { calls, impl } = fakeFetch(json(reply));
  const out = await makeClient(impl).admin.bulkStopVms(req);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(pathOf(calls[0]), "/api/admin/vms/stop-bulk");
  assert.deepEqual(bodyOf(calls[0]), req);
  assert.deepEqual(out, reply);
});

// ---------------------------------------------------------------------------
// 1b — projects and quotas
// ---------------------------------------------------------------------------

test("admin.listProjectMembers reads /api/admin/projects/{project_id}/members", async () => {
  const reply = [
    { project_id: "p 1", username: "alice", added_by: "root", added_at: "2026-09-30T00:00:00Z" },
  ];
  const { calls, impl } = fakeFetch(json(reply));
  const out = await makeClient(impl).admin.listProjectMembers("p 1");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(pathOf(calls[0]), "/api/admin/projects/p%201/members");
  assert.deepEqual(out, reply);
});

test("admin.createProjectMember posts {project_id, username} to the project's members", async () => {
  const { calls, impl } = fakeFetch(empty());
  const out = await makeClient(impl).admin.createProjectMember("p 1", "alice");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(pathOf(calls[0]), "/api/admin/projects/p%201/members");
  // The wire requires `project_id` in the body too; the SDK fills it from the
  // path argument so the two can never disagree.
  assert.deepEqual(bodyOf(calls[0]), { project_id: "p 1", username: "alice" });
  assert.equal(out, undefined);
});

test("admin.deleteProjectMember deletes /api/admin/projects/{project_id}/members/{username}", async () => {
  const { calls, impl } = fakeFetch(empty());
  const out = await makeClient(impl).admin.deleteProjectMember("p 1", "a b");
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(pathOf(calls[0]), "/api/admin/projects/p%201/members/a%20b");
  assert.equal(out, undefined);
});

test("admin.getQuotaDefaults reads /api/admin/quota-defaults", async () => {
  const reply = { vcpus_max: 16, ram_mb_max: 65536, vm_count_max: 10, disk_gb_max: 500 };
  const { calls, impl } = fakeFetch(json(reply));
  const out = await makeClient(impl).admin.getQuotaDefaults();
  assert.equal(calls[0].init.method, "GET");
  assert.equal(pathOf(calls[0]), "/api/admin/quota-defaults");
  assert.deepEqual(out, reply);
});

test("admin.getUserQuotaOverride reads /api/admin/quotas/{username}", async () => {
  const reply = { username: "a b", vcpus_max: 32, ram_mb_max: null, vm_count_max: null, disk_gb_max: null };
  const { calls, impl } = fakeFetch(json(reply));
  const out = await makeClient(impl).admin.getUserQuotaOverride("a b");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(pathOf(calls[0]), "/api/admin/quotas/a%20b");
  assert.deepEqual(out, reply);
});

test("admin.updateUserQuotaOverride puts the override to /api/admin/quotas/{username}", async () => {
  const { calls, impl } = fakeFetch(empty());
  const out = await makeClient(impl).admin.updateUserQuotaOverride("a b", {
    vcpus_max: 32,
    ram_mb_max: null,
  });
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(pathOf(calls[0]), "/api/admin/quotas/a%20b");
  assert.deepEqual(bodyOf(calls[0]), { vcpus_max: 32, ram_mb_max: null });
  assert.equal(out, undefined);
});

test("admin.deleteUserQuotaOverride deletes /api/admin/quotas/{username}", async () => {
  const { calls, impl } = fakeFetch(empty());
  const out = await makeClient(impl).admin.deleteUserQuotaOverride("a b");
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(pathOf(calls[0]), "/api/admin/quotas/a%20b");
  assert.equal(out, undefined);
});

test("admin.createQuotaBypass posts to /api/admin/quotas/{username}/force-create", async () => {
  const reply = {
    bypass_id: "b1",
    username: "a b",
    granted_by: "root",
    granted_at: "2026-09-30T00:00:00Z",
  };
  const { calls, impl } = fakeFetch(json(reply));
  const out = await makeClient(impl).admin.createQuotaBypass("a b");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(pathOf(calls[0]), "/api/admin/quotas/a%20b/force-create");
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(out, reply);
});

test("admin.getTeamQuotaOverride reads /api/admin/team-quotas/{team_id}", async () => {
  const reply = { team_id: "t 1", vcpus_max: null, ram_mb_max: 8192, vm_count_max: null, disk_gb_max: null };
  const { calls, impl } = fakeFetch(json(reply));
  const out = await makeClient(impl).admin.getTeamQuotaOverride("t 1");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(pathOf(calls[0]), "/api/admin/team-quotas/t%201");
  assert.deepEqual(out, reply);
});

test("admin.updateTeamQuotaOverride puts the override to /api/admin/team-quotas/{team_id}", async () => {
  const { calls, impl } = fakeFetch(empty());
  const out = await makeClient(impl).admin.updateTeamQuotaOverride("t 1", { vm_count_max: 4 });
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(pathOf(calls[0]), "/api/admin/team-quotas/t%201");
  assert.deepEqual(bodyOf(calls[0]), { vm_count_max: 4 });
  assert.equal(out, undefined);
});

test("admin.deleteTeamQuotaOverride deletes /api/admin/team-quotas/{team_id}", async () => {
  const { calls, impl } = fakeFetch(empty());
  const out = await makeClient(impl).admin.deleteTeamQuotaOverride("t 1");
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(pathOf(calls[0]), "/api/admin/team-quotas/t%201");
  assert.equal(out, undefined);
});

// ---------------------------------------------------------------------------
// 1c — users
// ---------------------------------------------------------------------------

const userSummary = {
  username: "a b",
  display_name: "A B",
  created_at: "2026-01-01T00:00:00Z",
  last_seen_at: "2026-09-30T00:00:00Z",
  usage: { vcpus: 2, ram_mb: 2048, vm_count: 1, disk_gb: 20 },
};

test("admin.listAllUsers reads /api/admin/users", async () => {
  const { calls, impl } = fakeFetch(json([userSummary]));
  const out = await makeClient(impl).admin.listAllUsers();
  assert.equal(calls[0].init.method, "GET");
  assert.equal(pathOf(calls[0]), "/api/admin/users");
  assert.deepEqual(out, [userSummary]);
});

test("admin.getUser reads /api/admin/users/{username}", async () => {
  const { calls, impl } = fakeFetch(json(userSummary));
  const out = await makeClient(impl).admin.getUser("a b");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(pathOf(calls[0]), "/api/admin/users/a%20b");
  assert.deepEqual(out, userSummary);
});

test("admin.revokeUserSessions posts to /api/admin/users/{username}/revoke-sessions", async () => {
  const { calls, impl } = fakeFetch(json({ revoked: 3 }));
  const out = await makeClient(impl).admin.revokeUserSessions("a b");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(pathOf(calls[0]), "/api/admin/users/a%20b/revoke-sessions");
  assert.deepEqual(out, { revoked: 3 });
});

test("admin.offboardUser posts dry_run to /api/admin/users/{username}/offboard", async () => {
  const report = {
    username: "a b",
    dry_run: true,
    cli_sessions_revoked: 0,
    api_keys_revoked: [],
    connected_apps_revoked: [],
    service_keys: [],
    shares_withdrawn: [],
    webhooks_disabled: [],
    warpgate_role: { name: "cove-a-b-0123456789ab", id: "r", outcome: "deleted" },
    teams_left: [],
    secrets_deleted: [],
    secrets_kept: "",
    vms_stopped: [{ vm: "v", outcome: "stopped" }],
  };
  const { calls, impl } = fakeFetch(json(report));
  const out = await makeClient(impl).admin.offboardUser("a b", { dry_run: true });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(pathOf(calls[0]), "/api/admin/users/a%20b/offboard");
  assert.deepEqual(JSON.parse(calls[0].init.body), { dry_run: true });
  assert.deepEqual(out, report);
});

test("unit_offboard_user_always_sends_an_explicit_dry_run", async () => {
  // The server refuses `{}`, so neither a missing request nor an undefined
  // field may send it: both are an explicit `dry_run: false`.
  for (const req of [undefined, {}, { dry_run: undefined }, Object.create(null)]) {
    const { calls, impl } = fakeFetch(json({}));
    await makeClient(impl).admin.offboardUser("a", req);
    assert.deepEqual(JSON.parse(calls[0].init.body), { dry_run: false });
  }
});

test("unit_offboard_user_refuses_a_malformed_request_and_sends_nothing", async () => {
  // A JavaScript caller gets no excess-property check: each of these would
  // otherwise send `dry_run: false` and offboard for real where a preview
  // was meant.
  for (const req of [
    true,
    "dry",
    null,
    [],
    { dryRun: true },
    { dry_run: "true" },
    { dry_run: 1 },
    { dry_run: true, extra: 1 },
    5n,
    { dry_run: 1n },
    // Objects with no own keys, or not plain objects: never a request.
    new Boolean(true),
    new Map([["dry_run", true]]),
    new Date(0),
    // Own keys a key listing would skip.
    Object.defineProperty({}, "dryRun", { value: true, enumerable: false }),
    { [Symbol("dry_run")]: true },
    new (class Req {
      constructor() {
        this.dry_run = true;
      }
    })(),
  ]) {
    const { calls, impl } = fakeFetch(json({}));
    await assert.rejects(
      async () => makeClient(impl).admin.offboardUser("a", req),
      TypeError,
      `request ${String(req)} must be refused`,
    );
    assert.equal(calls.length, 0, `request ${String(req)} must send nothing`);
  }
});

// ---------------------------------------------------------------------------
// 1d — listings and checkpoints
// ---------------------------------------------------------------------------

test("admin.listAllVms reads /api/admin/vms with user, limit and cursor", async () => {
  const reply = {
    vms: [
      {
        vm_id: "v1",
        vm_name: "web",
        owner: "a b",
        state: "running",
        image: "fedora",
        created_at: "2026-09-30T00:00:00Z",
        updated_at: "2026-09-30T00:00:00Z",
      },
    ],
    next_cursor: "c2",
  };
  const { calls, impl } = fakeFetch(json(reply));
  const out = await makeClient(impl).admin.listAllVms({ user: "a b", limit: 1, cursor: "c1" });
  assert.equal(calls[0].init.method, "GET");
  assert.equal(pathOf(calls[0]), "/api/admin/vms");
  assert.deepEqual(queryOf(calls[0]), { user: "a b", limit: "1", cursor: "c1" });
  assert.deepEqual(out, reply);
});

test("admin.iterAllVms follows next_cursor across pages and stops on null", async () => {
  const { calls, impl } = fakeFetch(
    json({ vms: [{ vm_name: "a" }, { vm_name: "b" }], next_cursor: "c2" }),
    json({ vms: [{ vm_name: "c" }], next_cursor: null }),
  );
  const seen = [];
  for await (const vm of makeClient(impl).admin.iterAllVms({ user: "u", limit: 2 })) {
    seen.push(vm.vm_name);
  }
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).searchParams.has("cursor"), false);
  assert.deepEqual(queryOf(calls[1]), { user: "u", limit: "2", cursor: "c2" });
});

test("admin.listAnyCheckpoints reads /api/admin/checkpoints with its filters", async () => {
  const reply = {
    checkpoints: [
      {
        checkpoint_id: "k1",
        owner_username: "a b",
        created_at: "2025-09-30T00:00:00Z",
        state: "available",
        orphaned: true,
        size_bytes: 4096,
      },
    ],
    next_cursor: null,
  };
  const { calls, impl } = fakeFetch(json(reply));
  const out = await makeClient(impl).admin.listAnyCheckpoints({
    user: "a b",
    orphaned: true,
    limit: 10,
    cursor: "c1",
  });
  assert.equal(calls[0].init.method, "GET");
  assert.equal(pathOf(calls[0]), "/api/admin/checkpoints");
  assert.deepEqual(queryOf(calls[0]), { user: "a b", orphaned: "true", limit: "10", cursor: "c1" });
  assert.deepEqual(out, reply);
});

test("admin.iterAnyCheckpoints follows next_cursor across pages and stops on null", async () => {
  const { calls, impl } = fakeFetch(
    json({ checkpoints: [{ checkpoint_id: "k1" }, { checkpoint_id: "k2" }], next_cursor: "c2" }),
    json({ checkpoints: [{ checkpoint_id: "k3" }], next_cursor: null }),
  );
  const seen = [];
  for await (const cp of makeClient(impl).admin.iterAnyCheckpoints({ orphaned: true, limit: 2 })) {
    seen.push(cp.checkpoint_id);
  }
  assert.deepEqual(seen, ["k1", "k2", "k3"]);
  assert.equal(calls.length, 2);
  assert.deepEqual(queryOf(calls[1]), { orphaned: "true", limit: "2", cursor: "c2" });
});

test("admin.deleteAnyCheckpoint deletes /api/admin/checkpoints/{id}", async () => {
  const { calls, impl } = fakeFetch(empty());
  const out = await makeClient(impl).admin.deleteAnyCheckpoint("k 1");
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(pathOf(calls[0]), "/api/admin/checkpoints/k%201");
  assert.equal(out, undefined);
});

test("admin methods pass the caller's RequestOverrides through", async () => {
  const { calls, impl } = fakeFetch(json({ revoked: 0 }));
  await makeClient(impl).admin.revokeUserSessions("a", { headers: { "X-Trace": "t1" } });
  assert.equal(calls[0].init.headers.get("X-Trace"), "t1");
});
