import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesOf, compareCells, formatRows, hexDump, sortOrder, tsv, viewerMode } from "./dbgriddata.ts";

const columns = ["id", "note"];
const rows = [
  ["1", 'say "hi", then\nleave'],
  ["2", null],
];

test("copies rows in each format", () => {
  assert.equal(tsv(rows), "1\tsay \"hi\", then leave\n2\t");
  assert.equal(formatRows("csv", columns, rows), 'id,note\r\n1,"say ""hi"", then\nleave"\r\n2,');
  assert.deepEqual(JSON.parse(formatRows("json", columns, rows)), [{ id: "1", note: 'say "hi", then\nleave' }, { id: "2", note: null }]);
  assert.equal(formatRows("sql", columns, rows, "notes", "mysql"), "INSERT INTO `notes` (`id`, `note`) VALUES ('1', 'say \"hi\", then\nleave');\nINSERT INTO `notes` (`id`, `note`) VALUES ('2', NULL);");
  assert.equal(formatRows("markdown", ["a|b"], [["x\ny"], [null]]), "| a\\|b |\n| --- |\n| x<br>y |\n| NULL |");
});

test("sorts NULL first, numbers by value, and text naturally", () => {
  assert.ok(compareCells(null, "a") < 0);
  assert.ok(compareCells("9", "10") < 0);
  assert.ok(compareCells("-1.5", "2e1") < 0);
  assert.ok(compareCells("item2", "item10") < 0);
  const cells = [["b"], [null], ["10"], ["9"], ["b"]];
  assert.deepEqual(sortOrder(cells, 0, false), [1, 3, 2, 0, 4]);
  assert.deepEqual(sortOrder(cells, 0, true), [0, 4, 2, 3, 1]);
});

test("shows bytes as hex and chooses the viewer's mode", () => {
  assert.deepEqual([...bytesOf("\\x00ff")], [0, 255]);
  assert.deepEqual([...bytesOf("hé")], [104, 195, 169]);
  assert.equal(hexDump(bytesOf("\\x414243")), `00000000  ${"41 42 43".padEnd(47)}  ABC`);
  assert.equal(viewerMode('{"a": 1}', false), "json");
  assert.equal(viewerMode("{not json", false), "text");
  assert.equal(viewerMode("\\x00", true), "hex");
});
