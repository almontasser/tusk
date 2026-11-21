/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { latestLoads } from "./prdata.ts";

/** A load that finishes when the test says so. */
function deferred<V>() {
  let resolve!: (v: V) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<V>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

test("loads of two keys that finish out of order keep their own values", async () => {
  const store = latestLoads<string | null>(null);
  const a = deferred<string | null>();
  const b = deferred<string | null>();
  const loadA = store.load("A", () => a.promise);
  const loadB = store.load("B", () => b.promise);
  b.resolve("review of B");
  await loadB;
  a.resolve(null);
  await loadA;
  assert.equal(store.get("A"), null);
  assert.equal(store.get("B"), "review of B");
  assert.equal(await store.latest("A", () => Promise.reject(new Error("not asked again"))), null);
  assert.equal(await store.latest("B", () => Promise.reject(new Error("not asked again"))), "review of B");
});

test("an older load of a key that finishes last doesn't overwrite a newer one", async () => {
  const store = latestLoads<string | null>(null);
  const old = deferred<string | null>();
  const loadOld = store.load("A", () => old.promise);
  await store.load("A", async () => "new");
  old.resolve("old");
  assert.equal(await loadOld, "old");
  assert.equal(store.get("A"), "new");
});

test("set makes loads on their way out of date", async () => {
  const store = latestLoads<string | null>(null);
  const slow = deferred<string | null>();
  const load = store.load("A", () => slow.promise);
  store.set("A", null); // Submitted: no pending review any more.
  slow.resolve("pending review");
  await load;
  assert.equal(store.get("A"), null);
  assert.equal(await store.latest("A", async () => "asked"), null);
});

test("a failed load keeps the value, and shares it", async () => {
  const store = latestLoads<string | null>(null);
  await store.load("A", async () => "review");
  const failed = store.load("A", () => Promise.reject(new Error("offline")));
  await assert.rejects(failed, /offline/);
  assert.equal(store.get("A"), "review");
  assert.equal(await store.latest("A", async () => "asked"), "review");
});
