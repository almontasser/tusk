/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { isJump, Places, testPartner, testPartners } from "./navigation.ts";

const at = (path: string, line: number) => ({ path, line, column: 1 });

test("a jump is another file or more than 10 lines away", () => {
  assert.equal(isJump(at("a", 1), at("a", 11)), false);
  assert.equal(isJump(at("a", 1), at("a", 12)), true);
  assert.equal(isJump(at("a", 1), at("b", 1)), true);
});

test("goes back and forward, and a new jump drops the forward places", () => {
  const h = new Places();
  h.push(at("a", 1));
  h.push(at("b", 5));
  assert.deepEqual(h.goBack(at("c", 9)), at("b", 5));
  assert.deepEqual(h.goBack(at("b", 5)), at("a", 1));
  assert.equal(h.goBack(at("a", 1)), undefined);
  assert.deepEqual(h.goForward(at("a", 1)), at("b", 5));
  assert.deepEqual(h.goForward(at("b", 5)), at("c", 9));
  h.goBack(at("c", 9));
  h.push(at("b", 5));
  assert.deepEqual(h.forward, []);
});

test("skips places on the current line and repeated places, and keeps 50", () => {
  const h = new Places();
  h.push(at("a", 1));
  h.push(at("a", 1));
  h.push(at("b", 2));
  assert.equal(h.back.length, 2);
  assert.deepEqual(h.goBack(at("b", 2)), at("a", 1));
  for (let i = 0; i < 60; i++) h.push(at("a", i * 20));
  assert.equal(h.back.length, 50);
  assert.deepEqual(h.back[0], at("a", 200));
});

test("pairs a class with its test", () => {
  assert.equal(testPartner("/p/app/User.php"), "UserTest.php");
  assert.equal(testPartner("/p/tests/UserTest.php"), "User.php");
  assert.equal(testPartner("/p/a.js"), undefined);
  const files = ["app/Models/User.php", "tests/Unit/UserTest.php", "tests/Feature/UserTest.php", "vendor/x/UserTest.php", "app/SuperUser.php"];
  assert.deepEqual(testPartners("/p/app/Models/User.php", files), ["tests/Unit/UserTest.php", "tests/Feature/UserTest.php"]);
  assert.deepEqual(testPartners("/p/tests/Unit/UserTest.php", files), ["app/Models/User.php"]);
});
