// Widgets for the widget designer: the numbers a stat shows and the series a chart draws, as queries the designer
// writes and reads back (a model, filters, and a count or sum), the stats of a stats overview, and a chart's data
// and type. Code the presets don't write shows as code. No editor imports, so Node tests it.
import { type ArrayNode, type Edit, findCall, indentCode, insertItem, type PNode, phpFile, phpString, removeCall, removeItem, replaceNode, setCall, textValue } from "./phpcode.ts";

// ---- Metrics ----

export type Agg = "count" | "sum" | "avg" | "min" | "max";
export type Op = "=" | "!=" | ">" | "<" | ">=" | "<=";
export type Literal = string | number | boolean | null;
export type Where = { column: string; op: Op; value: Literal };
/** A number from a model's records: how many, or the sum of a column, of those that match, from the last `days`. */
export type Metric = { model: string; agg: Agg; column: string | null; where: Where[]; days: number | null };

export const AGGS: [Agg, string][] = [
  ["count", "Count"],
  ["sum", "Sum of"],
  ["avg", "Average of"],
  ["min", "Lowest"],
  ["max", "Highest"],
];

/** Code with its layout taken out, to compare with what the designer writes. */
export function squash(code: string): string {
  return code
    .replace(/\s*->\s*/g, "->")
    .replace(/\s+/g, " ")
    .replace(/([([])\s+/g, "$1")
    .replace(/,?\s*([)\]])/g, "$1");
}

