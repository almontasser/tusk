// Redis data for the key browser: the key tree, TTLs, filters, command syntax, and the commands that apply grid edits.
// Free of editor imports so Node can test it.
import type { Cell, Changes } from "./dbgrid";

/** A reply from db.rs's redis_call. Bytes that aren't text come as their length and a hex preview. */
export type Reply = null | string | number | Reply[] | { error: string } | { binary: number; hex: string };

export const isError = (r: Reply): r is { error: string } => typeof r === "object" && r !== null && "error" in r;
export const isBinary = (r: Reply): r is { binary: number; hex: string } => typeof r === "object" && r !== null && "binary" in r;

/** A reply as a cell: arrays as JSON, and binary values by their size. */
export function replyText(r: Reply): Cell {
  if (r === null) return null;
  if (typeof r === "string") return r;
  if (typeof r === "number") return String(r);
  if (isError(r)) return `(error) ${r.error}`;
  if (isBinary(r)) return `<binary, ${formatBytes(r.binary)}>`;
  return JSON.stringify(r.map(replyText));
}

/** Short labels for the type badges. Module types, such as a Bloom filter's `MBbloom--`, get their first letters. */
export function typeLabel(type: string): string {
  const labels: Record<string, string> = { string: "STR", hash: "HASH", list: "LIST", set: "SET", zset: "ZSET", stream: "STRM", "ReJSON-RL": "JSON" };
  return labels[type] ?? type.replace(/[^A-Za-z]/g, "").slice(0, 4).toUpperCase();
}

export const typeName: Record<string, string> = { string: "String", hash: "Hash", list: "List", set: "Set", zset: "Sorted set", stream: "Stream", "ReJSON-RL": "JSON" };

// ---- Keys ----

/** Escapes glob characters, so a key or prefix matches only itself in SCAN's MATCH. */
export const globEscape = (text: string) => text.replace(/[*?[\]\\]/g, "\\$&");

/** The MATCH pattern for the filter box: a glob as typed, or plain text found anywhere in a key. */
export function filterPattern(text: string): string {
  const t = text.trim();
  if (!t) return "*";
  return /[*?[]/.test(t) ? t : `*${globEscape(t)}*`;
}

/** Orders names as people read them, so `users:2` comes before `users:10`. */
const collator = new Intl.Collator(undefined, { numeric: true });

export type KeyInfo = { key: string; type: string };
export type Folder = { name: string; prefix: string; folders: Map<string, Folder>; keys: KeyInfo[]; count: number };

/** Groups keys into folders by `delimiter`, as `cache:users:1` goes in `cache:` then `users:`. Keys come sorted. */
export function keyTree(keys: KeyInfo[], delimiter = ":"): Folder {
  const root: Folder = { name: "", prefix: "", folders: new Map(), keys: [], count: 0 };
  for (const k of [...keys].sort((a, b) => collator.compare(a.key, b.key))) {
    let folder = root;
    folder.count++;
    for (const part of k.key.split(delimiter).slice(0, -1)) {
      let next = folder.folders.get(part);
      if (!next) folder.folders.set(part, (next = { name: part, prefix: `${folder.prefix}${part}${delimiter}`, folders: new Map(), keys: [], count: 0 }));
      folder = next;
      folder.count++;
    }
    folder.keys.push(k);
  }
  return root;
}

export type TreeRow = { kind: "folder"; folder: Folder; depth: number } | { kind: "key"; key: KeyInfo; name: string; depth: number };

/** The rows a tree shows: folders first, then keys, with the contents of expanded folders under them. */
export function visibleRows(folder: Folder, expanded: (prefix: string) => boolean, depth = 0): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const f of [...folder.folders.values()].sort((a, b) => collator.compare(a.name, b.name))) {
    rows.push({ kind: "folder", folder: f, depth });
    if (expanded(f.prefix)) rows.push(...visibleRows(f, expanded, depth + 1));
  }
  for (const k of folder.keys) rows.push({ kind: "key", key: k, name: k.key.slice(folder.prefix.length) || k.key, depth });
  return rows;
}

