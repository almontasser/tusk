import { test } from "node:test";
import assert from "node:assert/strict";
import { commentMask, inComment } from "./comments.ts";

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
