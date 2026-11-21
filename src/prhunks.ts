// Pull requests: which lines of a diff GitHub takes comments on, applying several suggestions, and pending comments' sides.

export type Side = "LEFT" | "RIGHT";
/** A hunk's lines on each side, first and last, or null when the hunk has none on that side. */
export type Hunk = Record<Side, [number, number] | null>;

/**
 * The hunks of a unified diff, from their `@@ -a,b +c,d @@` headers. GitHub takes a comment only on a line inside a
 * hunk of its own diff, changed or context, and a range only inside one hunk. A missing count means 1.
 */
export function hunks(patch: string): Hunk[] {
  const range = (start: string, count: string | undefined): [number, number] | null => {
    const n = count === undefined ? 1 : Number(count);
    return n ? [Number(start), Number(start) + n - 1] : null;
  };
  return [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({ LEFT: range(m[1], m[2]), RIGHT: range(m[3], m[4]) }));
}

/** The index of the hunk that holds a side's line, or -1 when GitHub takes no comment there. */
export const hunkAt = (list: Hunk[], side: Side, line: number) => list.findIndex((h) => !!h[side] && h[side]![0] <= line && line <= h[side]![1]);

/** Keeps a dragged line inside the hunk the drag started in, since a range can't span hunks. */
export function clampToHunk(list: Hunk[], side: Side, anchor: number, line: number) {
  const r = list[hunkAt(list, side, anchor)]?.[side];
  return r ? Math.min(r[1], Math.max(r[0], line)) : anchor;
}

/** Whether GitHub takes a comment on lines `start` to `end` of a side: both in the same hunk. */
export function commentable(list: Hunk[], side: Side, start: number, end: number) {
  const h = hunkAt(list, side, start);
  return h >= 0 && h === hunkAt(list, side, end);
}

/** A suggestion to put into a file: it replaces lines `start` to `end`. */
export type Suggested = { id: number; path: string; start: number; end: number; text: string };

/**
 * Orders suggestions to apply one after another: in each file from the bottom up, so an edit never moves the lines
 * of the ones still to come. Two suggestions on overlapping lines can't both apply, so they come back as `overlap`.
 */
export function batchOrder(list: Suggested[]): { ordered: Suggested[]; overlap?: [Suggested, Suggested] } {
  const ordered = [...list].sort((a, b) => a.path.localeCompare(b.path) || b.start - a.start);
  for (let i = 1; i < ordered.length; i++) {
    const [below, above] = [ordered[i - 1], ordered[i]];
    if (below.path === above.path && above.end >= below.start) return { ordered, overlap: [above, below] };
  }
  return { ordered };
}

/** A pending comment as GraphQL lists it. */
export type PendingNode = { id: number; path: string; line: number | null; start_line: number | null; body: string; user: string; in_reply_to_id: number | null; created_at: string; subject: "LINE" | "FILE" };

/**
 * Gives each pending comment its side, which GraphQL keeps on its thread, keyed by the thread's first comment. A
 * reply takes its thread's side. A comment on the whole file has no line.
 */
export function withSides(nodes: PendingNode[], sides: Map<number, Side>) {
  return nodes.map(({ subject, ...c }) => ({
    ...c,
    side: sides.get(c.in_reply_to_id ?? c.id) ?? ("RIGHT" as Side),
    subject_type: subject === "FILE" ? ("file" as const) : ("line" as const),
    ...(subject === "FILE" ? { line: null, start_line: null } : {}),
  }));
}
