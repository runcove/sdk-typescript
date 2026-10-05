import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthenticationError,
  ConflictError,
  CoveAPIError,
  CoveClient,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  UnavailableError,
  ValidationError,
} from "../dist/index.js";

test("status codes map to typed subclasses", () => {
  const cases = [
    [401, AuthenticationError],
    [403, PermissionDeniedError],
    [404, NotFoundError],
    [409, ConflictError],
    [422, ValidationError],
    [429, RateLimitError],
    [500, ServerError],
    [503, ServerError],
  ];
  for (const [status, Klass] of cases) {
    const err = CoveAPIError.fromResponse(status, { code: "x", message: "m" });
    assert.ok(err instanceof Klass, `status ${status} should be ${Klass.name}`);
    assert.equal(err.status, status);
  }
});

test("400 validation_failed is a ValidationError, like 422; any other 400 is not", () => {
  const cases = [
    // A request the server cannot decode (cove-server's `extract` module).
    [400, "validation_failed", ValidationError],
    // A well-formed value the server refuses.
    [422, "validation_failed", ValidationError],
    [422, "invalid_selector", ValidationError],
    // Any other 400 keeps the base class.
    [400, "invalid_vm_name", CoveAPIError],
    [400, "bad_request", CoveAPIError],
    // A code maps to its class only on its own status.
    [500, "validation_failed", ServerError],
  ];
  for (const [status, code, Klass] of cases) {
    const body = { code, message: "cpus: invalid type", field: "cpus" };
    const err = CoveAPIError.fromResponse(status, body);
    assert.equal(err.constructor, Klass, `${status} ${code} should be ${Klass.name}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    assert.deepEqual(err.body, body);
  }
});

test("unmapped 4xx falls back to CoveAPIError base", () => {
  const err = CoveAPIError.fromResponse(400, { code: "bad", message: "nope" });
  assert.equal(err.constructor, CoveAPIError);
});

test("extracts code and message from ApiError envelope", () => {
  const err = CoveAPIError.fromResponse(409, {
    code: "name_taken",
    message: "vm exists",
    name: "web-1",
  });
  assert.equal(err.code, "name_taken");
  assert.equal(err.message, "HTTP 409: vm exists");
  assert.deepEqual(err.body, { code: "name_taken", message: "vm exists", name: "web-1" });
});

test("falls back to `error` field for code and message", () => {
  const err = CoveAPIError.fromResponse(422, { error: "invalid_selector" });
  assert.equal(err.code, "invalid_selector");
  assert.match(err.message, /invalid_selector/);
});

test("plain-text body becomes the message", () => {
  const err = CoveAPIError.fromResponse(403, "admin only");
  assert.equal(err.code, undefined);
  assert.equal(err.message, "HTTP 403: admin only");
});

test("code-only body uses the code as message, never [object Object]", () => {
  const err = CoveAPIError.fromResponse(401, { code: "sudo_required", reauth_window_secs: 900 });
  assert.equal(err.message, "HTTP 401: sudo_required");
  assert.equal(err.code, "sudo_required");
});

test("409 admission and quota denials expose `code` as the code", () => {
  // `DenyReason` is internally tagged on `code`, not `reason` —
  // every error body on the API keys its machine-readable discriminant on
  // `code` now, `DenyReason` included.
  const err = CoveAPIError.fromResponse(409, {
    code: "ram_headroom_exceeded",
    requested_mib: 8192,
  });
  assert.equal(err.code, "ram_headroom_exceeded");
  assert.equal(err.message, "HTTP 409: ram_headroom_exceeded");
});

test("the retired `reason` fallback is dead — a stray `reason` key is ignored", () => {
  // Pins the removal: `fromResponse` used to fall back from `code`
  // to `reason` to compensate for `DenyReason`'s old tag. That compensation
  // is gone, so a body carrying only `reason` (no `code`) must NOT surface
  // it as the error's code.
  const err = CoveAPIError.fromResponse(409, {
    reason: "ram_headroom_exceeded",
    requested_mib: 8192,
  });
  assert.equal(err.code, undefined);
});

test("object body without a recognized code or message stringifies as JSON", () => {
  const err = CoveAPIError.fromResponse(409, { detail: "no idea" });
  assert.equal(err.code, undefined);
  assert.equal(err.message, 'HTTP 409: {"detail":"no idea"}');
});

test("empty body gets a generic message", () => {
  const err = CoveAPIError.fromResponse(500, undefined);
  assert.equal(err.message, "HTTP 500: request failed");
});

/** One error response from a fake server, with an optional `Retry-After`. */
async function errorFrom(status, body, retryAfter) {
  const headers = { "Content-Type": "application/json", "x-cove-api-version": "6" };
  if (retryAfter !== undefined) headers["Retry-After"] = retryAfter;
  const client = new CoveClient({
    baseUrl: "https://cove.test/",
    token: "cvk_x",
    fetch: async () => new Response(JSON.stringify(body), { status, headers }),
  });
  try {
    await client.vms.get("box");
  } catch (err) {
    return err;
  }
  assert.fail("expected the call to reject");
}

test("429 rate_limited exposes Retry-After as retryAfterSecs (delta-seconds only)", async () => {
  const body = { code: "rate_limited", message: "too many requests" };
  const cases = [
    ["7", 7],
    [" 12 ", 12],
    ["0", 0],
    [undefined, undefined],
    ["", undefined],
    ["soon", undefined],
    ["-1", undefined],
    ["+5", undefined],
    ["1.5", undefined],
    ["Wed, 21 Oct 2026 07:28:00 GMT", undefined],
  ];
  for (const [header, expected] of cases) {
    const err = await errorFrom(429, body, header);
    assert.ok(err instanceof RateLimitError, `Retry-After ${JSON.stringify(header)}`);
    assert.equal(err.code, "rate_limited");
    assert.equal(err.retryAfterSecs, expected, `Retry-After ${JSON.stringify(header)}`);
  }
});

test("503 exposes Retry-After as retryAfterSecs when the server sends one", async () => {
  const body = { code: "unavailable", message: "busy" };
  const withHeader = await errorFrom(503, body, "3");
  assert.ok(withHeader instanceof ServerError);
  assert.ok(withHeader instanceof UnavailableError);
  assert.equal(withHeader.retryAfterSecs, 3);
  const without = await errorFrom(503, body);
  assert.ok(without instanceof ServerError);
  assert.equal(without.retryAfterSecs, undefined);
});
