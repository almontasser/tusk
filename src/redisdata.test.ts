import assert from "node:assert/strict";
import { test } from "node:test";
import type { Changes } from "./dbgrid.ts";
import { commandDocs, commandLine, editCommands, filterPattern, formatBytes, formatTtl, keyTree, parseDuration, replyText, splitCommand, typeLabel, valueKind, visibleRows } from "./redisdata.ts";

const changes = (c: Partial<Changes<string | null>>): Changes<string | null> => ({ edits: new Map(), deletes: new Set(), inserts: [], ...c });

test("groups keys into folders by colon", () => {
  const tree = keyTree([{ key: "users:10", type: "hash" }, { key: "users:2", type: "hash" }, { key: "cache:a:b", type: "string" }, { key: "solo", type: "list" }]);
  assert.equal(tree.count, 4);
  assert.deepEqual([...tree.folders.keys()], ["cache", "users"]);
  assert.equal(tree.folders.get("cache")!.folders.get("a")!.prefix, "cache:a:");
  const open = visibleRows(tree, (p) => p === "users:");
  assert.deepEqual(open.map((r) => (r.kind === "folder" ? `${r.folder.name}/ ${r.folder.count}` : `${r.name} @${r.depth}`)), ["cache/ 1", "users/ 2", "2 @1", "10 @1", "solo @0"]);
  // A key ending in the delimiter shows its whole name.
  assert.deepEqual(visibleRows(keyTree([{ key: "a:", type: "string" }]), () => true).map((r) => r.kind === "key" && r.name), [false, "a:"]);
});

test("reads filters, durations, and sizes", () => {
  assert.equal(filterPattern(""), "*");
  assert.equal(filterPattern("user"), "*user*");
  assert.equal(filterPattern("user:*"), "user:*");
  assert.equal(filterPattern("a[1]"), "a[1]");
  assert.equal(filterPattern("50%\\"), "*50%\\\\*");
  assert.equal(formatTtl(-1), "No expiry");
  assert.equal(formatTtl(-2), "Expired");
  assert.equal(formatTtl(0), "0s");
  assert.equal(formatTtl(45), "45s");
  assert.equal(formatTtl(3725), "1h 2m");
  assert.equal(formatTtl(90061), "1d 1h");
  assert.equal(formatTtl(3619), "1h 0m");
  assert.equal(parseDuration(formatTtl(3619)), 3600);
  assert.equal(parseDuration("90"), 90);
  assert.equal(parseDuration("1h 30m"), 5400);
  assert.equal(parseDuration(formatTtl(3725)), 3720);
  assert.equal(parseDuration(""), -1);
  assert.equal(parseDuration("never"), -1);
  assert.equal(parseDuration("soon"), null);
  assert.equal(parseDuration("0"), null);
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(typeLabel("zset"), "ZSET");
  assert.equal(typeLabel("MBbloom--"), "MBBL");
  assert.equal(valueKind('{"a":1}'), "json");
  assert.equal(valueKind('a:1:{s:1:"a";i:1;}'), "php");
  assert.equal(valueKind("{not json"), "");
  assert.equal(replyText(["a", 1, null, { binary: 2048, hex: "ff" }]), '["a","1",null,"<binary, 2.0 KB>"]');
});

test("splits and quotes command lines as redis-cli", () => {
  assert.deepEqual(splitCommand(`  SET "a key" 'it\\'s' "line\\n\\"two\\"" `), ["SET", "a key", "it's", 'line\n"two"']);
  assert.equal(splitCommand('GET "open'), null);
  assert.deepEqual(splitCommand("   "), []);
  const args = ["SET", "a key", 'say "hi"', "back\\slash", "", "plain"];
  assert.deepEqual(splitCommand(commandLine(args)), args);
});

test("turns grid edits into commands per type", () => {
  const hash = [["name", "Ada"], ["role", "admin"]];
  assert.deepEqual(
    editCommands("hash", "u", hash, changes({ edits: new Map([[0, new Map([[1, "Grace"]])], [1, new Map([[0, "title"]])]]), inserts: [{ field: "age", value: "36" }] })),
    [["HSET", "u", "name", "Grace"], ["HDEL", "u", "role"], ["HSET", "u", "title", "admin"], ["HSET", "u", "age", "36"]],
  );
  assert.throws(() => editCommands("hash", "u", hash, changes({ inserts: [{ value: "x" }] })), /needs a name/);
  // A deleted row's edit is dropped; list deletes go through a marker, at the page's indexes.
  assert.deepEqual(
    editCommands("list", "q", [["a"], ["b"], ["c"]], changes({ edits: new Map([[0, new Map([[0, "A"]])], [1, new Map([[0, "B"]])]]), deletes: new Set([1, 2]), inserts: [{}] }), 1000, "M"),
    [["LSET", "q", "1000", "A"], ["LSET", "q", "1001", "M"], ["LSET", "q", "1002", "M"], ["LREM", "q", "0", "M"], ["RPUSH", "q", ""]],
  );
  assert.deepEqual(editCommands("set", "s", [["x"]], changes({ edits: new Map([[0, new Map([[0, "y"]])]]) })), [["SREM", "s", "x"], ["SADD", "s", "y"]]);
  assert.deepEqual(
    editCommands("zset", "z", [["ada", "10"]], changes({ edits: new Map([[0, new Map([[1, "12.5"]])]]), inserts: [{ member: "bob" }] })),
    [["ZADD", "z", "12.5", "ada"], ["ZADD", "z", "0", "bob"]],
  );
  assert.throws(() => editCommands("zset", "z", [["ada", "10"]], changes({ edits: new Map([[0, new Map([[1, "ten"]])]]) })), /must be a number/);
  assert.deepEqual(editCommands("stream", "s", [["1-1", "[]"], ["1-2", "[]"]], changes({ deletes: new Set([0, 1]) })), [["XDEL", "s", "1-1", "1-2"]]);
});

test("reads COMMAND DOCS into syntax", () => {
  const arg = (...kv: unknown[]) => kv;
  const docs = commandDocs([
    "set",
    [
      "summary", "Sets the string value of a key.", "since", "1.0.0", "group", "string",
      "arguments", [
        arg("name", "key", "type", "key", "display_text", "key"),
        arg("name", "value", "type", "string"),
        arg("name", "condition", "type", "oneof", "flags", ["optional"], "arguments", [arg("name", "nx", "type", "pure-token", "token", "NX"), arg("name", "xx", "type", "pure-token", "token", "XX")]),
        arg("name", "seconds", "type", "integer", "token", "EX", "flags", ["optional"]),
      ],
    ],
    "del",
    ["summary", "Deletes keys.", "arguments", [arg("name", "key", "type", "key", "flags", ["multiple"])]],
    "config",
    ["summary", "Config.", "subcommands", ["config|get", ["summary", "Gets config.", "arguments", [arg("name", "parameter", "type", "string", "flags", ["multiple"])]]]],
  ] as never);
  assert.deepEqual(docs.map((d) => d.syntax), ["CONFIG", "CONFIG GET parameter [parameter ...]", "DEL key [key ...]", "SET key value [NX | XX] [EX seconds]"]);
  assert.equal(docs.find((d) => d.name === "SET")!.summary, "Sets the string value of a key.");
});
