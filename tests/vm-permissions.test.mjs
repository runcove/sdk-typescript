// `VmDetail.permissions` is a list of plain strings: a permission name this
// SDK does not know (one a newer server added) reads, it does not reject.
// An owner holds every permission, so failing on one would break every read
// of their VMs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CoveClient } from "../dist/index.js";

test("vms.get keeps an unknown permission name", async () => {
  const vm = {
    vm_id: "0192aaaa-8888-7000-8000-000000000002",
    name: "dev-01",
    state: "running",
    image: "fedora-44",
    mac_address: "52:54:00:aa:bb:cc",
    vcpus: 2,
    memory_mb: 2048,
    disk_size_gb: 20,
    auto_pause_policy: { type: "always_on" },
    created_at: "2026-10-12T00:00:00Z",
    updated_at: "2026-10-12T00:00:00Z",
    permissions: ["vm.view", "vm.teleport", "vm.power"],
  };
  const headers = { "Content-Type": "application/json", "x-cove-api-version": "8" };
  const client = new CoveClient({
    baseUrl: "https://cove.test/",
    token: "cvk_x",
    fetch: async () => new Response(JSON.stringify(vm), { status: 200, headers }),
  });
  const got = await client.vms.get("dev-01");
  assert.deepEqual(got.permissions, ["vm.view", "vm.teleport", "vm.power"]);
  assert.ok(got.permissions.includes("vm.power"));
});