// ---- Sizes and times ----

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do (n /= 1024), i++;
  while (n >= 1024 && i < units.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** A TTL from Redis in seconds: -1 is no expiry, and -2 a key that's gone. The largest unit and the next, as "3h 0m". */
export function formatTtl(seconds: number): string {
  if (seconds === -1) return "No expiry";
  if (seconds < 0) return "Expired";
  const units = [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const;
  const i = units.findIndex(([, size]) => seconds >= size);
  if (i < 0 || i === units.length - 1) return `${seconds}s`;
  const [[big, bigSize], [small, smallSize]] = [units[i], units[i + 1]];
  return `${Math.floor(seconds / bigSize)}${big} ${Math.floor((seconds % bigSize) / smallSize)}${small}`;
}

/**
 * Seconds from a duration as typed for Set Expiry: `90`, `90s`, `15m`, `2h`, `1d`, or several, as `1h 30m`.
 * -1 for no expiry (empty, `never`, or `persist`), and null for text it can't read.
 */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t || /^(never|none|persist|no expiry)$/.test(t)) return -1;
  if (/^\d+$/.test(t)) return Number(t) || null;
  const sizes: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  let total = 0;
  const rest = t.replace(/(\d+)\s*([smhdw])/g, (_, n: string, unit: string) => ((total += Number(n) * sizes[unit]), ""));
  return rest.trim() || !total ? null : total;
}

/** A value's kind, for the badge beside it: JSON, or PHP's serialize(), which Laravel's cache and sessions use. */
export function valueKind(value: string): "json" | "php" | "" {
  const t = value.trim();
  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(t);
      return "json";
    } catch {}
  }
  return /^(a:\d+:\{|O:\d+:"|s:\d+:"|i:-?\d+;|b:[01];|d:-?[\d.]+;|N;)/.test(t) ? "php" : "";
}

// ---- Commands ----

/**
 * Splits a command line into arguments as redis-cli does, and as db.rs's split_command: whitespace separates them,
 * double quotes take `\n`, `\r`, `\t`, and `\` before any other character, and single quotes take text as it is,
 * except `\'`. Null for an unclosed quote.
 */
export function splitCommand(line: string): string[] | null {
  const args: string[] = [];
  let i = 0;
  while (true) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) return args;
    let arg = "";
    const quote = line[i];
    if (quote === '"' || quote === "'") {
      i++;
      while (true) {
        if (i >= line.length) return null;
        const c = line[i++];
        if (c === quote) break;
        if (c === "\\" && quote === '"') {
          if (i >= line.length) return null;
          const e = line[i++];
          arg += e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : e;
        } else if (c === "\\" && line[i] === "'") arg += line[i++];
        else arg += c;
      }
    } else while (i < line.length && !/\s/.test(line[i])) arg += line[i++];
    args.push(arg);
  }
}

