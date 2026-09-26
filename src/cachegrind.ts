// Reads the Cachegrind profiles that Xdebug's profiler writes. Free of editor imports so Node can test it.

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

/**
 * Xdebug writes one block per call, when the call returns: `fn=` names the function, the next cost line is its
 * own time, and each `calls=` line is followed by the time of one call it made. Names are compressed: `(3) name`
 * defines id 3, and a later `(3)` refers to it. Time is in 10 ns units since Xdebug 3 (`Time_(10ns)`), and
 * microseconds before.
 *
 * A function's total time counts only its outermost calls, so recursion (direct, or through other functions as
 * in Laravel's middleware pipeline) isn't counted twice. Blocks come in post-order, so a block's callees are the
 * last blocks that no caller has claimed yet. Each block carries, per function, the total time of that function's
 * outermost calls in its subtree; a caller merges its callees' totals and sets its own.
 */
export function parseCachegrind(text: string): Profile {
  const parser = cachegrindParser();
  for (const line of text.split("\n")) parser.line(line);
  return parser.end();
}

/** The same parser, fed one line at a time, so a profile too large for one string can be streamed through it. */
export function cachegrindParser(): { line(line: string): void; end(): Profile } {
  const names = { fl: new Map<string, string>(), fn: new Map<string, string>() };
  const byName = new Map<string, ProfiledFunction>();
  let command = "";
  let scale = 1 / 1000; // microseconds to milliseconds
  let file = "";
  type Cost = { time: number; memory: number };
  type Block = { fn: ProfiledFunction; time: number; memory: number; calls: number; totals?: Map<ProfiledFunction, Cost>; node?: CallNode };
  const sites: Profile["sites"] = new Map();
  const unclaimed: Block[] = [];
  let block: Block | undefined;
  let callee = "";
  let expect: "self" | "call" | "" = "";
  const get = (name: string) => {
    let fn = byName.get(name);
    if (!fn) byName.set(name, (fn = { name, file: "", line: 0, calls: 0, self: 0, inclusive: 0, memory: 0, callees: [], callers: [] }));
    return fn;
  };
  const edges = new Map<ProfiledFunction, Map<ProfiledFunction, Call>>();
  const resolve = (kind: "fl" | "fn", value: string) => {
    const m = value.match(/^\((\d+)\)(?: (.*))?$/);
    if (!m) return value;
    if (m[2] !== undefined) names[kind].set(m[1], m[2]);
    return names[kind].get(m[1]) ?? "";
  };
  /** Adds call nodes under a parent, merging each into the parent's node for the same function, if it has one. */
  const adopt = (parent: CallNode, nodes: CallNode[]) => {
    const byFn = new Map(parent.children.map((n) => [n.fn, n]));
    for (const node of nodes) {
      const same = byFn.get(node.fn);
      if (!same) {
        parent.children.push(node);
        byFn.set(node.fn, node);
        continue;
      }
      same.calls += node.calls;
      same.time += node.time;
      adopt(same, node.children);
    }
  };
  /** Claims the finished block's callees and records its function's time in its subtree. */
  const finish = () => {
    if (!block) return;
    const callees = unclaimed.splice(Math.max(0, unclaimed.length - block.calls));
    // Reuse the largest callee map, so deep call chains don't copy every map at every level.
    callees.sort((a, b) => (b.totals?.size ?? 0) - (a.totals?.size ?? 0));
    const totals = callees[0]?.totals ?? new Map<ProfiledFunction, Cost>();
    for (const callee of callees.slice(1))
      for (const [fn, c] of callee.totals ?? []) {
        const t = totals.get(fn);
        totals.set(fn, t ? { time: t.time + c.time, memory: t.memory + c.memory } : c);
      }
    totals.set(block.fn, { time: block.time, memory: block.memory });
    block.node = { fn: block.fn, calls: 1, time: block.time, children: [] };
    adopt(block.node, callees.map((c) => c.node!));
    for (const callee of callees) callee.totals = callee.node = undefined;
    block.totals = totals;
    unclaimed.push(block);
    block = undefined;
  };
  const line = (line: string) => {
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq) : "";
    if (key === "fl" || key === "fi" || key === "fe") {
      if (key === "fl") finish();
      file = resolve("fl", line.slice(eq + 1));
    } else if (key === "cfl" || key === "cfi") resolve("fl", line.slice(eq + 1));
    else if (key === "fn") {
      finish();
      const fn = get(resolve("fn", line.slice(eq + 1)));
      fn.file ||= file;
      fn.calls++;
      block = { fn, time: 0, memory: 0, calls: 0 };
      expect = "self";
    } else if (key === "cfn") callee = resolve("fn", line.slice(eq + 1));
    else if (key === "calls") expect = "call";
    else if (/^\d/.test(line) && block) {
      const [position, time = "0", bytes = "0"] = line.split(" ");
      const cost = Number(time) * scale;
      const memory = Number(bytes);
      block.time += cost;
      block.memory += memory;
      if (expect === "self") {
        block.fn.self += cost;
        block.fn.line ||= Number(position);
      } else if (expect === "call") {
        let lines = sites.get(block.fn.file);
        if (!lines) sites.set(block.fn.file, (lines = new Map()));
        const site = lines.get(Number(position)) ?? { time: 0, calls: 0 };
        site.time += cost;
        site.calls++;
        lines.set(Number(position), site);
        block.calls++;
        const target = get(callee);
        let out = edges.get(block.fn);
        if (!out) edges.set(block.fn, (out = new Map()));
        const call = out.get(target) ?? { fn: target, calls: 0, time: 0 };
        call.calls++;
        call.time += cost;
        out.set(target, call);
      }
      expect = "";
    } else if (line.startsWith("cmd: ")) command = line.slice(5);
    else if (line.startsWith("events: ") && line.includes("Time_(10ns)")) scale = 1 / 100_000;
    else if (line.startsWith("summary:")) finish();
  };
  const end = (): Profile => {
    finish();
    // What's left unclaimed are the roots: {main}, and anything PHP ran after it, such as shutdown functions.
    const tree: CallNode = { fn: get("{root}"), calls: 0, time: 0, children: [] };
    byName.delete("{root}");
    adopt(tree, unclaimed.map((b) => b.node!));
    for (const root of unclaimed)
      for (const [fn, c] of root.totals ?? []) {
        fn.inclusive += c.time;
        fn.memory += c.memory;
      }
    for (const [caller, out] of edges)
      for (const call of out.values()) {
        caller.callees.push(call);
        call.fn.callers.push({ fn: caller, calls: call.calls, time: call.time });
      }
    const functions = [...byName.values()];
    const main = byName.get("{main}");
    return {
      command,
      functions,
      total: main?.inclusive ?? Math.max(0, ...functions.map((f) => f.inclusive)),
      sites,
      tree: tree.children,
    };
  };
  return { line, end };
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
