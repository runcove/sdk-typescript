/**
 * Minimal Server-Sent-Events parsing over a fetch ReadableStream.
 *
 * Cove streams `POST /vms/{name}/exec` and `GET /vms/{name}/console/stream`
 * as SSE. Handles `event:` / `data:` fields, blank-line dispatch, and `:`
 * comment lines (ignored).
 */

import { CoveConnectionError, CoveError } from "./errors.js";

/**
 * Cap on one unterminated line and on one event's accumulated fields. It counts
 * UTF-16 code units of decoded text; each is at least one byte of input, so the
 * cap never trips below 16 MiB of input.
 */
const MAX_SSE_EVENT = 16 * 1024 * 1024;

const tooBig = () => new CoveError("SSE event exceeded 16 MiB");

export interface ServerSentEvent {
  event: string;
  data: string;
}

/**
 * The header that confirms JSON-string `stdout` / `stderr` chunks on an exec
 * response. SSE ends a data line at a carriage return, so the SDK asks for the
 * chunks JSON-encoded ({@link EXEC_ENCODING_QUERY}) to carry `\r` intact; an
 * older server ignores the request and sends raw chunks without this header.
 */
export const EXEC_ENCODING_HEADER = "x-cove-exec-encoding";

/**
 * The query parameter that asks an exec stream for JSON-string chunks
 * (`?encoding=json`). Not a request header: a released server's CORS preflight
 * refuses a header it does not list, which would stop exec in a browser, while
 * it ignores a query parameter it does not know.
 */
export const EXEC_ENCODING_QUERY = "encoding";

/**
 * How to read an exec response's `stdout` / `stderr` data: JSON-decoded when
 * the response carries `x-cove-exec-encoding: json`, as it came otherwise.
 * Data that is not a JSON string is kept as it came.
 */
export function execChunkDecoder(headers: Headers): (data: string) => string {
  const encoding = headers.get(EXEC_ENCODING_HEADER)?.trim().toLowerCase();
  if (encoding !== "json") return (data) => data;
  return (data) => {
    try {
      const chunk: unknown = JSON.parse(data);
      return typeof chunk === "string" ? chunk : data;
    } catch {
      return data;
    }
  };
}

export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let pending = "";
  let fields: Array<[string, string]> = [];
  let eventSize = 0;

  const dispatch = (): ServerSentEvent | null => {
    if (fields.length === 0) return null;
    let event = "message";
    const data: string[] = [];
    for (const [field, value] of fields) {
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    fields = [];
    eventSize = 0;
    return { event, data: data.join("\n") };
  };

  const feed = (rawLine: string): ServerSentEvent | null => {
    const line = rawLine.replace(/\r$/, "");
    if (line === "") return dispatch();
    if (line.startsWith(":")) return null;
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    eventSize += line.length;
    if (eventSize > MAX_SSE_EVENT) throw tooBig();
    fields.push([field, value]);
    return null;
  };

  let drained = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        const evt = feed(line);
        if (evt) yield evt;
      }
      // Only the leftover partial line is unterminated.
      if (pending.length > MAX_SSE_EVENT) throw tooBig();
    }
    // Flush the decoder (a multi-byte char may straddle the last chunk),
    // then a final unterminated event, if any.
    pending += decoder.decode();
    if (pending !== "") {
      const evt = feed(pending);
      if (evt) yield evt;
    }
    const last = dispatch();
    if (last) yield last;
    drained = true;
  } catch (err) {
    // A mid-stream transport failure (server reset, TLS drop) arrives from
    // `reader.read()` as a bare `TypeError`, which breaks the SDK's contract
    // that everything it throws is a `CoveError` — and long-lived streams are
    // exactly where that happens. Aborts and timeouts stay unwrapped: the stream's
    // deadline is disarmed once a good status arrives, so a `TimeoutError`
    // here is the caller's own.
    if (err instanceof CoveError) throw err;
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw err;
    }
    throw new CoveConnectionError(
      `Stream failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    // Consumers leave early by design — `vms.exec` returns on the `exit` event,
    // console tailing is broken out of. Releasing the lock alone leaves the
    // request open, and the server holds an SSE task plus a broadcast receiver
    // for every stream nobody cancelled.
    if (!drained) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