const LIT = String.raw`'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|true|false|null`;
function literal(code: string): Literal {
  if (code.startsWith("'")) return code.slice(1, -1).replace(/\\(['\\])/g, "$1");
  if (code === "true" || code === "false") return code === "true";
  if (code === "null") return null;
  return Number(code);
}
export const literalCode = (v: Literal) => (typeof v === "string" ? phpString(v) : v === null ? "null" : String(v));

/** The query of a metric: the model's records that match, without the number. */
export function queryCode(m: Metric): string {
  let code = `{{${m.model}}}::query()`;
  for (const w of m.where) {
    if (w.value === null) code += w.op === "!=" ? `->whereNotNull(${phpString(w.column)})` : `->whereNull(${phpString(w.column)})`;
    else code += w.op === "=" ? `->where(${phpString(w.column)}, ${literalCode(w.value)})` : `->where(${phpString(w.column)}, ${phpString(w.op)}, ${literalCode(w.value)})`;
  }
  if (m.days) code += `->where('created_at', '>=', now()->subDays(${m.days}))`;
  return code;
}

export const aggCode = (m: Pick<Metric, "agg" | "column">) => (m.agg === "count" || !m.column ? "->count()" : `->${m.agg}(${phpString(m.column)})`);
export const metricCode = (m: Metric) => queryCode(m) + aggCode(m);

/** Reads the query part of a metric, from `Model::query()` to where its filters end, and what comes after. */
function readQuery(code: string): { m: Omit<Metric, "agg" | "column">; rest: string } | null {
  const head = /^\\?([A-Za-z_][\w\\]*)::query\(\)/.exec(code);
  if (!head) return null;
  const m: Omit<Metric, "agg" | "column"> = { model: head[1], where: [], days: null };
  let rest = code.slice(head[0].length);
  for (;;) {
    let x: RegExpExecArray | null;
    if ((x = /^->where\('created_at', '>=', now\(\)->subDays\((\d+)\)\)/.exec(rest))) m.days = Number(x[1]);
    else if ((x = new RegExp(`^->where\\('(\\w+)', '(=|!=|<>|>|<|>=|<=)', (${LIT})\\)`).exec(rest))) m.where.push({ column: x[1], op: (x[2] === "<>" ? "!=" : x[2]) as Op, value: literal(x[3]) });
    else if ((x = new RegExp(`^->where\\('(\\w+)', (${LIT})\\)`).exec(rest))) m.where.push({ column: x[1], op: "=", value: literal(x[2]) });
    else if ((x = /^->where(Not)?Null\('(\w+)'\)/.exec(rest))) m.where.push({ column: x[2], op: x[1] ? "!=" : "=", value: null });
    else break;
    rest = rest.slice(x[0].length);
  }
  return { m, rest };
}

function readAgg(code: string): { agg: Agg; column: string | null } | null {
  const x = /^->(count)\(\)$|^->(sum|avg|min|max)\('(\w+)'\)$/.exec(code);
  return x ? (x[1] ? { agg: "count", column: null } : { agg: x[2] as Agg, column: x[3] }) : null;
}

/** Reads a metric the designer wrote, or null for other code. The model is as written; the caller resolves it. */
export function readMetric(code: string): Metric | null {
  const q = readQuery(squash(code));
  const agg = q && readAgg(q.rest);
  return q && agg ? { ...q.m, ...agg } : null;
}

// ---- A stat's value: a metric with a format ----

export type Format = { kind: "plain" } | { kind: "number" } | { kind: "abbreviate" } | { kind: "currency"; currency: string };
export const NUMBER = "Illuminate\\Support\\Number";

export function valueCode(m: Metric, f: Format): string {
  const code = metricCode(m);
  if (f.kind === "number") return `{{${NUMBER}}}::format(${code})`;
  if (f.kind === "abbreviate") return `{{${NUMBER}}}::abbreviate(${code})`;
  if (f.kind === "currency") return `{{${NUMBER}}}::currency(${code}, in: ${phpString(f.currency)})`;
  return code;
}

export function readValue(code: string): { metric: Metric; format: Format } | null {
  const c = squash(code);
  let x: RegExpExecArray | null;
  if ((x = /^\\?(?:[\w\\]*\\)?Number::(format|abbreviate)\((.*)\)$/.exec(c))) {
    const metric = readMetric(x[2]);
    return metric && { metric, format: { kind: x[1] === "format" ? "number" : "abbreviate" } };
  }
  if ((x = /^\\?(?:[\w\\]*\\)?Number::currency\((.*), in: '(\w+)'\)$/.exec(c))) {
    const metric = readMetric(x[1]);
    return metric && { metric, format: { kind: "currency", currency: x[2] } };
  }
  const metric = readMetric(c);
  return metric && { metric, format: { kind: "plain" } };
}

// ---- Trends ----

/** A stat's small chart: the metric for each of the last `days` days. */
export function trendCode(m: Metric, days = 7): string {
  return `collect(range(${days - 1}, 0))->map(fn (int $days) => ${queryCode({ ...m, days: null })}->whereDate('created_at', now()->subDays($days))${aggCode(m)})->all()`;
}

/** Whether code is a trend the designer wrote. */
export const isTrend = (code: string) => /^collect\(range\(\d+, 0\)\)->map\(fn \(int \$days\) => .*->whereDate\('created_at', now\(\)->subDays\(\$days\)\)/.test(squash(code));

// ---- Stats ----

export const STAT = "Filament\\Widgets\\StatsOverviewWidget\\Stat";

export type StatRead = {
  index: number;
  node: PNode;
  label: { text: string; translated: boolean } | null;
  value: PNode | null;
  description: { text: string; translated: boolean } | null;
  descriptionIcon: PNode | null;
  color: string | null;
  trend: "designed" | "code" | null;
};

/** The stats in `getStats()`'s array; one that isn't `Stat::make(…)` has no label. */
export function readStats(arr: ArrayNode, text: string): StatRead[] {
  return arr.items.map((item, index) => {
    const n = item.value;
    const base = n.kind === "chain" ? n.base : n;
    const ok = base.kind === "static" && /(^|\\)Stat$/.test(base.class) && base.method === "make";
    const call = (name: string) => (n.kind === "chain" ? findCall(n, name) : undefined);
    const chart = call("chart");
    return {
      index,
      node: n,
      label: ok ? (textValue(base.args.items[0]?.value) ?? null) : null,
      value: ok ? (base.args.items[1]?.value ?? null) : null,
      description: textValue(call("description")?.args.items[0]?.value) ?? null,
      descriptionIcon: call("descriptionIcon")?.args.items[0]?.value ?? null,
      color: textValue(call("color")?.args.items[0]?.value)?.text ?? null,
      trend: chart ? (isTrend(text.slice(chart.args.open + 1, chart.args.close)) ? "designed" : "code") : null,
    };
  });
}

export const statCode = (label: string, value: string, translated = false) => `{{${STAT}}}::make(${translated ? `__(${phpString(label)})` : phpString(label)}, ${value})`;

/** Sets or removes a call on a stat. */
export function statCallEdit(text: string, s: StatRead, name: string, args: string | null): Edit[] {
  const existing = s.node.kind === "chain" ? findCall(s.node, name) : undefined;
  if (args === null) return existing ? [removeCall(s.node, existing)] : [];
  return [setCall(text, s.node, name, args)];
}

/** Replaces a stat's label or value, the arguments of its `make()`. */
export function statArgEdit(text: string, s: StatRead, which: 0 | 1, code: string): Edit[] {
  const base = s.node.kind === "chain" ? s.node.base : s.node;
  const arg = base.kind === "static" ? base.args.items[which] : undefined;
  return arg ? [replaceNode(text, arg.value, code)] : [];
}

// ---- Charts ----

export const CHART_TYPES: [string, string][] = [
  ["line", "Line"],
  ["bar", "Bar"],
  ["pie", "Pie"],
  ["doughnut", "Doughnut"],
  ["polarArea", "Polar area"],
  ["radar", "Radar"],
];

export type Unit = "day" | "week" | "month";
export type Series = { kind: "time"; unit: Unit; count: number; metric: Metric } | { kind: "group"; column: string; metric: Metric };

const UNIT: Record<Unit, { sub: string; start: string; end: string; format: string }> = {
  day: { sub: "subDays", start: "startOfDay", end: "endOfDay", format: "M j" },
  week: { sub: "subWeeks", start: "startOfWeek", end: "endOfWeek", format: "M j" },
  month: { sub: "subMonths", start: "startOfMonth", end: "endOfMonth", format: "M Y" },
};

/** A series' `data` and `labels`: a value per day, week, or month, or per value of a column. */
export function seriesCode(s: Series): { data: string; labels: string } {
  const m = { ...s.metric, days: null };
  if (s.kind === "time") {
    const u = UNIT[s.unit];
    const period = `now()->${u.sub}($i)`;
    return {
      data: `collect(range(${s.count - 1}, 0))->map(fn (int $i) => ${queryCode(m)}->whereBetween('created_at', [${period}->${u.start}(), ${period}->${u.end}()])${aggCode(m)})->all()`,
      labels: `collect(range(${s.count - 1}, 0))->map(fn (int $i) => ${period}->format(${phpString(u.format)}))->all()`,
    };
  }
  const agg = m.agg === "count" || !m.column ? "count(*)" : `${m.agg}(${m.column})`;
  const grouped = `${queryCode(m)}->selectRaw(${phpString(`${s.column}, ${agg} as aggregate`)})->groupBy(${phpString(s.column)})->pluck('aggregate', ${phpString(s.column)})`;
  return { data: `${grouped}->values()->all()`, labels: `${grouped}->keys()->all()` };
}

/** Reads a series' `data` the designer wrote, or null. */
export function readSeries(code: string): Series | null {
  const c = squash(code);
  let x: RegExpExecArray | null;
  if ((x = /^collect\(range\((\d+), 0\)\)->map\(fn \(int \$i\) => (.*)->whereBetween\('created_at', \[now\(\)->(subDays|subWeeks|subMonths)\(\$i\)->\w+\(\), now\(\)->\3\(\$i\)->\w+\(\)\]\)(->\w+\([^)]*\))\)->all\(\)$/.exec(c))) {
    const q = readQuery(x[2]);
    const agg = readAgg(x[4]);
    if (!q || q.rest || !agg) return null;
    const unit = ({ subDays: "day", subWeeks: "week", subMonths: "month" } as const)[x[3] as "subDays"];
    return { kind: "time", unit, count: Number(x[1]) + 1, metric: { ...q.m, ...agg } };
  }
  if ((x = /^(.*)->selectRaw\('(\w+), (count\(\*\)|(sum|avg|min|max)\((\w+)\)) as aggregate'\)->groupBy\('\2'\)->pluck\('aggregate', '\2'\)->values\(\)->all\(\)$/.exec(c))) {
    const q = readQuery(x[1]);
    if (!q || q.rest) return null;
    return { kind: "group", column: x[2], metric: { ...q.m, agg: (x[4] as Agg) ?? "count", column: x[5] ?? null } };
  }
  return null;
}

export type ChartData = { arr: ArrayNode; ds: ArrayNode | null; label: { node: PNode; text: string } | null; data: PNode | null; labels: PNode | null; series: Series | null; datasets: number };

/** The first dataset of `getData()`'s array, with its label and data, and the chart's labels. */
export function readChartData(arr: ArrayNode, text: string): ChartData {
  const key = (a: ArrayNode, k: string) => a.items.find((i) => i.key?.kind === "string" && i.key.value === k)?.value ?? null;
  const datasets = key(arr, "datasets");
  const first = datasets?.kind === "array" ? datasets.items[0]?.value : undefined;
  const ds = first?.kind === "array" ? first : null;
  const label = ds ? key(ds, "label") : null;
  const data = ds ? key(ds, "data") : null;
  const t = textValue(label);
  return {
    arr,
    ds,
    label: label && t ? { node: label, text: t.text } : null,
    data,
    labels: key(arr, "labels"),
    series: data ? readSeries(text.slice(data.span[0], data.span[1])) : null,
    datasets: datasets?.kind === "array" ? datasets.items.length : 0,
  };
}

/** A whole `getData()` array for one series. */
export function chartDataCode(label: string, s: Series): string {
  const { data, labels } = seriesCode(s);
  return `[\n    'datasets' => [\n        [\n            'label' => ${phpString(label)},\n            'data' => ${data},\n        ],\n    ],\n    'labels' => ${labels},\n]`;
}

/** Edits that give a chart a series: its data and labels change in place, and other dataset keys stay. */
export function seriesEdits(text: string, c: ChartData, label: string, s: Series): Edit[] {
  if (!c.data || !c.labels) return [replaceNode(text, c.arr, chartDataCode(label, s))];
  const { data, labels } = seriesCode(s);
  return [replaceNode(text, c.data, data), replaceNode(text, c.labels, labels)];
}

// ---- New widgets ----

export type WidgetKind = "stats" | "chart" | "table";
export const WIDGET_KINDS: [WidgetKind, string, string][] = [
  ["stats", "Stats", "Numbers in cards, such as how many orders are open"],
  ["chart", "Chart", "A line, bar, or pie chart"],
  ["table", "Table", "A short list of records, such as the latest orders"],
];

/**
 * A new widget's file. With a model, it starts useful: a stat counting its records, a chart of new records per
 * month, or a table of the latest ones with `columns` (table column code).
 */
export function widgetFile(o: { kind: WidgetKind; namespace: string; name: string; model: string | null; label: string; columns?: string[] }): string {
  const count = o.model ? { model: o.model, agg: "count" as const, column: null, where: [], days: null } : null;
  const indent = (code: string, n: number) => indentCode(code, " ".repeat(n));
  let body: string;
  if (o.kind === "stats") {
    const stats = count ? `\n            ${indent(statCode(o.label, metricCode(count)), 12)},\n        ` : "\n            //\n        ";
    body = `class ${o.name} extends {{Filament\\Widgets\\StatsOverviewWidget}}
{
    protected function getStats(): array
    {
        return [${stats}];
    }
}`;
  } else if (o.kind === "chart") {
    const data = count ? chartDataCode(o.label, { kind: "time", unit: "month", count: 12, metric: count }) : "[\n    'datasets' => [],\n    'labels' => [],\n]";
    body = `class ${o.name} extends {{Filament\\Widgets\\ChartWidget}}
{
    protected ?string $heading = ${phpString(o.label)};

    protected function getData(): array
    {
        return ${indent(data, 8)};
    }

    protected function getType(): string
    {
        return 'line';
    }
}`;
  } else {
    const query = o.model ? `{{${o.model}}}::query()->latest()` : "{{Illuminate\\Database\\Eloquent\\Model}}::query()";
    const columns = (o.columns ?? []).map((c) => `                ${indent(c, 16)},`).join("\n");
    body = `class ${o.name} extends {{Filament\\Widgets\\TableWidget}}
{
    protected int | string | array $columnSpan = 'full';

    public function table({{Filament\\Tables\\Table}} $table): {{Filament\\Tables\\Table}}
    {
        return $table
            ->heading(${phpString(o.label)})
            ->query(fn (): {{Illuminate\\Database\\Eloquent\\Builder}} => ${query})
            ->defaultPaginationPageOption(5)
            ->columns([${columns ? `\n${columns}\n            ` : ""}]);
    }
}`;
  }
  return phpFile(o.namespace, body);
}

/** Chart types whose parts each need a color: Filament gives a dataset one color, so each part would look the same. */
export const PARTED = new Set(["pie", "doughnut", "polarArea"]);
export const PART_COLORS = "['#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']";

/** Gives the first dataset a color per part for a parted chart type, or takes the designer's colors off for others. */
export function partColorEdits(text: string, c: ChartData, type: string): Edit[] {
  if (!c.ds) return [];
  const index = c.ds.items.findIndex((i) => i.key?.kind === "string" && i.key.value === "backgroundColor");
  const item = c.ds.items[index];
  if (PARTED.has(type)) return item ? [] : [insertItem(text, c.ds, c.ds.items.length, `'backgroundColor' => ${PART_COLORS}`)];
  return item && squash(text.slice(item.value.span[0], item.value.span[1])) === PART_COLORS ? [removeItem(text, c.ds, index)] : [];
}
