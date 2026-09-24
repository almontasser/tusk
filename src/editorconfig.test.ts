/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { globToRegex, indentation, parse, propertiesFor } from "./editorconfig.ts";

const laravel = `root = true

[*]
charset = utf-8
end_of_line = lf
indent_size = 4
indent_style = space
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false

[*.{yml,yaml}]
indent_size = 2

[docker-compose.yml]
indent_size = 4
`;

test("parses sections and the root flag", () => {
  const p = parse(laravel);
  assert.equal(p.root, true);
  assert.equal(p.sections.length, 4);
  assert.equal(p.sections[2].props.indent_size, "2");
});

test("matches globs as EditorConfig does", () => {
  const m = (glob: string, path: string) => globToRegex(glob).test(path);
  assert.ok(m("*", "app/Models/Post.php"));
  assert.ok(m("*.{yml,yaml}", ".github/workflows/ci.yaml"));
  assert.ok(m("docker-compose.yml", "docker-compose.yml"));
  assert.ok(!m("/docker-compose.yml", "sub/docker-compose.yml"));
  assert.ok(m("lib/**.js", "lib/a/b.js"));
  assert.ok(m("{package.json,*.yml}", "package.json"));
  assert.ok(m("file{1..3}.txt", "file2.txt"));
  assert.ok(!m("file{1..3}.txt", "file4.txt"));
  assert.ok(m("[Mm]akefile", "Makefile"));
  assert.ok(!m("*.php", "app/Post.phps"));
});

test("resolves a file's properties", () => {
  const configs = [{ dir: "/app", text: laravel }];
  assert.equal(propertiesFor("/app/config/app.yml", configs).indent_size, "2");
  assert.equal(propertiesFor("/app/docker-compose.yml", configs).indent_size, "4");
  assert.equal(propertiesFor("/app/README.md", configs).trim_trailing_whitespace, "false");
  const nested = [...configs, { dir: "/app/legacy", text: "[*.php]\nindent_style = tab\n" }];
  assert.deepEqual(indentation(propertiesFor("/app/legacy/a.php", nested)), { insertSpaces: false, tabSize: 4, indentSize: 4 });
  const rooted = [{ dir: "/", text: "[*]\nindent_size = 8\n" }, { dir: "/app", text: "root = true\n[*]\nindent_style = tab\n" }];
  assert.equal(propertiesFor("/app/a.php", rooted).indent_size, undefined);
});
