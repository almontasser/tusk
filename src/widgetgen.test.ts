import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./designerfixture.ts";
import { applyEdits, type ArrayNode, methodNamed } from "./phpcode.ts";
import { partColorEdits, type Metric, metricCode, widgetFile, readChartData, readMetric, readSeries, readStats, readValue, type Series, seriesCode, seriesEdits, squash, trendCode, isTrend, valueCode } from "./widgetgen.ts";

const plain = (code: string) => code.replace(/\{\{[\w\\]*?(\w+)\}\}/g, "$1");
const metrics: Metric[] = [
  { model: "App\\Models\\Order", agg: "count", column: null, where: [], days: null },
  { model: "App\\Models\\Order", agg: "sum", column: "total", where: [{ column: "status", op: "=", value: "paid" }, { column: "total", op: ">=", value: 10.5 }, { column: "deleted_at", op: "=", value: null }, { column: "flag", op: "!=", value: true }], days: 30 },
];

test("metrics round-trip through their code", () => {
  for (const m of metrics) {
    const read = readMetric(metricCode(m).replace(/\{\{([\w\\]+)\}\}/g, "\\$1"));
    assert.deepEqual(read, m);
  }
  assert.equal(readMetric("Order::query()->where('a', 1)->count() + 1"), null);
  assert.equal(readMetric("Order::where('a', 1)->count()"), null);
  assert.equal(squash("Order::query()\n    ->where('a', 1,)\n    ->count()"), "Order::query()->where('a', 1)->count()");
});

test("values and trends", () => {
  const m = metrics[1];
  assert.deepEqual(readValue(plain(valueCode(m, { kind: "currency", currency: "EUR" })))?.format, { kind: "currency", currency: "EUR" });
  assert.deepEqual(readValue(plain(valueCode(m, { kind: "number" })))?.format, { kind: "number" });
  assert.ok(isTrend(plain(trendCode(m))));
});

test("series round-trip", () => {
  const all: Series[] = [
    { kind: "time", unit: "month", count: 12, metric: metrics[0] },
    { kind: "time", unit: "day", count: 7, metric: { ...metrics[1], days: null } },
    { kind: "group", column: "status", metric: metrics[0] },
    { kind: "group", column: "status", metric: { ...metrics[1], days: null } },
  ];
  for (const s of all) assert.deepEqual(readSeries(seriesCode(s).data.replace(/\{\{([\w\\]+)\}\}/g, "\\$1")), s);
});

test("stats read from getStats()", () => {
  const f = fixture("OrderStatsWidget");
  const arr = methodNamed(f.outline.classes[0], "getStats")!.returns[0] as ArrayNode;
  const stats = readStats(arr, f.text);
  assert.deepEqual(stats.map((s) => [s.label?.text, s.description?.text, s.color, s.trend]), [
    ["Open orders", "Waiting for us", "warning", "designed"],
    ["Revenue", undefined, null, null],
    ["Custom", undefined, null, null],
  ]);
  const value = (i: number) => f.text.slice(stats[i].value!.span[0], stats[i].value!.span[1]);
  assert.deepEqual(readValue(value(1)), { metric: { model: "Order", agg: "sum", column: "total_price", where: [], days: 30 }, format: { kind: "currency", currency: "USD" } });
  assert.equal(readValue(value(2)), null);
});

test("chart data reads and changes in place", () => {
  const f = fixture("OrdersChartWidget");
  const arr = methodNamed(f.outline.classes[0], "getData")!.returns[0] as ArrayNode;
  const c = readChartData(arr, f.text);
  assert.equal(c.label?.text, "Orders");
  assert.deepEqual(c.series, { kind: "time", unit: "month", count: 12, metric: { model: "Order", agg: "count", column: null, where: [], days: null } });
  const next = plain(applyEdits(f.text, seriesEdits(f.text, c, "Orders", { kind: "group", column: "status", metric: { model: "App\\Models\\Order", agg: "count", column: null, where: [], days: null } })));
  assert.match(next, /'data' => Order::query\(\)->selectRaw\('status, count\(\*\) as aggregate'\)->groupBy\('status'\)->pluck\('aggregate', 'status'\)->values\(\)->all\(\),\n {20}'borderColor'/);
  assert.match(next, /'labels' => Order::query\(\).*->keys\(\)->all\(\),/);
});

test("new widget files", () => {
  const stats = widgetFile({ kind: "stats", namespace: "App\\Filament\\Widgets", name: "OrderStats", model: "App\\Models\\Order", label: "Orders" });
  assert.match(stats, /use App\\Models\\Order;\nuse Filament\\Widgets\\StatsOverviewWidget;\nuse Filament\\Widgets\\StatsOverviewWidget\\Stat;/);
  assert.match(stats, /return \[\n {12}Stat::make\('Orders', Order::query\(\)->count\(\)\),\n {8}\];/);
  const chart = widgetFile({ kind: "chart", namespace: "App\\Filament\\Widgets", name: "OrdersChart", model: "App\\Models\\Order", label: "Orders" });
  assert.match(chart, /return \[\n {12}'datasets' => \[\n {16}\[\n {20}'label' => 'Orders',/);
  const table = widgetFile({ kind: "table", namespace: "App\\Filament\\Widgets", name: "LatestOrders", model: "App\\Models\\Order", label: "Latest orders", columns: ["{{Filament\\Tables\\Columns\\TextColumn}}::make('number')"] });
  assert.match(table, /->columns\(\[\n {16}TextColumn::make\('number'\),\n {12}\]\);/);
  assert.match(table, /use Illuminate\\Database\\Eloquent\\Builder;/);
});

test("parted charts get a color per part", () => {
  const f = fixture("OrdersChartWidget");
  const c = readChartData(methodNamed(f.outline.classes[0], "getData")!.returns[0] as ArrayNode, f.text);
  const pie = applyEdits(f.text, partColorEdits(f.text, c, "pie"));
  assert.match(pie, /'borderColor' => '#22c55e',\n {20}'backgroundColor' => \['#f59e0b',/);
  assert.equal(partColorEdits(f.text, c, "line").length, 0);
});
