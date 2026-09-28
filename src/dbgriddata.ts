// The results grid's pure parts: copy and export formats, sorting, and how the value viewer shows a value.
// Free of editor imports so Node can test it.
import { literal, quoteIdentifier } from "./dbconfig.ts";

export type Cell = string | null;
export type Format = "tsv" | "csv" | "json" | "sql" | "markdown";

export const FORMATS: { format: Format; label: string; extension: string }[] = [
  { format: "tsv", label: "TSV (with Header)", extension: "tsv" },
  { format: "csv", label: "CSV", extension: "csv" },
  { format: "json", label: "JSON", extension: "json" },
  { format: "sql", label: "SQL INSERT", extension: "sql" },
  { format: "markdown", label: "Markdown", extension: "md" },
];

/** Tab-separated values, as ⌘C copies cells: tabs and newlines inside a value become spaces, and NULL is empty. */
export const tsv = (rows: Cell[][]) => rows.map((r) => r.map((v) => (v ?? "").replace(/[\t\r\n]+/g, " ")).join("\t")).join("\n");

/** Rows in a format, with the column names. `table` and `driver` name and quote the table for SQL INSERT. */
export function formatRows(format: Format, columns: string[], rows: Cell[][], table = "results", driver = ""): string {
  switch (format) {
    case "tsv":
      return tsv([columns, ...rows]);
    case "csv": {
      // RFC 4180: quote a value with a comma, quote, or line break, and double its quotes. NULL is empty.
      const field = (v: Cell) => (v === null ? "" : /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      return [columns, ...rows].map((r) => r.map(field).join(",")).join("\r\n");
    }
    case "json":
      return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), null, 2);
    case "sql": {
      const id = (n: string) => quoteIdentifier(driver, n);
      return rows.map((r) => `INSERT INTO ${id(table)} (${columns.map(id).join(", ")}) VALUES (${r.map((v) => literal(driver, v)).join(", ")});`).join("\n");
    }
    case "markdown": {
      const cell = (v: Cell) => (v === null ? "NULL" : v.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>"));
      return [`| ${columns.map(cell).join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
    }
  }
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** Orders two cells as a sort does: NULL first, numbers by value, and other text by its characters and numbers. */
export function compareCells(a: Cell, b: Cell): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  if (NUMBER.test(a) && NUMBER.test(b)) return Number(a) - Number(b);
  return a.localeCompare(b, undefined, { numeric: true });
}

/** The row indexes in the order of a column, ascending or descending; a stable sort, so ties keep their order. */
export function sortOrder(rows: Cell[][], column: number, desc: boolean): number[] {
  const order = rows.map((_, i) => i);
  return order.sort((x, y) => (desc ? -1 : 1) * compareCells(rows[x][column], rows[y][column]) || x - y);
}

/** The bytes of a value: a binary cell's `\x` hex, as db.rs and PostgreSQL write them, or text as UTF-8. */
export function bytesOf(value: string): Uint8Array {
  if (/^\\x([0-9a-f]{2})*$/i.test(value)) return Uint8Array.from(value.slice(2).match(/../g) ?? [], (b) => parseInt(b, 16));
  return new TextEncoder().encode(value);
}

/** Bytes as xxd prints them: the offset, 16 bytes in hex, and those bytes as ASCII, with a dot for the rest. */
export function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let at = 0; at < bytes.length; at += 16) {
    const line = [...bytes.subarray(at, at + 16)];
    const hex = line.map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = line.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${at.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join("\n");
}

/** How the value viewer shows a value first: hex for a binary column, JSON for an object or array, or text. */
export function viewerMode(value: Cell, binary: boolean): "text" | "json" | "hex" {
  if (binary) return "hex";
  if (value && /^\s*[[{]/.test(value)) {
    try {
      JSON.parse(value);
      return "json";
    } catch {}
  }
  return "text";
}
