/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { convert, hex, parseJsonc, parsePlist, readTheme, styleOf } from "./colortheme.ts";

test("parseJsonc strips comments and trailing commas but not URLs in strings", () => {
  assert.deepEqual(parseJsonc('{ // note\n "a": "http://x/*y*/", /* c */ "b": [1, 2,], }'), { a: "http://x/*y*/", b: [1, 2] });
});

test("hex normalizes short forms and rejects names", () => {
  assert.equal(hex("#ABC"), "#aabbcc");
  assert.equal(hex("ff000080"), "#ff000080");
  assert.equal(hex("red"), undefined);
});

test("styleOf picks the most specific selector and skips parent selectors", () => {
  const rules = [
    { scope: "keyword", settings: { foreground: "#111111" } },
    { scope: ["keyword.control", "storage"], settings: { foreground: "#222222", fontStyle: "bold" } },
    { scope: "source.php keyword.control.php", settings: { foreground: "#333333" } },
  ];
  assert.deepEqual(styleOf(rules, "keyword.control.php").style, { foreground: "#222222", fontStyle: "bold" });
  assert.equal(styleOf(rules, "keyword.operator").style.foreground, "#111111");
  assert.equal(styleOf(rules, "string").score, 0);
});

test("a .tmTheme becomes a theme with its global colors and scopes", () => {
  const xml = `<?xml version="1.0"?><plist version="1.0"><dict><key>name</key><string>Tiny &amp; Dark</string><key>settings</key><array>
    <dict><key>settings</key><dict><key>background</key><string>#101010</string><key>foreground</key><string>#EEEEEE</string></dict></dict>
    <dict><key>scope</key><string>comment</string><key>settings</key><dict><key>foreground</key><string>#808080</string><key>fontStyle</key><string/></dict></dict>
  </array></dict></plist>`;
  const theme = readTheme(parsePlist(xml));
  assert.equal(theme.name, "Tiny & Dark");
  assert.equal(theme.type, "dark");
  const out = convert(theme);
  assert.equal(out.monaco.colors["editor.background"], "#101010");
  assert.deepEqual(out.monaco.rules.find((r) => r.token === "comment"), { token: "comment", foreground: "808080", fontStyle: "" });
});

test("every bundled theme converts with opaque interface colors", () => {
  const dirs = ["node_modules/tm-themes/themes", "node_modules/monaco-themes/themes"];
  for (const dir of dirs) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "themelist.json")) {
      const out = convert(readTheme(parseJsonc(readFileSync(`${dir}/${file}`, "utf8"))));
      for (const key of ["bg", "panel", "text", "border", "accent", "input-bg"]) assert.match(out.ui[key], /^#[0-9a-f]{6}$/, `${file} ${key}`);
      assert.ok(out.monaco.rules.length > 20, file);
    }
  }
});
