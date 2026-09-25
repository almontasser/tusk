// Parsers for git's machine-readable output. Kept free of editor imports so Node can test them.

export type FileStatus = {
  path: string;
  /** Previous path of a renamed or copied file. */
  from?: string;
  /** Index (staged) status letter, such as `M`, `A`, `D`, `R`, or `?`. */
  index: string;
  /** Working tree (unstaged) status letter. */
  worktree: string;
};

export type Status = { branch: string; upstream?: string; ahead: number; behind: number; files: FileStatus[] };

/** Parses `git status --porcelain=v1 -z --branch`. */
export function parseStatus(out: string): Status {
  const fields = out.split("\0");
  const status: Status = { branch: "", ahead: 0, behind: 0, files: [] };
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.startsWith("## ")) {
      const head = f.slice(3);
      const m = head.match(/^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/);
      status.branch = head.startsWith("HEAD (no branch)") ? "HEAD (detached)" : (m?.[1] ?? head);
      status.upstream = m?.[2];
      status.ahead = Number(m?.[3]?.match(/ahead (\d+)/)?.[1] ?? 0);
      status.behind = Number(m?.[3]?.match(/behind (\d+)/)?.[1] ?? 0);
    } else if (f.length > 3) {
      const file: FileStatus = { index: f[0], worktree: f[1], path: f.slice(3) };
      if ("RC".includes(f[0]) || "RC".includes(f[1])) file.from = fields[++i];
      status.files.push(file);
    }
  }
  return status;
}

export type LineChange = { kind: "added" | "modified" | "deleted"; start: number; end: number };

/** Parses the hunk headers of `git diff -U0` into changed line ranges of the new file (1-based). */
export function parseHunks(diff: string): LineChange[] {
  const changes: LineChange[] = [];
  for (const m of diff.matchAll(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldCount = Number(m[1] ?? 1);
    const start = Number(m[2]);
    const newCount = Number(m[3] ?? 1);
    if (newCount === 0) changes.push({ kind: "deleted", start: Math.max(start, 1), end: Math.max(start, 1) });
    else changes.push({ kind: oldCount === 0 ? "added" : "modified", start, end: start + newCount - 1 });
  }
  return changes;
}

export type BlameLine = { hash: string; author: string; time: number; summary: string };

/** Parses `git blame --porcelain` into one entry per line of the file. */
export function parseBlame(out: string): BlameLine[] {
  const commits = new Map<string, BlameLine>();
  const lines: BlameLine[] = [];
  let current: BlameLine | undefined;
  for (const line of out.split("\n")) {
    const header = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (header) {
      current = commits.get(header[1]) ?? { hash: header[1], author: "", time: 0, summary: "" };
      commits.set(header[1], current);
    } else if (line.startsWith("\t") && current) {
      lines.push(current);
    } else if (current) {
      const [key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      if (key === "author") current.author = value;
      else if (key === "author-time") current.time = Number(value);
      else if (key === "summary") current.summary = value;
    }
  }
  return lines;
}

/** Formats a Unix time as a short relative age, such as `3d` or `2y`. */
export function age(seconds: number, now = Date.now() / 1000): string {
  const units: [string, number][] = [["y", 31536000], ["mo", 2592000], ["d", 86400], ["h", 3600], ["m", 60]];
  const diff = Math.max(0, now - seconds);
  for (const [unit, size] of units) if (diff >= size) return `${Math.floor(diff / size)}${unit}`;
  return "now";
}

/**
 * Compares two versions of a file line by line and returns the changed ranges of the new
 * version, like `parseHunks`. Trims the common start and end, then runs a longest common
 * subsequence on the rest.
 * ponytail: quadratic LCS; above 4 million cell pairs the middle is marked modified as one block.
 */
export function lineChanges(before: string[], after: string[]): LineChange[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const a = before.slice(start, before.length - end);
  const b = after.slice(start, after.length - end);
  if (!a.length && !b.length) return [];
  const hunk = (removed: number, added: number, at: number): LineChange =>
    added === 0
      ? { kind: "deleted", start: Math.max(at, 1), end: Math.max(at, 1) }
      : { kind: removed === 0 ? "added" : "modified", start: at + 1, end: at + added };
  if (a.length * b.length > 4_000_000) return [hunk(a.length, b.length, start)];

  // lcs[i * (b.length + 1) + j] is the LCS length of a[i..] and b[j..].
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);

  const changes: LineChange[] = [];
  let i = 0;
  let j = 0;
  let removed = 0;
  let added = 0;
  const flush = () => {
    if (removed || added) changes.push(hunk(removed, added, start + j - added));
    removed = added = 0;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
      added++;
      j++;
    } else {
      removed++;
      i++;
    }
  }
  flush();
  return changes;
}

