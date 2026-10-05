/**
 * Signature verification for Cove lifecycle webhook deliveries.
 *
 * Cove signs every delivery with HMAC-SHA256 over `<ce-id>.<ce-time>.<raw body>`
 * using the subscription's `whsec_…` secret and sends the lowercase hex digest
 * as `Cove-Signature: v1,<hex>`. During rotation grace the header carries two
 * space-separated `v1,<hex>` entries — a delivery is authentic if ANY entry
 * verifies against ANY configured secret.
 *
 * Runs on WebCrypto, so it works in browsers and Node alike (Node 18 lacks the
 * `crypto` global — we fall back to `node:crypto`'s `webcrypto` export there).
 */

export interface VerifyWebhookOptions {
  /**
   * Subscription secret(s) (`whsec_…`, shown once on create/rotate). Pass
   * both the new and the old secret during rotation grace.
   */
  secret: string | string[];
  /**
   * The delivery request's headers — a `Headers` object or a plain record
   * (looked up case-insensitively). Must contain `ce-id`, `ce-time`, and
   * `Cove-Signature`.
   */
  headers: Headers | Record<string, string>;
  /**
   * The raw request body, byte-exact as received. Never re-serialize parsed
   * JSON — key order or whitespace drift breaks the signature.
   */
  body: string | Uint8Array;
  /**
   * Replay window in seconds: reject a delivery whose signed `ce-time` is
   * further than this from now, in either direction (clocks drift both ways).
   * Defaults to 300. Pass `0` to accept any age.
   *
   * This bounds how long a captured delivery stays replayable; it does not make
   * deliveries unique. Cove retries, so the same `ce-id` legitimately arrives
   * more than once inside the window — deduplicating on `ce-id` remains the
   * caller's job.
   */
  toleranceSecs?: number;
}

/**
 * Verify a webhook delivery's `Cove-Signature` header.
 *
 * Returns `true` when any signature entry matches any secret (constant-time
 * comparison) and the delivery is inside the replay window (see
 * {@link VerifyWebhookOptions.toleranceSecs}). Throws `TypeError` on malformed
 * input — empty secret or a missing `ce-id` / `ce-time` / `Cove-Signature`
 * header — so misconfiguration fails loudly instead of silently rejecting
 * every delivery.
 *
 * ```ts
 * import { verifyWebhookSignature } from "@runcove/sdk";
 *
 * const authentic = await verifyWebhookSignature({
 *   secret: process.env.COVE_WEBHOOK_SECRET,
 *   headers: request.headers,
 *   body: rawBody, // bytes/text as received, NOT JSON.stringify(parsed)
 * });
 * if (!authentic) return new Response("bad signature", { status: 401 });
 * ```
 */
export async function verifyWebhookSignature(opts: VerifyWebhookOptions): Promise<boolean> {
  const secrets = Array.isArray(opts.secret) ? opts.secret : [opts.secret];
  if (secrets.length === 0 || secrets.some((s) => !s)) {
    throw new TypeError("verifyWebhookSignature: secret must be non-empty");
  }
  const ceId = headerGet(opts.headers, "ce-id");
  const ceTime = headerGet(opts.headers, "ce-time");
  const sigHeader = headerGet(opts.headers, "cove-signature");
  if (!ceId || !ceTime || !sigHeader) {
    throw new TypeError(
      "verifyWebhookSignature: missing ce-id, ce-time, or Cove-Signature header",
    );
  }
  // `ce-time` is signature-covered, so it cannot be forged without the secret —
  // but an authentic delivery captured off the wire replays forever without a
  // window on it.
  if (!withinReplayWindow(ceTime, opts.toleranceSecs ?? DEFAULT_TOLERANCE_SECS)) return false;
  const candidates = sigHeader
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.startsWith("v1,"))
    .map((t) => t.slice("v1,".length).toLowerCase());
  if (candidates.length === 0) return false;

  const encoder = new TextEncoder();
  const prefix = encoder.encode(`${ceId}.${ceTime}.`);
  const body = typeof opts.body === "string" ? encoder.encode(opts.body) : opts.body;
  const payload = new Uint8Array(prefix.length + body.length);
  payload.set(prefix, 0);
  payload.set(body, prefix.length);

  const subtle = await getSubtle();
  let authentic = false;
  for (const secret of secrets) {
    const key = await subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = toHex(new Uint8Array(await subtle.sign("HMAC", key, payload)));
    for (const candidate of candidates) {
      // No early exit: check every pair so timing doesn't leak which matched.
      if (timingSafeEqualStr(digest, candidate)) authentic = true;
    }
  }
  return authentic;
}

/** Default replay window, in seconds. */
const DEFAULT_TOLERANCE_SECS = 300;

/**
 * Is the delivery's `ce-time` inside the replay window? An unparseable
 * timestamp is treated as outside it (rejected), not as an argument error —
 * a malformed delivery is the sender's problem, not a misconfiguration.
 */
function withinReplayWindow(ceTime: string, toleranceSecs: number): boolean {
  if (toleranceSecs <= 0) return true;
  const sentAt = Date.parse(ceTime);
  if (Number.isNaN(sentAt)) return false;
  return Math.abs(Date.now() - sentAt) <= toleranceSecs * 1000;
}

function headerGet(headers: Headers | Record<string, string>, name: string): string | null {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

async function getSubtle(): Promise<SubtleCrypto> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (subtle) return subtle;
  // Node 18 has no `crypto` global (unflagged only from Node 19); browsers
  // and edge runtimes never reach this branch. The specifier is assembled at
  // runtime and flagged for the two bundlers that honour a hint, because a
  // statically visible `node:crypto` here fails the whole bundle: this module
  // is re-exported from the package entry, so every browser consumer of
  // `CoveClient` drags it in.
  const spec = "node:" + "crypto";
  const nodeCrypto = (await import(/* webpackIgnore: true */ /* @vite-ignore */ spec)) as {
    webcrypto: Crypto;
  };
  return nodeCrypto.webcrypto.subtle;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Constant-time string equality (both operands are hex of equal length in practice). */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
