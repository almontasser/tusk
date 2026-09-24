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