/** Quotes an argument for a command line, when it needs quotes. */
export const quoteArg = (arg: string) => (arg && !/[\s"'\\]/.test(arg) ? arg : `"${arg.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`);
export const commandLine = (args: string[]) => args.map(quoteArg).join(" ");

/** Commands that change or stop the whole server or database, which the console asks about first. */
const DANGEROUS = new Set(["FLUSHALL", "FLUSHDB", "SHUTDOWN", "SWAPDB", "REPLICAOF", "SLAVEOF", "DEBUG", "FAILOVER"]);
export const isDangerous = (args: string[]) => DANGEROUS.has((args[0] ?? "").toUpperCase());

/** A doc from COMMAND DOCS, which RESP2 sends as arrays of alternating names and values. */
export function pairs(reply: Reply): Record<string, Reply> {
  const out: Record<string, Reply> = {};
  if (Array.isArray(reply)) for (let i = 0; i + 1 < reply.length; i += 2) out[String(reply[i])] = reply[i + 1];
  return out;
}

/** An argument of a command as the docs print it, such as `[EX seconds | PX milliseconds]` or `key [key ...]`. */
function argumentSyntax(raw: Reply): string {
  const a = pairs(raw);
  const flags = Array.isArray(a.flags) ? a.flags.map(String) : [];
  const children = Array.isArray(a.arguments) ? a.arguments : [];
  let text =
    a.type === "pure-token" ? String(a.token) : a.type === "oneof" ? children.map(argumentSyntax).join(" | ") : a.type === "block" ? children.map(argumentSyntax).join(" ") : String(a.display_text ?? a.name);
  if (a.token && a.type !== "pure-token") text = `${a.token} ${text}`;
  if (flags.includes("multiple")) text = `${text} [${text} ...]`;
  if (flags.includes("optional")) return `[${text}]`;
  return a.type === "oneof" ? `<${text}>` : text;
}

export type CommandDoc = { name: string; summary: string; syntax: string; group: string; since: string };

/** COMMAND DOCS's reply as a doc per command, with its syntax. Subcommands, such as CONFIG GET, get their own. */
export function commandDocs(reply: Reply): CommandDoc[] {
  const docs: CommandDoc[] = [];
  const read = (name: string, raw: Reply) => {
    const d = pairs(raw);
    const args = Array.isArray(d.arguments) ? d.arguments.map(argumentSyntax).join(" ") : "";
    docs.push({ name: name.toUpperCase(), summary: String(d.summary ?? ""), syntax: `${name.toUpperCase()}${args ? ` ${args}` : ""}`, group: String(d.group ?? ""), since: String(d.since ?? "") });
    for (const [sub, doc] of Object.entries(pairs(d.subcommands ?? null))) read(sub.replace("|", " "), doc);
  };
  for (const [name, doc] of Object.entries(pairs(reply))) read(name, doc);
  return docs.sort((a, b) => (a.name < b.name ? -1 : 1));
}

// ---- Values ----

/** Rows per page of a hash, list, set, sorted set, or stream. */
export const PAGE = 1000;

/** The command that counts a key's elements, or its string's length. */
export const lengthCommand: Record<string, string> = { string: "STRLEN", hash: "HLEN", list: "LLEN", set: "SCARD", zset: "ZCARD", stream: "XLEN" };
/** What a key's elements are called, for its size. */
export const elementName: Record<string, [string, string]> = { string: ["byte", "bytes"], hash: ["field", "fields"], list: ["item", "items"], set: ["member", "members"], zset: ["member", "members"], stream: ["entry", "entries"] };
/** The grid's columns for each type. */
export const columnsOf: Record<string, string[]> = { hash: ["field", "value"], list: ["value"], set: ["member"], zset: ["member", "score"], stream: ["id", "fields"] };

const SCORE = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$|^[+-]?inf$/i;

/**
 * The commands that apply grid changes to a hash, list, set, sorted set, or stream. `first` is the Redis index of the
 * page's first row, for a list. Throws for input Redis would refuse, such as a score that isn't a number.
 * A list element is deleted by setting it to a unique marker and removing the marker, as Redis has no delete by index.
 */
export function editCommands(type: string, key: string, values: Cell[][], changes: Changes, first = 0, marker = `__tusk_deleted_${Date.now()}__`): string[][] {
  const out: string[][] = [];
  const s = (v: Cell | undefined) => v ?? "";
  const value = (r: number, c: number) => (changes.edits.get(r)?.has(c) ? changes.edits.get(r)!.get(c)! : values[r][c]);
  const edited = [...changes.edits.keys()].filter((r) => !changes.deletes.has(r));
  const score = (v: Cell | undefined) => {
    const text = s(v).trim() || "0";
    if (!SCORE.test(text)) throw new Error(`A score must be a number, not "${text}".`);
    return text;
  };
  switch (type) {
    case "hash":
      for (const r of changes.deletes) out.push(["HDEL", key, s(values[r][0])]);
      for (const r of edited) {
        if (value(r, 0) !== values[r][0]) out.push(["HDEL", key, s(values[r][0])]);
        out.push(["HSET", key, s(value(r, 0)), s(value(r, 1))]);
      }
      for (const v of changes.inserts) {
        if (!v.field) throw new Error("A new field needs a name.");
        out.push(["HSET", key, v.field, s(v.value)]);
      }
      break;
    case "list":
      for (const r of edited) out.push(["LSET", key, String(first + r), s(value(r, 0))]);
      for (const r of changes.deletes) out.push(["LSET", key, String(first + r), marker]);
      if (changes.deletes.size) out.push(["LREM", key, "0", marker]);
      for (const v of changes.inserts) out.push(["RPUSH", key, s(v.value)]);
      break;
    case "set":
      for (const r of changes.deletes) out.push(["SREM", key, s(values[r][0])]);
      for (const r of edited) out.push(["SREM", key, s(values[r][0])], ["SADD", key, s(value(r, 0))]);
      for (const v of changes.inserts) out.push(["SADD", key, s(v.member)]);
      break;
    case "zset":
      for (const r of changes.deletes) out.push(["ZREM", key, s(values[r][0])]);
      for (const r of edited) {
        if (value(r, 0) !== values[r][0]) out.push(["ZREM", key, s(values[r][0])]);
        out.push(["ZADD", key, score(value(r, 1)), s(value(r, 0))]);
      }
      for (const v of changes.inserts) out.push(["ZADD", key, score(v.score), s(v.member)]);
      break;
    case "stream":
      if (changes.deletes.size) out.push(["XDEL", key, ...[...changes.deletes].map((r) => s(values[r][0]))]);
      break;
  }
  return out;
}
