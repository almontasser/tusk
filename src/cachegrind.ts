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

export type Profile = {
  command: string;
  functions: ProfiledFunction[];
  /** The script's total time in milliseconds. */
  total: number;
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
  const names = { fl: new Map<string, string>(), fn: new Map<string, string>() };
  const byName = new Map<string, ProfiledFunction>();
  let command = "";
  let scale = 1 / 1000; // microseconds to milliseconds
  let file = "";
  type Cost = { time: number; memory: number };
  type Block = { fn: ProfiledFunction; time: number; memory: number; calls: number; totals?: Map<ProfiledFunction, Cost> };
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
    for (const callee of callees) callee.totals = undefined;
    block.totals = totals;
    unclaimed.push(block);
    block = undefined;
  };
  for (const line of text.split("\n")) {
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
  }
  finish();
  // What's left unclaimed are the roots: {main}, and anything PHP ran after it, such as shutdown functions.
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
  };
}
