/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { addLabel, parseLabels, parseVersion, parseVersions, versionAt, versionName } from "./localhistorydata.ts";

test("version names carry their action", () => {
  assert.deepEqual(parseVersion(versionName(1700000000000, "git checkout")), { time: 1700000000000, action: "git checkout", name: "1700000000000~git%20checkout.txt" });
  assert.deepEqual(parseVersion("1700000000000.txt"), { time: 1700000000000, action: "Saved", name: "1700000000000.txt" });
  assert.equal(parseVersion("labels.json"), null);
  assert.equal(parseVersion("1~%E0.txt")?.action, "%E0");
});

test("versions sort newest first, and versionAt finds the file at a time", () => {
  const list = parseVersions(["3.txt", "1~Saved.txt", "x", "2~Before%20delete.txt"]);
  assert.deepEqual(list.map((v) => v.time), [3, 2, 1]);
  assert.equal(versionAt(list, 2)?.time, 2);
  assert.equal(versionAt(list, 2.5)?.time, 2);
  assert.equal(versionAt(list, 0), undefined);
});

test("labels read safely and keep the newest", () => {
  assert.deepEqual(parseLabels("nope"), []);
  assert.deepEqual(parseLabels('[{"time":1,"name":"a"},{"time":"x"},{"time":2,"name":"b"}]').map((l) => l.name), ["b", "a"]);
  assert.deepEqual(addLabel([{ time: 1, name: "a" }], { time: 2, name: "b" }, 1), [{ time: 2, name: "b" }]);
});
