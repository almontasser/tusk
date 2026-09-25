// Drops the analyzer issues that follow from a member only known at runtime, such as an Eloquent relationship
// read as a property. Free of editor imports so Node can test it.

type Position = { line: number; character: number };
type Diagnostic = { range: { start: Position }; source?: string; code?: string | number };

/**
 * `list` without the issues `isMagic` accepts, and without the `mixed-*` issues that follow from them, or from
 * magic at `anchors` (offsets, such as facade calls, which report nothing themselves): those in the same statement,
 * and those in later statements that use a variable such a statement assigned (`$post = Post::create(…)`), down
 * the chain, up to the end of the function (the next named function).
 */
export function withoutMagic<D extends Diagnostic>(text: string, list: D[], anchors: number[], isMagic: (d: D) => boolean): D[] {
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const offset = (p: Position) => (lineStarts[p.line] ?? text.length) + p.character;
  // The statement around an offset: from after the previous `;`, `{`, or `}` to the next `;`.
  const statement = (at: number): [number, number] => {
    const end = text.indexOf(";", at);
    return [Math.max(text.lastIndexOf(";", at - 1), text.lastIndexOf("{", at - 1), text.lastIndexOf("}", at - 1)) + 1, end < 0 ? text.length : end];
  };
  const resolved: [number, number][] = [];
  const kept = list.filter((d) => !(isMagic(d) && resolved.push(statement(offset(d.range.start)))));
  for (const at of anchors) resolved.push(statement(at));
  if (!resolved.length) return kept;
  // Variables those statements assign; they hold a value of the right type too.
  const typed: { name: string; from: number; to: number }[] = [];
  const assigned = ([start, end]: [number, number]) => {
    const name = text.slice(start, end).match(/^\s*\$(\w+)\s*=(?![=>])/)?.[1];
    if (!name || typed.some((t) => t.name === name && t.from <= end && end <= t.to)) return;
    const next = text.slice(end).search(/\bfunction\s+\w+\s*\(/);
    typed.push({ name, from: end, to: next < 0 ? text.length : end + next });
  };
  resolved.forEach(assigned);
  const followsFromMagic = (at: number) => {
    const [start, end] = statement(at);
    return resolved.some(([s, e]) => at >= s && at <= e) || typed.some((t) => at > t.from && at < t.to && new RegExp(`\\$${t.name}\\b`).test(text.slice(start, end)));
  };
  // In order of position, so a variable assigned from another's value is known before its own uses.
  const mixed = kept.filter((d) => /^mago/.test(d.source ?? "") && String(d.code ?? "").startsWith("mixed-")).sort((a, b) => offset(a.range.start) - offset(b.range.start));
  const dropped = new Set<D>();
  for (const d of mixed) {
    const at = offset(d.range.start);
    if (followsFromMagic(at)) dropped.add(d), assigned(statement(at));
  }
  return kept.filter((d) => !dropped.has(d));
}
