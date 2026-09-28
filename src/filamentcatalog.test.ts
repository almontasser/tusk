/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type Catalog, classInfo, essentials, heroiconCase, heroiconFile, humanize, labelFromName, majorVersion, methodEditor, methodsOf, palette } from "./filamentcatalog.ts";

/** A slice of Filament 4.10's catalog, from `introspect.php filament-catalog` on a real app. */
const cat: Catalog = JSON.parse(readFileSync(new URL("./fixtures/designer/catalog.json", import.meta.url), "utf8"));
const textInput = classInfo(cat, "Filament\\Forms\\Components\\TextInput")!;

test("majorVersion reads the catalog's version", () => {
  assert.equal(majorVersion(cat), 4);
  assert.equal(majorVersion({ version: null }), 0);
});

test("methodsOf resolves each method to the class or trait PHP takes it from", () => {
  const methods = methodsOf(cat, textInput);
  assert.equal(methods.get("maxLength")!.label, "CanBeLengthConstrained");
  assert.equal(methods.get("required")!.label, "CanBeValidated");
  assert.ok(methods.get("label"));
  assert.ok(!methods.has("make"));
});

test("methodEditor picks an editor from the parameter types", () => {
  const methods = methodsOf(cat, textInput);
  const editor = (name: string) => methodEditor(cat, name, methods.get(name)!.method).kind;
  assert.equal(editor("required"), "switch");
  assert.equal(editor("maxLength"), "number");
  assert.equal(editor("placeholder"), "text");
  assert.equal(editor("prefixIcon"), "icon");
  assert.equal(editor("columnSpanFull"), "presence");
  assert.equal(editor("afterStateUpdated"), "code");
  const select = methodsOf(cat, classInfo(cat, "Filament\\Forms\\Components\\Select")!);
  assert.equal(methodEditor(cat, "options", select.get("options")!.method).kind, "map");
  const column = methodsOf(cat, classInfo(cat, "Filament\\Tables\\Columns\\TextColumn")!);
  assert.deepEqual(methodEditor(cat, "alignment", column.get("alignment")!.method), { kind: "enum", enum: "Filament\\Support\\Enums\\Alignment" });
  assert.equal(methodEditor(cat, "color", column.get("color")!.method).kind, "color");
});

test("palette groups the common classes first and leaves out base and old classes", () => {
  const groups = palette(cat, ["field", "layout"]);
  assert.deepEqual(groups.map((g) => g.label), ["Text", "Choice", "Date and time", "Layout"]);
  assert.deepEqual(groups[1].classes.map((c) => c.class.split("\\").pop()), ["Select", "Toggle"]);
  assert.equal(palette(cat, ["column"]).flatMap((g) => g.classes).some((c) => c.class.endsWith("BadgeColumn")), false);
  assert.deepEqual(palette(cat, ["field"], "switch").flatMap((g) => g.classes.map((c) => c.class.split("\\").pop())), ["Toggle"]);
});

test("essentials lists a kind's settings, then the class's", () => {
  const list = essentials(textInput);
  assert.equal(list[0], "@name");
  assert.ok(list.indexOf("@inputType") > list.indexOf("required"));
});

test("names and icons", () => {
  assert.equal(humanize("maxLength"), "Max length");
  assert.equal(humanize("persistTabInQueryString"), "Persist tab in query string");
  assert.equal(labelFromName("category_id"), "Category");
  assert.equal(labelFromName("author.name"), "Author name");
  assert.equal(heroiconFile("OutlinedRectangleStack"), "o-rectangle-stack");
  assert.equal(heroiconFile("User"), "s-user");
  assert.equal(heroiconFile("MiniArrowUp"), "m-arrow-up");
  assert.equal(heroiconCase("heroicon-o-rectangle-stack"), "OutlinedRectangleStack");
  assert.equal(heroiconCase("s-user"), "User");
  assert.equal(heroiconCase("o-arrow-up-on-square-2"), "OutlinedArrowUpOnSquare2");
});
