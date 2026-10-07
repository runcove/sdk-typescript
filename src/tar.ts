/**
 * A minimal tar writer and reader for `client.spotlight` (internal; not exported from the
 * package entry).
 *
 * The writer emits POSIX ustar: regular files and symlinks, with their permission bits, owned by
 * root (uid and gid 0). A path or link target too long for the ustar fields is split across the
 * `prefix` and `name` fields when it can be, and otherwise carried in a pax extended header
 * (`path=` / `linkpath=`), which GNU tar, bsdtar and BusyBox tar all read. The reader takes what
 * `git archive` writes (ustar plus pax headers) and what the writer writes.
 */

import { CoveError } from "./errors.js";

/** One entry of a tree: a regular file with its bytes, or a symlink with its target. */
export type TarEntry =
  | { kind: "file"; path: string; mode: number; mtime?: number; data: Uint8Array }
  | { kind: "symlink"; path: string; mode: number; mtime?: number; target: string };

const BLOCK = 512;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** `n` as a zero-padded octal field of `width` bytes, NUL-terminated. */
function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function put(header: Uint8Array, offset: number, width: number, text: string | Uint8Array): void {
  const bytes = typeof text === "string" ? enc.encode(text) : text;
  if (bytes.byteLength > width) throw new CoveError(`tar field overflow at ${offset}`);
  header.set(bytes, offset);
}