/** One entry of `statusCheckRollup` from `gh pr list/view --json`: a check run or a commit status. */
export type Check = { name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string; targetUrl?: string };
export type CheckState = "passed" | "failed" | "pending" | "skipped";

export function checkState(c: Check): CheckState {
  const result = c.conclusion || c.state || "";
  if (c.status && c.status !== "COMPLETED") return "pending";
  if (["SUCCESS"].includes(result)) return "passed";
  if (["NEUTRAL", "SKIPPED", "STALE"].includes(result)) return "skipped";
  if (["PENDING", "EXPECTED", ""].includes(result)) return "pending";
  return "failed"; // FAILURE, ERROR, CANCELLED, TIMED_OUT, ACTION_REQUIRED
}

/** Summarizes all checks: any failure wins, then anything pending, then passed. */
export function checksSummary(checks: Check[] | null | undefined): CheckState | "none" {
  const states = (checks ?? []).map(checkState);
  if (!states.length) return "none";
  if (states.includes("failed")) return "failed";
  if (states.includes("pending")) return "pending";
  return states.every((s) => s === "skipped") ? "skipped" : "passed";
}

export type Commit = { hash: string; short: string; author: string; time: number; refs: string[]; parents: string[]; subject: string };

/** The `git log` format that `parseLog` reads: fields split by \x1f, commits ended by \x1e. */
export const LOG_FORMAT = "--format=%H%x1f%h%x1f%an%x1f%at%x1f%D%x1f%P%x1f%s%x1e";

export function parseLog(out: string): Commit[] {
  return out
    .split("\x1e")
    .map((r) => r.replace(/^\n/, ""))
    .filter(Boolean)
    .map((r) => {
      const [hash, short, author, time, refs, parents, subject] = r.split("\x1f");
      return {
        hash,
        short,
        author,
        time: Number(time),
        refs: refs ? refs.split(", ").filter((ref) => ref !== "HEAD") : [],
        parents: parents ? parents.split(" ") : [],
        subject,
      };
    });
}

export type ChangedFile = { status: string; path: string; from?: string };

/** Parses `git diff-tree -r -M --name-status -z`: a status, then one path, or two for renames and copies. */
export function parseNameStatus(out: string): ChangedFile[] {
  const fields = out.split("\0").filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i][0];
    if (!/^[ACDMRTUX]$/.test(status)) continue; // Skips the commit hash that some forms print first.
    if (status === "R" || status === "C") files.push({ status, from: fields[++i], path: fields[++i] });
    else files.push({ status, path: fields[++i] });
  }
  return files;
}

export type Conflict = {
  /** 1-based lines of the markers: <<<<<<<, ||||||| (if present), =======, and >>>>>>>. */
  start: number;
  base?: number;
  separator: number;
  end: number;
  currentLabel: string;
  incomingLabel: string;
};

/** Finds git conflict blocks in a file's lines. */
export function parseConflicts(lines: string[]): Conflict[] {
  const conflicts: Conflict[] = [];
  let open: Partial<Conflict> | null = null;
  lines.forEach((line, i) => {
    const n = i + 1;
    if (line.startsWith("<<<<<<<")) open = { start: n, currentLabel: line.slice(7).trim() };
    else if (open && line.startsWith("|||||||") && open.separator === undefined) open.base = n;
    else if (open && line.startsWith("=======") && open.separator === undefined) open.separator = n;
    else if (open && line.startsWith(">>>>>>>") && open.separator !== undefined) {
      conflicts.push({ ...(open as Conflict), end: n, incomingLabel: line.slice(7).trim() });
      open = null;
    }
  });
  return conflicts;
}

/** Status letter pairs that mean a merge conflict in `git status --porcelain`. */
export const isConflict = (f: FileStatus) => f.index === "U" || f.worktree === "U" || (f.index === f.worktree && "AD".includes(f.index));

/** A change block as Monaco's diff reports it. An end of 0 means no lines on that side (the block is after `start`). */
export type Block = { originalStartLineNumber: number; originalEndLineNumber: number; modifiedStartLineNumber: number; modifiedEndLineNumber: number };

/** The original text with the chosen blocks taken from the modified text: how staging part of a file builds the new index. */
export function applyBlocks(original: string, modified: string, blocks: Block[]): string {
  const lines = original.split("\n");
  const from = modified.split("\n");
  // From the bottom up, so earlier line numbers stay valid.
  for (const b of [...blocks].sort((x, y) => y.originalStartLineNumber - x.originalStartLineNumber)) {
    const at = b.originalEndLineNumber ? b.originalStartLineNumber - 1 : b.originalStartLineNumber;
    const removed = b.originalEndLineNumber ? b.originalEndLineNumber - b.originalStartLineNumber + 1 : 0;
    const added = b.modifiedEndLineNumber ? from.slice(b.modifiedStartLineNumber - 1, b.modifiedEndLineNumber) : [];
    lines.splice(at, removed, ...added);
  }
  return lines.join("\n");
}

