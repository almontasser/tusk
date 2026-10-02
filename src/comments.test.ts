import { test } from "node:test";
import assert from "node:assert/strict";
import { commentMask, inComment, docblockPrefix, tabSpaces } from "./comments.ts";

test("masks comments but keeps code, strings, and offsets", () => {
  const source = "a(); // b\n/* c\nd */ e('/* f */', \"// g\");\n#[Test] # h\n";
  const masked = commentMask(source);
  assert.equal(masked.length, source.length);
  assert.equal(masked, "a();     \n    \n     e('/* f */', \"// g\");\n#[Test]    \n");
});

test("finds comments on a line", () => {
  const at = (line: string) => inComment(line, line.indexOf("TODO") + 1);
  for (const line of ["// TODO", "$a = 1; # TODO", "/* TODO */", " * TODO: docblock", "<!-- TODO -->", "{{-- TODO --}}", "x /* y */ // TODO"]) assert.ok(at(line), line);
  for (const line of ["$s = 'TODO';", 'echo "// TODO";', "/* x */ TODO", "color: #fff; TODO", "#[Attr] TODO", "url('http://x') TODO"]) assert.ok(!at(line), line);
});

test("reads heredocs and HTML outside PHP tags without losing track of strings", () => {
  const heredoc = "<?php\n$body = <<<TXT\nIt's // not a comment\nTXT;\n$a = 'x'; // real\nit('second', fn () => 1);\n";
  const masked = commentMask(heredoc);
  assert.ok(masked.includes("It's // not a comment"));
  assert.ok(!masked.includes("// real") && masked.includes("it('second'"));
  const inline = "<?php use App\\Foo; ?>\n<p>Don't</p>\n<?php\n// use App\\Bar;\n$x = 1;\n";
  assert.ok(!commentMask(inline).includes("use App\\Bar") && commentMask(inline).includes("$x = 1;"));
  assert.ok(commentMask("<p>Don't</p>\n<!-- TODO: x\n  more -->", true).trim() === "<p>Don't</p>");
});

test("docblockPrefix keeps the star and the spaces after it, under another docblock line", () => {
  assert.equal(docblockPrefix("     *         usage_pct: int,", "     * @return array{"), "     *         ");
  assert.equal(docblockPrefix("     * Hello", "    /**"), "     * ");
  assert.equal(docblockPrefix("     */", "     * Hello"), null);
  assert.equal(docblockPrefix("        * 2;", "    $a = 1"), null);
});

test("tabSpaces counts tab stops from the docblock text", () => {
  assert.equal(tabSpaces(7, 7, 4), 4);
  assert.equal(tabSpaces(8, 7, 4), 3);
  assert.equal(tabSpaces(11, 7, 4), 4);
});