/** One 512-byte ustar header. `name`, `prefix` and `linkname` must already fit. */
function header(opts: {
  name: Uint8Array;
  prefix: Uint8Array;
  linkname: Uint8Array;
  mode: number;
  size: number;
  type: string;
  mtime: number;
}): Uint8Array {
  const h = new Uint8Array(BLOCK);
  put(h, 0, 100, opts.name);
  put(h, 100, 8, octal(opts.mode & 0o7777, 8));
  put(h, 108, 8, octal(0, 8));
  put(h, 116, 8, octal(0, 8));
  put(h, 124, 12, octal(opts.size, 12));
  put(h, 136, 12, octal(opts.mtime, 12));
  put(h, 148, 8, "        ");
  put(h, 156, 1, opts.type);
  put(h, 157, 100, opts.linkname);
  put(h, 257, 6, "ustar\0");
  put(h, 263, 2, "00");
  put(h, 265, 32, "root");
  put(h, 297, 32, "root");
  put(h, 345, 155, opts.prefix);
  let sum = 0;
  for (const b of h) sum += b;
  put(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

/** Split `path` into ustar `prefix` and `name` (at a `/`), or `undefined` when it cannot fit. */
function splitUstar(path: Uint8Array): { prefix: Uint8Array; name: Uint8Array } | undefined {
  if (path.byteLength <= 100) return { prefix: new Uint8Array(0), name: path };
  for (let i = Math.min(path.byteLength - 1, 155); i > 0; i--) {
    if (path[i] !== 0x2f) continue;
    const name = path.subarray(i + 1);
    if (name.byteLength === 0 || name.byteLength > 100) return undefined;
    return { prefix: path.subarray(0, i), name };
  }
  return undefined;
}

/** One pax record, `"<len> <key>=<value>\n"`, whose length counts its own digits. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLen = enc.encode(body).byteLength;
  let len = bodyLen + String(bodyLen).length;
  if (String(len).length !== String(bodyLen).length) len = bodyLen + String(len).length;
  return `${len}${body}`;
}

/** The largest size the 12-byte octal ustar field holds: 8 GiB less one byte. */
const MAX_USTAR_SIZE = 0o77777777777;

const padTo = (n: number) => (BLOCK - (n % BLOCK)) % BLOCK;

/**
 * The entries as an uncompressed tar archive, ended by two zero blocks. An entry without an
 * `mtime` (seconds since the epoch) gets 0.
 */
export function writeTar(entries: Iterable<TarEntry>): Uint8Array {
  const parts: Uint8Array[] = [];
  const pushData = (data: Uint8Array) => {
    parts.push(data);
    const pad = padTo(data.byteLength);
    if (pad) parts.push(new Uint8Array(pad));
  };
  for (const e of entries) {
    const mtime = Math.max(0, Math.floor(e.mtime ?? 0));
    const path = enc.encode(e.path);
    const link = e.kind === "symlink" ? enc.encode(e.target) : new Uint8Array(0);
    const split = splitUstar(path);
    let pax = "";
    if (!split) pax += paxRecord("path", e.path);
    if (link.byteLength > 100) pax += paxRecord("linkpath", e.kind === "symlink" ? e.target : "");
    if (pax) {
      const records = enc.encode(pax);
      const short = enc.encode("PaxHeader").subarray(0, 100);
      parts.push(
        header({ name: short, prefix: new Uint8Array(0), linkname: new Uint8Array(0), mode: 0o644, size: records.byteLength, type: "x", mtime }),
      );
      pushData(records);
    }
    // When a pax header carries the path, the ustar field holds a truncated stand-in.
    const name = split?.name ?? path.subarray(Math.max(0, path.byteLength - 100));
    const prefix = split?.prefix ?? new Uint8Array(0);
    const linkname = link.byteLength > 100 ? link.subarray(0, 100) : link;
    const size = e.kind === "file" ? e.data.byteLength : 0;
    if (size > MAX_USTAR_SIZE) {
      throw new CoveError(`${e.path} is ${size} bytes; spotlight's tar carries files up to 8 GiB`);
    }
    parts.push(header({ name, prefix, linkname, mode: e.mode, size, type: e.kind === "file" ? "0" : "2", mtime }));
    if (e.kind === "file") pushData(e.data);
  }
  parts.push(new Uint8Array(BLOCK * 2));
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** A NUL-terminated header field as a string. */
function field(h: Uint8Array, offset: number, width: number): string {
  const raw = h.subarray(offset, offset + width);
  const end = raw.indexOf(0);
  return dec.decode(end === -1 ? raw : raw.subarray(0, end));
}

function parseOctal(h: Uint8Array, offset: number, width: number): number {
  const text = field(h, offset, width).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

/** The `key=value` records of a pax header. */
function parsePax(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < data.byteLength) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const len = Number.parseInt(dec.decode(data.subarray(at, space)), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = dec.decode(data.subarray(space + 1, at + len - 1));
    const eq = record.indexOf("=");
    if (eq !== -1) out.set(record.slice(0, eq), record.slice(eq + 1));
    at += len;
  }
  return out;
}

/**
 * The regular files and symlinks of an uncompressed tar archive; directories and global headers
 * are skipped. Refuses an entry type it does not know, rather than dropping it unseen.
 */
export function readTar(archive: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let at = 0;
  let pax = new Map<string, string>();
  while (at + BLOCK <= archive.byteLength) {
    const h = archive.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    const size = parseOctal(h, 124, 12);
    const type = String.fromCharCode(h[156] ?? 0);
    const data = archive.subarray(at + BLOCK, at + BLOCK + size);
    at += BLOCK + size + padTo(size);
    if (type === "x") {
      pax = parsePax(data);
      continue;
    }
    if (type === "g") continue;
    const prefix = field(h, 345, 155);
    const name = field(h, 0, 100);
    const path = (pax.get("path") ?? (prefix ? `${prefix}/${name}` : name)).replace(/^\.\//, "");
    const linkname = pax.get("linkpath") ?? field(h, 157, 100);
    const mode = parseOctal(h, 100, 8) & 0o7777;
    const mtime = Number(pax.get("mtime") ?? parseOctal(h, 136, 12)) || 0;
    pax = new Map();
    if (type === "5") continue;
    if (type === "0" || type === "\0" || type === "7") {
      out.push({ kind: "file", path, mode, mtime, data: data.slice() });
    } else if (type === "2") {
      out.push({ kind: "symlink", path, mode, mtime, target: linkname });
    } else {
      throw new CoveError(`tar entry ${path} has type ${JSON.stringify(type)}, which spotlight does not carry`);
    }
  }
  return out;
}