/** The same block seen from the other side, for undoing blocks (unstaging). */
export const mirror = (b: Block): Block => ({
  originalStartLineNumber: b.modifiedStartLineNumber,
  originalEndLineNumber: b.modifiedEndLineNumber,
  modifiedStartLineNumber: b.originalStartLineNumber,
  modifiedEndLineNumber: b.originalEndLineNumber,
});

/**
 * Pairs of 1-based lines, [from, to], that match: lines that occur exactly once in both texts, in the
 * same order (the longest increasing run, as in patience diff).
 */
export function lineAnchors(from: string[], to: string[]): [number, number][] {
  const count = (lines: string[]) => {
    const m = new Map<string, number[]>();
    lines.forEach((l, i) => l.trim() && m.set(l, [...(m.get(l) ?? []), i + 1]));
    return m;
  };
  const a = count(from);
  const b = count(to);
  const pairs: [number, number][] = [];
  for (const [line, at] of a) if (at.length === 1 && b.get(line)?.length === 1) pairs.push([at[0], b.get(line)![0]]);
  pairs.sort((x, y) => x[0] - y[0]);
  // The longest run of pairs that also increases on the other side (longest increasing subsequence).
  const tails: number[] = [];
  const prev: number[] = [];
  pairs.forEach(([, j], k) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < j) lo = mid + 1;
      else hi = mid;
    }
    prev[k] = lo ? tails[lo - 1] : -1;
    tails[lo] = k;
  });
  const chain: [number, number][] = [];
  for (let k = tails.at(-1) ?? -1; k >= 0; k = prev[k]) chain.unshift(pairs[k]);
  return chain;
}

/**
 * Blank lines to add to three versions of a file so that lines they share sit side by side: for each
 * pane, [after line, blank lines]. Result lines anchored in both sides split the texts into segments,
 * and each segment is padded to the tallest pane's height.
 */
export function alignmentGaps(
  ours: string[],
  result: string[],
  theirs: string[],
  /** Result lines that have one extra line drawn above them, such as a conflict's buttons. */
  resultExtra: number[] = [],
): Record<"ours" | "result" | "theirs", [number, number][]> {
  const toOurs = new Map(lineAnchors(result, ours));
  const toTheirs = new Map(lineAnchors(result, theirs));
  const shared: [number, number, number][] = [[0, 0, 0]];
  for (const [r, o] of toOurs) {
    const t = toTheirs.get(r);
    // Keep the order increasing in every pane.
    const last = shared.at(-1)!;
    if (t !== undefined && o > last[0] && t > last[2]) shared.push([o, r, t]);
  }
  shared.push([ours.length + 1, result.length + 1, theirs.length + 1]);
  const gaps: Record<"ours" | "result" | "theirs", [number, number][]> = { ours: [], result: [], theirs: [] };
  for (let k = 1; k < shared.length; k++) {
    const [o0, r0, t0] = shared[k - 1];
    const [o1, r1, t1] = shared[k];
    const extra = resultExtra.filter((line) => line > r0 && line < r1).length;
    const heights = [o1 - o0 - 1, r1 - r0 - 1 + extra, t1 - t0 - 1];
    const tallest = Math.max(...heights);
    (["ours", "result", "theirs"] as const).forEach((pane, i) => {
      const after = [o1, r1, t1][i] - 1;
      if (tallest > heights[i]) gaps[pane].push([after, tallest - heights[i]]);
    });
  }
  return gaps;
}

export type RebaseAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";
export type RebaseStep = { hash: string; subject: string; action: RebaseAction; message?: string };

/**
 * The todo list for `git rebase -i`, oldest commit first. A reword is a pick followed by an exec that
 * amends the message from a file, so no editor opens: `messageFile(i)` names the file for step i.
 */
export function rebaseTodo(steps: RebaseStep[], messageFile: (i: number) => string): string {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return steps
    .flatMap((s, i) => {
      if (s.action === "drop") return [`drop ${s.hash} ${s.subject}`];
      if (s.action === "reword") return [`pick ${s.hash} ${s.subject}`, `exec git commit --amend --quiet --file=${quote(messageFile(i))}`];
      return [`${s.action} ${s.hash} ${s.subject}`];
    })
    .join("\n") + "\n";
}

