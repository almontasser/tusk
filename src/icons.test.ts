/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileIcon, folderIcon, initials } from "./icons.ts";

test("picks icons by file name, then by extension", () => {
  assert.equal(fileIcon("welcome.blade.php").color, "icon-blade");
  assert.equal(fileIcon("Post.php").color, "icon-php");
  assert.equal(fileIcon("composer.json").color, "icon-php");
  assert.equal(fileIcon("app.ts").color, "icon-ts");
  assert.equal(fileIcon(".env.example").codicon, "key");
  assert.equal(fileIcon("phpunit.xml").codicon, "settings");
  assert.equal(fileIcon("LICENSE").codicon, "file");
});

test("marks dependency folders and project folders", () => {
  assert.equal(folderIcon("vendor", false).color, "icon-folder-excluded");
  assert.equal(folderIcon("tests", true).codicon, "folder-opened");
  assert.equal(folderIcon("app", false).color, "icon-folder-special");
  assert.equal(folderIcon("Models", false).color, "icon-folder");
});

test("builds project initials", () => {
  assert.equal(initials("lamah-sms-gateway"), "LS");
  assert.equal(initials("demo"), "DE");
  assert.equal(initials("php_editor"), "PE");
});
