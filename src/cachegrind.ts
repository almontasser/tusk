// Xdebug's Cachegrind profiles, as src-tauri/src/profile.rs parses them, and Laravel's queries from Xdebug traces.
// Free of editor imports so Node can test it.

export type ProfiledFunction = {
  name: string;
  /** The file that defines it, or "php:internal" for PHP's own functions. */
  file: string;
  line: number;
  calls: number;
  /** Time in the function's own code, and including what it called, in milliseconds. */
  self: number;
  inclusive: number;
  /**
   * How much memory in use grew over its outermost calls, including what it called, in bytes, as Xdebug measures
   * it: memory freed before a call returns doesn't count, so it can be negative, and it doesn't add up across functions.
   */
  memory: number;
  /** The functions it called and the functions that called it, with how often and how long those calls took. */
  callees: Call[];
  callers: Call[];
};

export type Call = { fn: ProfiledFunction; calls: number; time: number };

/**
 * A node of the call tree: a function called along one path from the root, with every call on that path merged.
 * Unlike callers and callees, it keeps the path: `time` is the time of this function's calls under this parent only.
 */
export type CallNode = { fn: ProfiledFunction; calls: number; time: number; children: CallNode[] };

export type Profile = {
  command: string;
  functions: ProfiledFunction[];
  /** The script's total time in milliseconds. */
  total: number;
  /** The call tree's roots: {main}, and anything PHP ran after it, such as shutdown functions. */
  tree: CallNode[];
  /** Time spent in calls made from each line, by file: where the run spent its time, line by line. */
  sites: Map<string, Map<number, { time: number; calls: number }>>;
};

/** A profile as `parse_profile` (src-tauri/src/profile.rs) sends it, with functions referred to by index. */
export type RawProfile = {
  command: string;
  functions: (Omit<ProfiledFunction, "callees" | "callers"> & { callees: [number, number, number][] })[];
  total: number;
  tree: RawNode[];
  sites: [string, [number, number, number][]][];
};
type RawNode = { fn: number; calls: number; time: number; children: RawNode[] };

/** Turns the indexes of a parsed profile into references: callees and callers, and each tree node's function. */
export function fromRaw(raw: RawProfile): Profile {
  const functions: ProfiledFunction[] = raw.functions.map((f) => ({ ...f, callees: [], callers: [] }));
  raw.functions.forEach((f, i) => {
    for (const [callee, calls, time] of f.callees) {
      functions[i].callees.push({ fn: functions[callee], calls, time });
      functions[callee].callers.push({ fn: functions[i], calls, time });
    }
  });
  const node = (n: RawNode): CallNode => ({ fn: functions[n.fn], calls: n.calls, time: n.time, children: n.children.map(node) });
  const sites: Profile["sites"] = new Map(raw.sites.map(([file, lines]) => [file, new Map(lines.map(([line, time, calls]) => [line, { time, calls }]))]));
  return { command: raw.command, functions, total: raw.total, tree: raw.tree.map(node), sites };
}

/**
 * Where the time under a call tree node goes: each function's own time within the node's subtree, most first.
 * A node's own time is its time less its children's.
 */
export function hotSpots(root: CallNode): { fn: ProfiledFunction; self: number; calls: number }[] {
  const byFn = new Map<ProfiledFunction, { fn: ProfiledFunction; self: number; calls: number }>();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    const spot = byFn.get(node.fn) ?? { fn: node.fn, self: 0, calls: 0 };
    spot.self += node.time - node.children.reduce((t, c) => t + c.time, 0);
    spot.calls += node.calls;
    byFn.set(node.fn, spot);
    stack.push(...node.children);
  }
  return [...byFn.values()].sort((a, b) => b.self - a.self);
}

/** A database query from a trace of Laravel's connection: its SQL, its bindings as PHP shows them, and its time. */
export type Query = { sql: string; bindings: string[]; time: number; start: number };

/**
 * Reads the queries from an Xdebug trace (`xdebug.trace_format=1`, tab-separated) limited to Laravel's
 * `Illuminate\Database\Connection`. Each query passes through `Connection->run($query, $bindings, ...)`: its
 * entry record holds the arguments, and the exit record with the same call number holds the time it ended.
 */
export function parseSqlTrace(text: string): Query[] {
  const open = new Map<string, Query>();
  const queries: Query[] = [];
  for (const line of text.split("\n")) {
    const f = line.split("\t");
    if (f[2] === "0" && f[5] === "Illuminate\\Database\\Connection->run" && f[11]?.startsWith("'")) {
      const query = { sql: phpString(f[11]), bindings: phpList(f[12] ?? ""), time: 0, start: Number(f[3]) * 1000 };
      open.set(f[1], query);
      queries.push(query);
    } else if (f[2] === "1" && open.has(f[1])) {
      const query = open.get(f[1])!;
      query.time = Number(f[3]) * 1000 - query.start;
      open.delete(f[1]);
    }
  }
  return queries;
}

/** A PHP string as Xdebug writes it: single-quoted, with \' and \\ escaped. Long strings end in "...". */
const phpString = (s: string) => s.replace(/^'|'(\.\.\.)?$/g, "").replace(/\\(['\\])/g, "$1");

/** The values of a PHP list as Xdebug writes it, such as [0 => 'a', 1 => 5, 2 => NULL]; strings keep their quotes. */
export function phpList(s: string): string[] {
  const values: string[] = [];
  const body = s.replace(/^\[|\]$/g, "");
  // A value is a quoted string (with escapes) or anything up to the next comma.
  for (const m of body.matchAll(/(?:^|, )\d+ => ('(?:[^'\\]|\\.)*'(?:\.\.\.)?|[^,]*)/g)) values.push(m[1]);
  return values;
}

/** SQL with its bindings in place of the ? placeholders, for pasting into a database console. Best effort. */
export function withBindings(q: Query): string {
  let i = 0;
  return q.sql.replace(/\?/g, (mark) => (i < q.bindings.length ? q.bindings[i++].replace(/^NULL$/, "null").replace(/^TRUE$/, "1").replace(/^FALSE$/, "0") : mark));
}

export type QueryGroup = { sql: string; runs: Query[]; time: number; kind: "" | "duplicate" | "repeated" };

/**
 * Queries with the same SQL, slowest group first. The same SQL and bindings more than once is a duplicate; the same
 * SQL with different bindings three or more times is often a loop that queries once per item (an N+1 query).
 */
export function groupQueries(list: Query[]): QueryGroup[] {
  const bySql = new Map<string, Query[]>();
  for (const q of list) bySql.set(q.sql, [...(bySql.get(q.sql) ?? []), q]);
  return [...bySql]
    .map(([sql, runs]) => {
      const distinct = new Set(runs.map((r) => r.bindings.join("\u0000"))).size;
      const kind: QueryGroup["kind"] = distinct < runs.length ? "duplicate" : runs.length >= 3 ? "repeated" : "";
      return { sql, runs, time: runs.reduce((t, r) => t + r.time, 0), kind };
    })
    .sort((a, b) => b.time - a.time);
}