/** How alike two lines are, from 0 to 1: the Dice coefficient of their character pairs. */
function similarity(a: string, b: string): number {
  const pairs = (s: string) => {
    const m = new Map<string, number>();
    const t = s.trim();
    for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const x = pairs(a);
  const y = pairs(b);
  let common = 0;
  let total = 0;
  for (const [k, n] of x) (common += Math.min(n, y.get(k) ?? 0)), (total += n);
  for (const n of y.values()) total += n;
  return total ? (2 * common) / total : a.trim() === b.trim() ? 1 : 0;
}

type Step = { from?: number; to?: number };

/** Lines of two runs, paired in order by similarity; lines without a match stand alone. */
function pairLines(from: string[], to: string[]): Step[] {
  const p = from.length;
  const q = to.length;
  const score = Array.from({ length: p + 1 }, () => new Array<number>(q + 1).fill(0));
  for (let i = p - 1; i >= 0; i--)
    for (let j = q - 1; j >= 0; j--) {
      const sim = similarity(from[i], to[j]);
      score[i][j] = Math.max(score[i + 1][j], score[i][j + 1], sim >= 0.4 ? sim + score[i + 1][j + 1] : 0);
    }
  const matched: Step[] = [];
  let i = 0;
  let j = 0;
  while (i < p || j < q) {
    if (i < p && j < q && similarity(from[i], to[j]) >= 0.4 && score[i][j] === similarity(from[i], to[j]) + score[i + 1][j + 1]) matched.push({ from: i++, to: j++ });
    else if (i < p && (j >= q || score[i][j] === score[i + 1][j])) matched.push({ from: i++ });
    else matched.push({ to: j++ });
  }
  // Leftover lines between similar pairs pair by position, as when a line is rewritten outright.
  const steps: Step[] = [];
  let froms: number[] = [];
  let tos: number[] = [];
  const flush = () => {
    const n = Math.min(froms.length, tos.length);
    for (let k = 0; k < n; k++) steps.push({ from: froms[k], to: tos[k] });
    froms.slice(n).forEach((f) => steps.push({ from: f }));
    tos.slice(n).forEach((t) => steps.push({ to: t }));
    froms = [];
    tos = [];
  };
  for (const m of matched) {
    if (m.from !== undefined && m.to !== undefined) (flush(), steps.push(m));
    else if (m.from !== undefined) froms.push(m.from);
    else tos.push(m.to!);
  }
  flush();
  return steps;
}

/**
 * Applies only the selected lines of each block: the `from` text with some of the block's lines taken
 * from `to`. Within a block, lines pair up by similarity, so a changed line pairs with its new version.
 * A selected pair takes the `to` line; a `from` line with no pair is removed only if selected, and a
 * `to` line with no pair is added only if selected. `selectedFrom` and `selectedTo` get 1-based line
 * numbers in each text.
 */
export function applyLines(from: string, to: string, blocks: Block[], selectedFrom: (line: number) => boolean, selectedTo: (line: number) => boolean): string {
  const lines = from.split("\n");
  const target = to.split("\n");
  for (const b of [...blocks].sort((x, y) => y.originalStartLineNumber - x.originalStartLineNumber)) {
    const fromStart = b.originalEndLineNumber ? b.originalStartLineNumber : b.originalStartLineNumber + 1;
    const fromCount = b.originalEndLineNumber ? b.originalEndLineNumber - b.originalStartLineNumber + 1 : 0;
    const toStart = b.modifiedEndLineNumber ? b.modifiedStartLineNumber : b.modifiedStartLineNumber + 1;
    const toCount = b.modifiedEndLineNumber ? b.modifiedEndLineNumber - b.modifiedStartLineNumber + 1 : 0;
    const fromLines = lines.slice(fromStart - 1, fromStart - 1 + fromCount);
    const toLines = target.slice(toStart - 1, toStart - 1 + toCount);
    const out: string[] = [];
    for (const step of pairLines(fromLines, toLines)) {
      const selected = (step.from !== undefined && selectedFrom(fromStart + step.from)) || (step.to !== undefined && selectedTo(toStart + step.to));
      if (step.from !== undefined && step.to !== undefined) out.push(selected ? toLines[step.to] : fromLines[step.from]);
      else if (step.from !== undefined) !selected && out.push(fromLines[step.from]);
      else if (selected) out.push(toLines[step.to!]);
    }
    lines.splice(fromStart - 1, fromCount, ...out);
  }
  return lines.join("\n");
}

export type Worktree = { path: string; branch: string; main: boolean };

/** Parses `git worktree list --porcelain`. The first entry is the main worktree; bare ones are skipped. */
export function parseWorktrees(out: string): Worktree[] {
  return out
    .split("\n\n")
    .filter((block) => block.startsWith("worktree ") && !/^bare$/m.test(block))
    .map((block, i) => {
      const path = block.match(/^worktree (.*)$/m)![1];
      const branch = block.match(/^branch refs\/heads\/(.*)$/m)?.[1] ?? (/^detached$/m.test(block) ? "detached" : "");
      return { path, branch, main: i === 0 };
    });
}
