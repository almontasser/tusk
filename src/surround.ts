// Surround With's templates and Paste from History's list: the parts of those actions that don't need Monaco.

/**
 * A Surround With template, as snippet text around `$TM_SELECTED_TEXT`. A `block` wraps whole lines, so the snippet's
 * indentation applies to each of them; otherwise it wraps the selection as it is, such as an expression.
 */
export type Surround = { label: string; snippet: string; block: boolean };

const block = (label: string, open: string, close: string, after = "$0"): Surround => ({ label, snippet: `${open}\n\t$TM_SELECTED_TEXT\n${close}${after}`, block: true });

export const PHP_SURROUNDS: Surround[] = [
  block("if", "if (${1}) {", "}"),
  block("if / else", "if (${1}) {", "} else {\n\t$0\n}", ""),
  block("while", "while (${1}) {", "}"),
  block("for", "for (\\$${1:i} = 0; \\$${1:i} < ${2}; \\$${1:i}++) {", "}"),
  block("foreach", "foreach (\\$${1:items} as \\$${2:item}) {", "}"),
  block("try / catch", "try {", "} catch (${1:\\\\Exception} \\$${2:e}) {\n\t$0\n}", ""),
  block("try / finally", "try {", "} finally {\n\t$0\n}", ""),
  block("function () { }", "function (${1}) {", "}"),
  { label: "( )", snippet: "($TM_SELECTED_TEXT)$0", block: false },
];

export const BLADE_SURROUNDS: Surround[] = [
  block("@if", "@if (${1})", "@endif"),
  block("@foreach", "@foreach (\\$${1:items} as \\$${2:item})", "@endforeach"),
  block("@auth", "@auth", "@endauth"),
  block("@php", "@php", "@endphp"),
];

type Range = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };

/**
 * What a block template wraps: the selected lines from their first non-blank character to the end of the last, or
 * the caret's line with nothing selected. A selection ending at a line's start leaves that line out.
 */
export function blockRange(sel: Range, line: (n: number) => string): Range {
  const end = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
  const first = line(sel.startLineNumber);
  return { startLineNumber: sel.startLineNumber, startColumn: first.length - first.trimStart().length + 1, endLineNumber: end, endColumn: line(end).length + 1 };
}

/** Adds a copied text to the front of the history, without blank texts or repeats, keeping the newest `max`. */
export const remember = (history: string[], text: string, max = 20) => (text.trim() ? [text, ...history.filter((t) => t !== text)].slice(0, max) : history);
