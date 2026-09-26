/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { bladeProblems, bladeToPhp } from "./bladephp.ts";
import type { Diagnostic } from "./diagnostics.ts";

/** The converted view without its first line, which bladeProblems' positions skip. */
const body = (blade: string) => bladeToPhp(blade).split("\n").slice(1).join("\n");

test("keeps the PHP where it is in the view and blanks the rest", () => {
  const blade = `<h1 class="{{ $a }}">{!! $b !!}</h1>\n@if ($c && f(')'))\n  @foreach ($posts as $post) x @endforeach\n@endif\n@php $d = 1; @endphp`;
  const php = body(blade);
  assert.equal(php.length, blade.length + 1);
  assert.deepEqual(php.split("\n").map((l) => l.length), blade.split("\n").map((l, i, all) => l.length + (i === all.length - 1 ? 1 : 0)));
  assert.equal(php, `           ;[ $a ]    ;[ $b ]       \n;   [$c && f(')')]\n  ;foreach ($posts as $post)              \n      \n;    $d = 1; ;      ;`);
});

test("reads directive lists, loops, @use, and bound component attributes", () => {
  assert.equal(body(`@include('a', ['x' => 1])`), `;       ['a', ['x' => 1]];`);
  assert.equal(body(`@forelse($a as $b) @empty @endforelse`), `;foreach($a as $b)                   ;`);
  assert.equal(body(`<x-card :post="$post" ::alpine="x" title="t" />`), `             ;[$post]                          ;`);
  assert.match(bladeToPhp(`@use('App\\Models\\Post', 'P')`), /^<\?php use App\\Models\\Post as P;\n/);
});

test("leaves comments, escapes, verbatim, and unknown directives as text", () => {
  for (const blade of ["{{-- {{ $a }} --}}", "@{{ vue }}", "@@if($a)", "@verbatim {{ $a }} @endverbatim", "@media (x: 1)", "a@if($x)"])
    assert.equal(body(blade).trim(), ";", blade);
});

test("drops problems about the view's variables and moves the rest up a line", () => {
  const at = (line: number, code: string): Diagnostic => ({ range: { start: { line, character: 3 }, end: { line, character: 5 } }, message: "", code, source: "mago" });
  const kept = bladeProblems([at(2, "undefined-variable"), at(2, "mixed-property-access"), at(2, "unused-statement"), at(3, "non-existent-function"), at(1, "parse")]);
  assert.deepEqual(kept.map((d) => [d.code, d.range.start.line]), [["non-existent-function", 2], ["parse", 0]]);
});
