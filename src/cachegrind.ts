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
};

export type Profile = { command: string; functions: ProfiledFunction[]; /** The script's total time in milliseconds. */ total: number };

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
  type Block = { fn: ProfiledFunction; time: number; calls: number; totals?: Map<ProfiledFunction, number> };
  const unclaimed: Block[] = [];
  let block: Block | undefined;
  let expect: "self" | "call" | "" = "";
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
    const totals = callees[0]?.totals ?? new Map<ProfiledFunction, number>();
    for (const callee of callees.slice(1)) for (const [fn, t] of callee.totals ?? []) totals.set(fn, (totals.get(fn) ?? 0) + t);
    totals.set(block.fn, block.time);
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
      const name = resolve("fn", line.slice(eq + 1));
      let fn = byName.get(name);
      if (!fn) byName.set(name, (fn = { name, file, line: 0, calls: 0, self: 0, inclusive: 0 }));
      fn.calls++;
      block = { fn, time: 0, calls: 0 };
      expect = "self";
    } else if (key === "cfn") resolve("fn", line.slice(eq + 1));
    else if (key === "calls") expect = "call";
    else if (/^\d/.test(line) && block) {
      const [position, time = "0"] = line.split(" ");
      const cost = Number(time) * scale;
      block.time += cost;
      if (expect === "self") {
        block.fn.self += cost;
        block.fn.line ||= Number(position);
      } else if (expect === "call") block.calls++;
      expect = "";
    } else if (line.startsWith("cmd: ")) command = line.slice(5);
    else if (line.startsWith("events: ") && line.includes("Time_(10ns)")) scale = 1 / 100_000;
    else if (line.startsWith("summary:")) finish();
  }
  finish();
  // What's left unclaimed are the roots: {main}, and anything PHP ran after it, such as shutdown functions.
  for (const root of unclaimed) for (const [fn, t] of root.totals ?? []) fn.inclusive += t;
  const functions = [...byName.values()];
  const main = byName.get("{main}");
  return { command, functions, total: main?.inclusive ?? Math.max(0, ...functions.map((f) => f.inclusive)) };
}
