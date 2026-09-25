// The HTTP client's Laravel tools that don't touch the editor: feature tests from requests, entries in Laravel's
// log, and the app's address. Free of editor imports so Node can test it; httplaravel.ts is the interface.
import { phpValue, type Prepared } from "./httpfile.ts";

// ---- Feature tests ----

export type TestSpec = {
  request: Prepared;
  status: number;
  /** The response's content type and body, for assertJsonStructure. */
  contentType: string;
  body: string;
  /** What the test says it does, such as the request's name. */
  name: string;
  pest: boolean;
  /** The file the test goes in, so a name it already uses gets a number. */
  existing?: string;
};

const phpString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
/** Headers a Laravel test doesn't need: the test helpers set them, or they belong to a browser session. */
const SKIPPED = /^(accept|content-type|content-length|host|cookie|origin|referer|user-agent|x-xsrf-token|x-csrf-token)$/i;

/** The request's path and query, without the origin or a leading {{host}}. */
export const requestPath = (url: string) => "/" + url.replace(/^\{\{[^}]+\}\}/, "").replace(/^https?:\/\/[^/?#]+/, "").replace(/^\/+/, "").split("#")[0];

/**
 * The keys of a JSON response for assertJsonStructure, as a PHP array: nested objects to `depth` levels, and `*`
 * for a list of objects. Null when the response isn't an object or a list of objects.
 */
export function jsonStructure(value: unknown, indent = "", depth = 3): string | null {
  const next = indent + "    ";
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0;
  const list = (v: unknown) => (Array.isArray(v) && isObject(v[0]) ? v[0] : null);
  if (list(value)) {
    const inner = jsonStructure(list(value), next, depth);
    return inner ? `[\n${next}'*' => ${inner},\n${indent}]` : null;
  }
  if (!isObject(value)) return null;
  const entries = Object.entries(value).map(([k, v]) => {
    const inner = depth > 1 && (isObject(v) || list(v)) ? jsonStructure(v, next, depth - 1) : null;
    return `${next}${phpString(k)}${inner ? ` => ${inner}` : ""},`;
  });
  return `[\n${entries.join("\n")}\n${indent}]`;
}

/** A Pest test, or a PHPUnit test method, that sends the request and asserts the status and the JSON's shape. */
export function featureTest(s: TestSpec): string {
  const p = s.request;
  const base = s.pest ? "    " : "        ";
  const inner = base + "    ";
  const type = p.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  const accept = p.headers.find(([k]) => k.toLowerCase() === "accept")?.[1] ?? "";
  const json = /json/i.test(type) || /json/i.test(accept) || /json/i.test(s.contentType);
  const method = p.method.toLowerCase();
  const calls: string[] = [];
  let data: unknown;
  if (p.form) data = Object.fromEntries(p.form.filter((f) => !f.file).map((f) => [f.name, f.value ?? ""]));
  else if (p.body && /json/i.test(type)) {
    try {
      data = JSON.parse(p.body);
    } catch {
      data = undefined;
    }
  } else if (p.body && /x-www-form-urlencoded/i.test(type)) data = Object.fromEntries(new URLSearchParams(p.body));
  const headers: [string, string][] = [];
  for (const [k, v] of p.headers) {
    if (k.toLowerCase() === "authorization" && /^Bearer\s+/i.test(v)) calls.push(`withToken(${phpString(v.replace(/^Bearer\s+/i, ""))})`);
    else if (!SKIPPED.test(k)) headers.push([k, v]);
  }
  // Both are ordered calls on $this, so the array literals indent from the line they start on.
  const indentFor = () => (calls.length ? inner : base);
  if (headers.length) calls.push(`withHeaders(${phpValue(Object.fromEntries(headers), indentFor())})`);
  const args = [phpString(requestPath(p.url))];
  const hasData = data !== undefined && !(typeof data === "object" && data !== null && !Object.keys(data).length);
  if (hasData) args.push(phpValue(data, indentFor()));
  const helpers = ["get", "post", "put", "patch", "delete", "options"];
  calls.push(helpers.includes(method) ? `${method}${json ? "Json" : ""}(${args.join(", ")})` : `call(${[phpString(p.method), ...args].join(", ")})`);
  calls.push(`assertStatus(${s.status})`);
  if (/json/i.test(s.contentType)) {
    try {
      const structure = jsonStructure(JSON.parse(s.body), inner);
      if (structure) calls.push(`assertJsonStructure(${structure})`);
    } catch {
      // Not JSON after all.
    }
  }
  const [first, ...rest] = calls;
  const body = `${base}$this->${first}${rest.map((c) => `\n${inner}->${c}`).join("")};`;
  const taken = s.existing ?? "";
  if (s.pest) {
    let name = s.name.replace(/\s+/g, " ").trim() || `${p.method} ${requestPath(p.url)}`;
    for (let n = 2; taken.includes(`(${phpString(name)},`); n++) name = `${name.replace(/ \(\d+\)$/, "")} (${n})`;
    return `test(${phpString(name)}, function () {\n${body}\n});\n`;
  }
  const words = (s.name || `${p.method} ${requestPath(p.url)}`).replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().match(/[a-z0-9]+/g) ?? ["request"];
  let fn = `test_${words.join("_")}`;
  for (let n = 2; new RegExp(`function ${fn}\\s*\\(`).test(taken); n++) fn = `test_${words.join("_")}_${n}`;
  return `    public function ${fn}(): void\n    {\n${body}\n    }\n`;
}

/** A new test file for `test`: a Pest file, or a PHPUnit class named `className` in Tests\Feature. */
export const featureTestFile = (className: string, test: string, pest: boolean) =>
  pest ? `<?php\n\n${test}` : `<?php\n\nnamespace Tests\\Feature;\n\nuse Tests\\TestCase;\n\nclass ${className} extends TestCase\n{\n${test}}\n`;

/** An existing test file with `test` added, at the end for Pest or before the class's closing brace, and the test's first line. */
export function addTest(existing: string, test: string, pest: boolean): { text: string; line: number } {
  const lineOf = (text: string, at: number) => text.slice(0, at).split("\n").length;
  if (pest) {
    const head = existing.replace(/\s*$/, "\n\n");
    return { text: head + test, line: lineOf(head, head.length) };
  }
  const close = existing.lastIndexOf("}");
  if (close < 0) return addTest(existing, test, true);
  const head = existing.slice(0, close).replace(/\s*$/, "\n\n");
  return { text: `${head}${test}${existing.slice(close)}`, line: lineOf(head, head.length) };
}

/** A test file's name for a request path, from its first word that isn't `api` or a version: /api/v1/notes/5 gives NotesTest.php. */
export function testFileName(path: string) {
  const word = path
    .split(/[?#]/)[0]
    .split("/")
    .find((s) => s && !/^(api|v\d+)$/i.test(s) && !/^\d+$/.test(s) && !/[{}]/.test(s));
  const studly = (word ?? "http").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  return `${studly || "Http"}Test.php`;
}

// ---- Laravel's log ----

export type LogEntry = { time: string; env: string; level: string; message: string; detail: string };

/** Entries in a Laravel log (Monolog's line format). Text before the first entry, such as the end of a cut-off one, is left out. */
export function parseLaravelLog(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  let last: LogEntry | undefined;
  for (const line of text.split("\n")) {
    const m = line.match(/^\[(\d{4}-\d\d-\d\d[ T][^\]]*)\] ([\w-]+)\.([A-Z]+): ?(.*)$/);
    if (m) {
      // An exception's context starts on the entry's line; the empty [] contexts say nothing.
      const [, message, context = ""] = m[4].replace(/(\s+\[\])+\s*$/, "").match(/^(.*?)(?: (\{"exception":.*))?$/s)!;
      entries.push((last = { time: m[1], env: m[2], level: m[3].toLowerCase(), message, detail: context }));
    } else if (last) last.detail += (last.detail ? "\n" : "") + line;
  }
  for (const e of entries) e.detail = e.detail.replace(/\s+$/, "");
  return entries;
}

/** The PHP file and line references in text, such as a stack trace's `/app/Foo.php(12)` and `/app/Foo.php:12`. */
export function fileReferences(text: string): { file: string; line: number; index: number; length: number }[] {
  return [...text.matchAll(/(\/[^\s():"'\\]+\.php)(?::(\d+)|\((\d+)\))/g)].map((m) => ({ file: m[1], line: Number(m[2] ?? m[3]), index: m.index!, length: m[0].length }));
}

// ---- The app's address ----

export type AddressFacts = {
  root: string;
  env: Record<string, string>;
  /** The Docker Compose file's text, or null when there's none. */
  compose: string | null;
  /** Herd's or Valet's configuration, with its linked sites (name and folder) and secured domains. */
  valet: { tld: string; paths: string[]; links: [string, string][]; secured: string[]; app: string } | null;
  /** Ports PHP listens on, such as artisan serve's. */
  phpPorts: number[];
};
export type Address = { url: string; source: string };

/** Where the app might answer, best first: Sail, Herd or Valet, a PHP server, APP_URL, and artisan serve's default. */
export function appAddresses(f: AddressFacts): Address[] {
  const list: Address[] = [];
  if (f.compose !== null && (f.env.APP_PORT || /laravel\/sail|sail-\d/.test(f.compose))) {
    const port = f.env.APP_PORT && f.env.APP_PORT !== "80" ? `:${f.env.APP_PORT}` : "";
    list.push({ url: `http://localhost${port}`, source: `Sail${f.env.APP_PORT ? ` (APP_PORT ${f.env.APP_PORT})` : ""}` });
  }
  if (f.valet) {
    const { tld, app } = f.valet;
    const parent = f.root.slice(0, f.root.lastIndexOf("/"));
    const names = [...f.valet.links.filter(([, target]) => target.replace(/\/$/, "") === f.root).map(([name]) => name)];
    if (f.valet.paths.some((p) => p.replace(/\/$/, "") === parent)) names.push(f.root.slice(parent.length + 1).toLowerCase());
    for (const name of new Set(names)) {
      const domain = `${name}.${tld}`;
      list.push({ url: `${f.valet.secured.includes(domain) ? "https" : "http"}://${domain}`, source: app });
    }
  }
  for (const port of f.phpPorts) list.push({ url: `http://127.0.0.1:${port}`, source: `PHP listening on port ${port}` });
  if (f.env.APP_URL) list.push({ url: f.env.APP_URL.replace(/\/$/, ""), source: "APP_URL in .env" });
  list.push({ url: "http://localhost:8000", source: "artisan serve's default" });
  return list.filter((a, i) => list.findIndex((b) => b.url === a.url) === i);
}

/** Listening ports of PHP processes, from `lsof -Fcn` output: a `c` line names the command, `n` lines its addresses. */
export function phpPorts(lsof: string): number[] {
  const ports = new Set<number>();
  let php = false;
  for (const line of lsof.split("\n")) {
    if (line.startsWith("c")) php = /^php/i.test(line.slice(1));
    else if (line.startsWith("p")) php = false;
    else if (php && line.startsWith("n")) {
      const port = Number(line.match(/:(\d+)$/)?.[1]);
      if (port) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}
