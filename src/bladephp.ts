// The PHP inside a Blade view as one PHP file Mago can check. Free of editor imports so Node can test it.
import { magicNoise, type Diagnostic } from "./diagnostics.ts";

/** Laravel's directives that take PHP arguments. Others, such as `@media` in CSS, stay text, as Blade leaves them. */
const directives = new Set(
  (
    "if elseif unless isset empty switch case break continue foreach forelse for while php json js class style checked selected disabled readonly required " +
    "include includeIf includeWhen includeUnless includeFirst each extends extendsFirst section yield hasSection sectionMissing push pushIf prepend pushOnce prependOnce stack " +
    "component slot props aware can cannot canany elsecan elsecannot elsecanany auth guest elseauth elseguest env production session context error method " +
    "lang choice inject dd dump vite once fragment livewire use"
  ).split(" "),
);

/** The index after the `)` that closes the `(` at `open`, skipping quoted strings, or -1. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * `text`, a Blade view, as a PHP file: a first line of `<?php` and the view's `@use` imports, then the view with
 * everything but its PHP blanked, so each problem's line, one less, and column are the view's. Each piece of PHP
 * becomes a statement that starts with `;` in place of its delimiter: `{{ $a }}` reads `;[ $a ]`, a directive's
 * arguments `;  [$a]` (an array, since they may be a list), `@foreach` keeps its keyword, as `;foreach (…)`, whose
 * body is the empty statement that follows, and `@php … @endphp` and `<?php … ?>` keep their code as is.
 */
export function bladeToPhp(text: string): string {
  const out = text.split("").map((c): string => (c === "\n" || c === "\r" ? c : " "));
  const put = (at: number, s: string) => s.split("").forEach((c, i) => (out[at + i] = c));
  const keep = (from: number, to: number) => {
    for (let i = from; i < to; i++) out[i] = text[i];
  };
  const imports: string[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i, i + 12);
    let end: number;
    if (rest.startsWith("{{--")) i = (end = text.indexOf("--}}", i)) < 0 ? text.length : end + 4;
    else if (rest.startsWith("@{{") || rest.startsWith("@@")) i += 2;
    else if (rest.startsWith("{{") || rest.startsWith("{!!")) {
      const raw = rest[1] === "!";
      end = text.indexOf(raw ? "!!}" : "}}", i);
      if (end < 0) break;
      put(raw ? i + 1 : i, ";[");
      keep(i + (raw ? 3 : 2), end);
      put(end, "]");
      i = end + (raw ? 3 : 2);
    } else if (/^<\?php\b/.test(rest) || /^@php\b(?!\s*\()/.test(rest)) {
      const php = rest[0] === "@";
      end = text.indexOf(php ? "@endphp" : "?>", i);
      if (end < 0) end = php ? -1 : text.length; // A PHP file may leave out ?>.
      if (end < 0) break;
      out[i] = ";";
      keep(i + (php ? 4 : 5), end);
      if (end < text.length) out[end] = ";";
      i = end + (php ? 7 : 2);
    } else if (/^@verbatim\b/.test(rest)) i = (end = text.indexOf("@endverbatim", i)) < 0 ? text.length : end + 12;
    else if (rest[0] === "@" && !/\w/.test(text[i - 1] ?? "")) {
      const [, name = "", space = ""] = text.slice(i).match(/^@(\w+)([ \t]*)/) ?? [];
      const open = i + 1 + name.length + space.length;
      end = text[open] === "(" && directives.has(name) ? closing(text, open) : -1;
      if (end < 0) {
        i += 1 + name.length;
        continue;
      }
      if (name === "use") {
        // @use('App\Models\Post', 'P') imports a class, as `use` at the top of a file.
        const [cls, alias] = [...text.slice(open, end).matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
        if (cls) imports.push(`use ${cls.replace(/^\\/, "")}${alias ? ` as ${alias}` : ""};`);
      } else if (/^(foreach|forelse|for|while)$/.test(name)) {
        put(i, name === "forelse" ? ";foreach" : `;${name}`);
        keep(open, end);
      } else {
        out[i] = ";";
        out[open] = "[";
        keep(open + 1, end - 1);
        out[end - 1] = "]";
      }
      i = end;
    } else if (/^<x[-:]/.test(rest)) {
      // A component's bound attributes, such as :title="$post->title", hold PHP. ::title is Alpine's, escaped.
      end = i;
      for (let quote = ""; end < text.length && (quote || text[end] !== ">"); end++) {
        if (quote ? text[end] === quote : text[end] === '"' || text[end] === "'") quote = quote ? "" : text[end];
      }
      for (const m of text.slice(i, end).matchAll(/\s:(?!:)[\w\-:.]+\s*(=)\s*(["'])(.*?)\2/gs)) {
        const at = i + m.index!;
        const quote = at + m[0].length - m[3].length - 2;
        out[at + m[0].indexOf("=", 2)] = ";";
        out[quote] = "[";
        keep(quote + 1, quote + 1 + m[3].length);
        out[quote + 1 + m[3].length] = "]";
      }
      i += 2;
    } else i++;
  }
  return `<?php ${imports.join(" ")}\n${out.join("")};`;
}

/**
 * Mago's problems in `bladeToPhp`'s file that hold for the view: its variables come from the controller or
 * component that renders it, so Mago doesn't know them. That drops undefined variables, and uses of their
 * `mixed` values and Laravel's magic (see magicNoise), leaving syntax errors, unknown classes, functions,
 * methods, and constants, and wrong arguments. Positions move up the first line.
 */
export function bladeProblems<D extends Diagnostic>(list: D[]): D[] {
  const up = (p: { line: number; character: number }) => ({ line: Math.max(0, p.line - 1), character: p.line ? p.character : 0 });
  return list
    .filter((d) => !/^(undefined-variable|possibly-undefined-variable|unused-statement|no-value)$/.test(String(d.code)) && !magicNoise(d))
    .map((d) => ({ ...d, range: { start: up(d.range.start), end: up(d.range.end) } }));
}
