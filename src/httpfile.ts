// Reads and writes .http files (PhpStorm's HTTP client format), builds curl arguments, reads curl's output, and
// converts requests to and from other forms. Free of editor imports so Node can test it.

export type Header = { name: string; value: string; enabled: boolean };
/** A script inline between {% and %}, or in a file. */
export type Script = { code?: string; file?: string };

export type HttpRequest = {
  /** The `# @name` tag, or else the ### title. Scripts and the tool window use it. */
  name: string;
  /** The text after ###. */
  title: string;
  /** 1-based line of the request line (METHOD URL). */
  line: number;
  /** 1-based lines the request's block covers, from its ### line to the line before the next one. */
  start: number;
  end: number;
  method: string;
  url: string;
  httpVersion: string;
  headers: Header[];
  body: string;
  /** Lines before the request line that aren't tags, variables, or scripts, such as comments. */
  comments: string[];
  /** `@name = value` lines in the block, before the request line. */
  vars: [string, string][];
  tags: Tags;
  preScript?: Script;
  handler?: Script;
  /** `>> path` saves the response body; `>>! path` overwrites the file instead of adding a number. */
  output?: { path: string; force: boolean };
  /** The URL as written over several lines, kept while the URL doesn't change. */
  urlLines?: string[];
  /** Comments among the headers, each with the number of headers before it. */
  headerComments?: [number, string][];
  /** Comments in or after the body, each with the number of body lines before it. */
  bodyComments?: [number, string][];
};

export type Tags = {
  name?: string;
  noRedirect?: boolean;
  noCookieJar?: boolean;
  noLog?: boolean;
  /** Accept any TLS certificate. Not a PhpStorm tag; PhpStorm reads it as a comment. */
  insecure?: boolean;
  /** Seconds. */
  timeout?: number;
  connectionTimeout?: number;
  /** Send Laravel's XSRF token and a browser's Origin, fetching the token from this path (or the defaults) first. Not a PhpStorm tag. */
  laravelSession?: string | true;
  /** Send through this proxy, as curl's -x takes it. Not a PhpStorm tag; an environment's "$proxy" value applies too. */
  proxy?: string;
  /** A client certificate and its key for mutual TLS, relative to the .http file. Not PhpStorm tags. */
  clientCert?: string;
  clientKey?: string;
  /** Force a protocol version (# @http2 or # @http1). Not PhpStorm tags; PhpStorm reads `HTTP/2` on the request line, which works too. */
  http?: "2" | "1.1";
  /** Milliseconds the response may take before it counts as too slow. Not a PhpStorm tag. */
  budget?: number;
};

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT", "GRAPHQL", "WEBSOCKET", "GRPC"];
const REQUEST_LINE = new RegExp(`^(${METHODS.join("|")})\\s+(\\S+)(?:\\s+(HTTP\\/[\\d.]+))?\\s*$`, "i");
const VAR_LINE = /^@([\w.-]+)\s*=\s*(.*?)\s*$/;
const TAG_LINE = /^\s*(?:#|\/\/)\s*@([\w-]+)(?:\s+(.*?))?\s*$/;
const isComment = (line: string) => /^\s*(#|\/\/)/.test(line);
const seconds = (text = "") => {
  const m = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/);
  return m ? Number(m[1]) * (m[2] === "ms" ? 0.001 : m[2] === "m" ? 60 : 1) : undefined;
};

/** Removes the indentation every non-blank line shares. */
const dedent = (text: string) => {
  const lines = text.replace(/^\n+|\s+$/g, "").split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
  return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
};

/** Reads a script that starts on `lines[i]` after its prefix (`<` or `>`). Returns it and the index after it. */
function readScript(lines: string[], i: number, prefix: string): [Script, number] {
  const first = lines[i].trim().slice(prefix.length).trim();
  if (!first.startsWith("{%")) return [{ file: first }, i + 1];
  const code: string[] = [];
  let rest = first.slice(2);
  for (;;) {
    const close = rest.indexOf("%}");
    if (close >= 0) {
      code.push(rest.slice(0, close));
      return [{ code: dedent(code.join("\n")) }, i + 1];
    }
    code.push(rest);
    if (++i >= lines.length) return [{ code: dedent(code.join("\n")) }, i];
    rest = lines[i];
  }
}

/** The requests in a file, and its variables. Requests are separated by lines starting with ###, which may name them. */
export function parseHttpFile(text: string): HttpRequest[] {
  return parseHttp(text).requests;
}

export function parseHttp(text: string): { requests: HttpRequest[]; vars: Record<string, string> } {
  const lines = text.split(/\r?\n/);
  const requests: HttpRequest[] = [];
  const vars: Record<string, string> = {};
  const block = (from: number, to: number, title: string, separator: boolean) => {
    const comments: string[] = [];
    const blockVars: [string, string][] = [];
    const tags: Tags = {};
    let preScript: Script | undefined;
    let i = from;
    let m: RegExpMatchArray | null;
    for (; i < to; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      if ((m = line.match(VAR_LINE))) {
        blockVars.push([m[1], m[2]]);
        vars[m[1]] = m[2];
      } else if ((m = line.match(TAG_LINE))) {
        const [, tag, value] = m;
        if (tag === "name" && value) tags.name = value;
        else if (tag === "no-redirect") tags.noRedirect = true;
        else if (tag === "no-cookie-jar") tags.noCookieJar = true;
        else if (tag === "no-log") tags.noLog = true;
        else if (tag === "insecure") tags.insecure = true;
        else if (tag === "timeout") tags.timeout = seconds(value);
        else if (tag === "connection-timeout") tags.connectionTimeout = seconds(value);
        else if (tag === "laravel-session") tags.laravelSession = value || true;
        else if (tag === "proxy" && value) tags.proxy = value;
        else if (tag === "client-cert" && value) tags.clientCert = value;
        else if (tag === "client-key" && value) tags.clientKey = value;
        else if (tag === "http2") tags.http = "2";
        else if (tag === "http1") tags.http = "1.1";
        else if (tag === "budget") tags.budget = /^\d+(\.\d+)?$/.test(value ?? "") ? Number(value) : (seconds(value) ?? NaN) * 1000 || undefined;
        else comments.push(line);
      } else if (isComment(line)) comments.push(line);
      else if (/^<\s*(\{%|\S)/.test(line.trim()) && !REQUEST_LINE.test(line.trim())) ([preScript, i] = readScript(lines, i, "<")), i--;
      else break;
    }
    if (i >= to) return;
    const first = lines[i].trim();
    const rl = first.match(REQUEST_LINE);
    const request: HttpRequest = {
      name: tags.name ?? title,
      title,
      line: i + 1,
      start: separator ? from : from + 1,
      end: to,
      method: rl ? rl[1].toUpperCase() : "GET",
      url: rl ? rl[2] : first.split(/\s+/)[0],
      httpVersion: rl?.[3] ?? "",
      headers: [],
      body: "",
      comments,
      vars: blockVars,
      tags,
      preScript,
    };
    const urlStart = i;
    i++;
    // Indented lines continue the URL, such as one query parameter per line.
    while (i < to && /^\s+[?&/]/.test(lines[i])) request.url += lines[i++].trim();
    if (i - urlStart > 1) request.urlLines = lines.slice(urlStart, i);
    const headerComments: [number, string][] = [];
    // A WebSocket request's first === line ends its headers, even without a blank line.
    for (; i < to && lines[i].trim() && !lines[i].startsWith("==="); i++) {
      const line = lines[i];
      // A commented-out header is a header you turned off.
      const off = line.match(/^\s*#\s*([\w-]+)\s*:\s?(.*)$/);
      if (off && !TAG_LINE.test(line)) request.headers.push({ name: off[1], value: off[2].trim(), enabled: false });
      else if (isComment(line)) headerComments.push([request.headers.length, line]);
      else if (line.indexOf(":") > 0) request.headers.push({ name: line.slice(0, line.indexOf(":")).trim(), value: line.slice(line.indexOf(":") + 1).trim(), enabled: true });
    }
    if (headerComments.length) request.headerComments = headerComments;
    const body: string[] = [];
    const bodyComments: [number, string][] = [];
    for (; i < to; i++) {
      const line = lines[i];
      if ((m = line.match(/^>>(!)?\s+(\S.*?)\s*$/))) request.output = { path: m[2], force: !!m[1] };
      else if (/^>\s*(\{%|\S)/.test(line)) ([request.handler, i] = readScript(lines, i, ">")), i--;
      else if (/^<>\s/.test(line)) continue; // PhpStorm's links to saved responses.
      else if (isComment(line)) bodyComments.push([body.length, line]);
      else if (!request.handler && !request.output) body.push(line);
    }
    // Positions count from the body's first line, after the blank lines that trimming removes.
    const leading = body.findIndex((l) => l.trim());
    const kept = leading < 0 ? 0 : body.slice(leading).join("\n").trimEnd().split("\n").length;
    if (bodyComments.length) request.bodyComments = bodyComments.map(([n, l]) => [Math.min(Math.max(0, n - Math.max(0, leading)), kept), l]);
    request.body = body.join("\n").trim();
    requests.push(request);
  };
  let from = 0;
  let title = "";
  let separator = false;
  lines.forEach((line, i) => {
    if (!line.startsWith("###")) return;
    block(from + (separator ? 1 : 0), i, title, separator);
    title = line.replace(/^###\s*/, "").trim();
    from = i;
    separator = true;
  });
  block(from + (separator ? 1 : 0), lines.length, title, separator);
  return { requests, vars };
}

const scriptLines = (prefix: string, s: Script) => (s.file ? [`${prefix} ${s.file}`] : [`${prefix} {%`, ...(s.code ?? "").split("\n").map((l) => (l ? `    ${l}` : l)), "%}"]);

/** The request line, and the URL's continuation lines when it was written over several and its layout still fits. */
function requestLines(r: HttpRequest): string[] {
  const version = r.httpVersion ? ` ${r.httpVersion}` : "";
  if (!r.urlLines || version) return [`${r.method} ${r.url}${version}`];
  const [first, ...rest] = r.urlLines;
  const written = first.trim().split(/\s+/)[1] + rest.map((l) => l.trim()).join("");
  if (written === r.url && first.trim().split(/\s+/)[0].toUpperCase() === r.method) return r.urlLines;
  // The URL changed: keep one query parameter per line, as it was.
  const indent = rest[0]?.match(/^\s*/)![0] || "    ";
  const q = r.url.indexOf("?");
  if (q < 0) return [`${r.method} ${r.url}`];
  const params = r.url.slice(q + 1).split("&").filter(Boolean);
  return [`${r.method} ${r.url.slice(0, q)}`, ...params.map((p, i) => `${indent}${i ? "&" : "?"}${p}`)];
}

/** A request's block as text, starting with its ### line. The inverse of parsing: comments stay near where they were. */
export function formatRequest(r: HttpRequest): string {
  const out = [`###${r.title ? ` ${r.title}` : ""}`, ...r.comments, ...r.vars.map(([k, v]) => `@${k} = ${v}`)];
  const t = r.tags;
  if (t.name && t.name !== r.title) out.push(`# @name ${t.name}`);
  if (t.noRedirect) out.push("# @no-redirect");
  if (t.noCookieJar) out.push("# @no-cookie-jar");
  if (t.noLog) out.push("# @no-log");
  if (t.insecure) out.push("# @insecure");
  if (t.timeout !== undefined) out.push(`# @timeout ${t.timeout}`);
  if (t.connectionTimeout !== undefined) out.push(`# @connection-timeout ${t.connectionTimeout}`);
  if (t.laravelSession) out.push(`# @laravel-session${typeof t.laravelSession === "string" ? ` ${t.laravelSession}` : ""}`);
  if (t.proxy) out.push(`# @proxy ${t.proxy}`);
  if (t.clientCert) out.push(`# @client-cert ${t.clientCert}`);
  if (t.clientKey) out.push(`# @client-key ${t.clientKey}`);
  if (t.http) out.push(t.http === "2" ? "# @http2" : "# @http1");
  if (t.budget !== undefined) out.push(`# @budget ${t.budget}`);
  if (r.preScript) out.push(...scriptLines("<", r.preScript));
  out.push(...requestLines(r));
  const headerComments = [...(r.headerComments ?? [])];
  r.headers.forEach((h, i) => {
    while (headerComments.length && headerComments[0][0] <= i) out.push(headerComments.shift()![1]);
    out.push(`${h.enabled ? "" : "# "}${h.name}: ${h.value}`);
  });
  out.push(...headerComments.map(([, line]) => line));
  const body = r.body ? r.body.split("\n") : [];
  const bodyComments = [...(r.bodyComments ?? [])];
  if (body.length || bodyComments.length) {
    out.push("");
    body.forEach((line, i) => {
      while (bodyComments.length && bodyComments[0][0] <= i) out.push(bodyComments.shift()![1]);
      out.push(line);
    });
    out.push(...bodyComments.map(([, line]) => line));
  }
  if (r.handler) out.push("", ...scriptLines(">", r.handler));
  if (r.output) out.push(`>>${r.output.force ? "!" : ""} ${r.output.path}`);
  return out.join("\n") + "\n";
}

/** A new request with defaults, to add to a file. */
export const newRequest = (fields: Partial<HttpRequest> = {}): HttpRequest => ({
  name: "",
  title: "",
  line: 0,
  start: 0,
  end: 0,
  method: "GET",
  url: "",
  httpVersion: "",
  headers: [],
  body: "",
  comments: [],
  vars: [],
  tags: {},
  ...fields,
});

export const header = (r: { headers: Header[] }, name: string) => r.headers.find((h) => h.enabled && h.name.toLowerCase() === name.toLowerCase())?.value;

// ---- Variables ----

const VAR = /\{\{\s*([^{}]+?)\s*\}\}/g;
const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];
const chars = (set: string, n: number) => Array.from({ length: Math.max(0, n) }, () => pick([...set])).join("");
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const between = (from: number, to: number) => from + Math.random() * (to - from);

/** Values that change on each use, such as {{$uuid}}, as PhpStorm names them. Undefined for other names. */
export function dynamicValue(name: string, dotenv: Record<string, string> = {}): string | undefined {
  const m = name.match(/^\$([\w.]+)(?:\((.*)\))?$/);
  if (!m) return undefined;
  const args = (m[2] ?? "").split(",").map((a) => Number(a.trim()));
  const [a, b] = [Number.isFinite(args[0]) ? args[0] : 0, Number.isFinite(args[1]) ? args[1] : 1000];
  switch (m[1]) {
    case "uuid":
    case "random.uuid":
      return crypto.randomUUID();
    case "timestamp":
      return String(Math.floor(Date.now() / 1000));
    case "isoTimestamp":
      return new Date().toISOString();
    case "randomInt":
      return String(Math.floor(Math.random() * 1001));
    case "random.integer":
      return String(Math.floor(between(a, b)));
    case "random.float":
      return String(between(a, b));
    case "random.alphabetic":
      return chars(LOWER + LOWER.toUpperCase(), args[0] || 10);
    case "random.alphanumeric":
      return chars(LOWER + LOWER.toUpperCase() + "0123456789", args[0] || 10);
    case "random.hexadecimal":
      return chars("0123456789abcdef", args[0] || 10);
    case "random.numeric":
      return chars("0123456789", args[0] || 10);
    case "random.email":
      return `${chars(LOWER, 8)}@example.com`;
    case "random.bool":
      return String(Math.random() < 0.5);
  }
  if (m[1].startsWith("dotenv.")) return dotenv[m[1].slice(7)];
  return undefined;
}

export type Lookup = (name: string) => string | undefined;

/** Looks names up in scopes, first match first, then as dynamic values. */
export const lookupIn =
  (scopes: Record<string, string>[], dotenv: Record<string, string> = {}): Lookup =>
  (name) => {
    for (const s of scopes) if (Object.hasOwn(s, name)) return s[name];
    return dynamicValue(name, dotenv);
  };

/** Replaces {{name}} with its value, including values that name other variables. Unknown names stay as they are. */
export function resolve(text: string, lookup: Lookup): string {
  for (let pass = 0; pass < 10; pass++) {
    const next = text.replace(VAR, (all, name) => lookup(name) ?? all);
    if (next === text) break;
    text = next;
  }
  return text;
}

/** Replaces {{name}} with the environment's value. Unknown names stay as they are. */
export const substitute = (text: string, vars: Record<string, string>) => resolve(text, lookupIn([vars]));

/** The {{names}} in text that nothing defines. */
export const unresolved = (text: string, lookup: Lookup) => [...new Set([...resolve(text, lookup).matchAll(VAR)].map((m) => m[1]))];

/** Every {{name}} in text, with its offset. */
export const variablesIn = (text: string) => [...text.matchAll(VAR)].map((m) => ({ name: m[1], index: m.index!, length: m[0].length }));

// ---- Sending with curl ----

export type FormPart = { name: string; value?: string; file?: string; filename?: string; type?: string };

/** A request with its variables replaced and files found, ready for curl. */
export type Prepared = {
  method: string;
  url: string;
  headers: [string, string][];
  body?: string;
  /** Send this file as the body. */
  bodyFile?: string;
  /** multipart/form-data parts, which curl encodes with its own boundary. */
  form?: FormPart[];
  followRedirects: boolean;
  timeout: number;
  connectTimeout?: number;
  insecure: boolean;
  laravelSession?: string | true;
  proxy?: string;
  /** Absolute paths. */
  clientCert?: string;
  clientKey?: string;
  http?: "2" | "1.1";
  /** Milliseconds. */
  budget?: number;
};

/** Whether a response that took `seconds` went over the request's @budget. */
export const overBudget = (p: Prepared, seconds: number | undefined) => p.budget !== undefined && seconds !== undefined && seconds * 1000 > p.budget;

const absolute = (dir: string, path: string) => (path.startsWith("/") ? path : `${dir}/${path.replace(/^\.\//, "")}`);

/** The parts of a multipart/form-data body. A part whose content is a `< path` line sends that file. */
export function multipartParts(body: string, boundary: string, dir: string): FormPart[] {
  const parts: FormPart[] = [];
  for (const chunk of body.split(new RegExp(`^--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?\\s*$`, "m")).slice(1)) {
    const text = chunk.replace(/^\r?\n/, "");
    const blank = text.search(/\r?\n\r?\n/);
    if (blank < 0 && !text.trim()) continue;
    const head = blank >= 0 ? text.slice(0, blank) : text;
    const content = blank >= 0 ? text.slice(blank).replace(/^\r?\n\r?\n/, "").replace(/\r?\n$/, "") : "";
    const disposition = head.match(/Content-Disposition:[^\n]*/i)?.[0] ?? "";
    const name = disposition.match(/\bname="([^"]*)"/)?.[1];
    if (name === undefined) continue;
    const filename = disposition.match(/\bfilename="([^"]*)"/)?.[1];
    const type = head.match(/Content-Type:\s*(.+)/i)?.[1].trim();
    const file = content.trim().match(/^<\s+(.+)$/)?.[1];
    parts.push({ name, ...(file ? { file: absolute(dir, file) } : { value: content }), ...(filename ? { filename } : {}), ...(type ? { type } : {}) });
  }
  return parts;
}

/** PhpStorm lets you write `Authorization: Basic user password`, and encodes it. */
const basicAuth = (name: string, value: string) => {
  const m = name.toLowerCase() === "authorization" && value.match(/^Basic\s+(\S+)\s+(\S+)$/i);
  return m ? `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${m[1]}:${m[2]}`)))}` : value;
};

/**
 * Replaces variables and finds files relative to `dir`, the .http file's folder. `read` loads a file whose
 * variables are replaced too (`<@ path`); a plain `< path` body is sent as it is.
 */
export async function prepare(r: HttpRequest, lookup: Lookup, dir: string, read: (path: string) => Promise<string>): Promise<Prepared> {
  const sub = (t: string) => resolve(t, lookup);
  const headers = r.headers.filter((h) => h.enabled).map((h): [string, string] => [h.name, basicAuth(h.name, sub(h.value))]);
  const p: Prepared = {
    method: r.method,
    url: sub(r.url).replace(/ /g, "%20"),
    headers,
    followRedirects: !r.tags.noRedirect,
    timeout: r.tags.timeout ?? 60,
    connectTimeout: r.tags.connectionTimeout,
    insecure: !!r.tags.insecure,
    ...(r.tags.laravelSession ? { laravelSession: r.tags.laravelSession } : {}),
  };
  // A $ name can't clash with a variable of your own, and PhpStorm reads it as one it doesn't use.
  const proxy = r.tags.proxy ? sub(r.tags.proxy) : lookup("$proxy");
  if (proxy) p.proxy = proxy;
  if (r.tags.clientCert) p.clientCert = absolute(dir, sub(r.tags.clientCert));
  if (r.tags.clientKey) p.clientKey = absolute(dir, sub(r.tags.clientKey));
  // HTTP/1.1 on the request line is PhpStorm's default spelling rather than a choice, so only HTTP/2 counts.
  const version = r.tags.http ?? (/^HTTP\/2/i.test(r.httpVersion) ? "2" : undefined);
  if (version) p.http = version;
  if (r.tags.budget !== undefined) p.budget = r.tags.budget;
  if (r.method === "GRAPHQL") {
    // Sent as a POST with the query, and the variables when there are some, as JSON.
    const { query, variables } = graphqlParts(sub(r.body));
    let vars: unknown;
    try {
      vars = variables ? JSON.parse(variables) : undefined;
    } catch {
      vars = undefined;
    }
    p.method = "POST";
    p.headers = [...headers.filter(([k]) => k.toLowerCase() !== "content-type"), ["Content-Type", "application/json"]];
    p.body = JSON.stringify(vars === undefined ? { query } : { query, variables: vars });
    return p;
  }
  const body = r.body.trim();
  const fileBody = body.match(/^<(@)?\s+(\S.*)$/);
  const type = headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  const boundary = type.match(/multipart\/form-data;.*boundary="?([^";]+)"?/i)?.[1];
  if (fileBody && !fileBody[2].includes("\n")) {
    const path = absolute(dir, sub(fileBody[2]));
    if (fileBody[1]) p.body = sub(await read(path));
    else p.bodyFile = path;
  } else if (boundary) {
    p.form = multipartParts(sub(r.body), boundary, dir);
    // curl writes its own boundary into the header.
    p.headers = headers.filter(([k]) => k.toLowerCase() !== "content-type");
  } else if (body) p.body = sub(r.body);
  return p;
}

/** A GraphQL body: the query, then optionally a JSON object of variables after a blank line, as PhpStorm writes it. */
export function graphqlParts(body: string): { query: string; variables: string } {
  const chunks = body.split(/\n\s*\n/);
  const last = chunks.at(-1)?.trim() ?? "";
  if (chunks.length > 1 && last.startsWith("{") && last.endsWith("}") && !/^\{\s*\w+\s*[({]/.test(last)) return { query: chunks.slice(0, -1).join("\n\n").trim(), variables: last };
  return { query: body.trim(), variables: "" };
}

/** A WEBSOCKET body's messages, separated by `===` lines. `=== wait-for-server` waits for a message before the next. */
export function websocketMessages(body: string): { text: string; waitForServer: boolean }[] {
  const messages: { text: string; waitForServer: boolean }[] = [];
  let current: string[] = [];
  let wait = false;
  const flush = () => {
    const text = current.join("\n").trim();
    if (text) messages.push({ text, waitForServer: wait });
    current = [];
  };
  for (const line of body.split("\n")) {
    const m = line.match(/^===\s*(wait-for-server)?\s*$/);
    if (m) {
      flush();
      wait = !!m[1];
    } else current.push(line);
  }
  flush();
  return messages;
}

/** curl options for the proxy, client certificate, and protocol version, which every way of sending uses. */
const connectionArgs = (p: Prepared) => [
  ...(p.proxy ? ["-x", p.proxy] : []),
  ...(p.clientCert ? ["--cert", p.clientCert] : []),
  ...(p.clientKey ? ["--key", p.clientKey] : []),
  // Without these, curl asks for HTTP/2 over HTTPS and uses HTTP/1.1 otherwise.
  ...(p.http ? [p.http === "2" ? "--http2" : "--http1.1"] : []),
];

/** Marks the end of the headers curl writes to stdout, before its --write-out JSON. */
export const INFO_MARKER = "\n__HTTP_INFO__";

/**
 * curl arguments that save the response headers and body to files and print timing as JSON. A text body goes
 * to stdin, so it's returned as `input`.
 */
export function curlArgs(p: Prepared, files: { headers: string; body: string; cookies?: string }): { args: string[]; input: string | null } {
  // -g: brackets and braces in a URL, such as ?filter[status]=open, are literal rather than curl's globs.
  // --stderr -: curl's own errors, such as a malformed URL, come before the JSON on stdout.
  const args = ["-sS", "--max-time", String(p.timeout), "-D", files.headers, "-o", files.body, "-w", `${INFO_MARKER}%{json}`, "-g", "--stderr", "-"];
  if (p.method === "HEAD") args.push("--head");
  else args.push("-X", p.method);
  if (p.followRedirects) args.push("-L", "--max-redirs", "20");
  if (p.connectTimeout) args.push("--connect-timeout", String(p.connectTimeout));
  if (p.insecure) args.push("-k");
  args.push(...connectionArgs(p));
  if (files.cookies) args.push("-b", files.cookies, "-c", files.cookies);
  // Without an Accept-Encoding header of your own, curl asks for compressed bodies and decompresses them.
  if (!p.headers.some(([k]) => k.toLowerCase() === "accept-encoding")) args.push("--compressed");
  for (const [k, v] of p.headers) args.push("-H", v ? `${k}: ${v}` : `${k};`);
  for (const f of p.form ?? []) {
    // -F reads @ and < in values as files, so text goes through --form-string.
    if (f.file) args.push("-F", `${f.name}=@"${f.file}"${f.filename ? `;filename="${f.filename}"` : ""}${f.type ? `;type=${f.type}` : ""}`);
    else args.push("--form-string", `${f.name}=${f.value ?? ""}`);
  }
  if (p.bodyFile) args.push("--data-binary", `@${p.bodyFile}`);
  else if (p.body !== undefined) args.push("--data-binary", "@-");
  args.push("--", p.url);
  return { args, input: p.bodyFile || p.form ? null : (p.body ?? null) };
}

export type ResponseHead = { status: number; statusText: string; httpVersion: string; headers: [string, string][] };

/** Reads the header blocks curl's -D writes: one per response, such as each redirect. Interim 1xx responses are left out. */
export function parseHeaderDump(text: string): ResponseHead[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).filter(Boolean))
    .filter((lines) => lines.length && /^HTTP\//.test(lines[0]))
    .map(([statusLine, ...rest]) => {
      const m = statusLine.match(/^HTTP\/([\d.]+)\s+(\d+)\s*(.*)$/);
      return {
        status: m ? Number(m[2]) : 0,
        statusText: m?.[3].trim() ?? "",
        httpVersion: m?.[1] ?? "",
        headers: rest.filter((l) => l.includes(":")).map((l): [string, string] => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]),
      };
    })
    .filter((h) => h.status < 100 || h.status >= 200);
}

export const STATUS_TEXT: Record<number, string> = {
  200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 301: "Moved Permanently", 302: "Found", 303: "See Other",
  304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized",
  403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 419: "Page Expired", 422: "Unprocessable Content",
  429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
};

export type Cookie = { name: string; value: string; attributes: string };

export function parseSetCookie(value: string): Cookie {
  const [pair, ...attributes] = value.split(";");
  const eq = pair.indexOf("=");
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), attributes: attributes.map((a) => a.trim()).join("; ") };
}

// ---- cURL commands ----

/** Splits a shell command into words, as bash would for quotes, $'…' strings, and backslash line continuations. */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  const s = command.replace(/\\\r?\n/g, " ");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/\s/.test(c)) {
      if (word !== null) words.push(word), (word = null);
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      word = (word ?? "") + s.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? s.length : end;
    } else if (c === "$" && s[i + 1] === "'") {
      let out = "";
      for (i += 2; i < s.length && s[i] !== "'"; i++) {
        if (s[i] !== "\\") out += s[i];
        else {
          const n = s[++i];
          const esc: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', e: "\x1b", "0": "\0" };
          if (n === "x" || n === "u") {
            const hex = s.slice(i + 1).match(n === "x" ? /^[0-9a-fA-F]{1,2}/ : /^[0-9a-fA-F]{1,4}/)?.[0] ?? "";
            out += String.fromCharCode(parseInt(hex || "0", 16));
            i += hex.length;
          } else out += esc[n] ?? n;
        }
      }
      word = (word ?? "") + out;
    } else if (c === '"') {
      let out = "";
      for (i++; i < s.length && s[i] !== '"'; i++) out += s[i] === "\\" && /["\\$`]/.test(s[i + 1]) ? s[++i] : s[i];
      word = (word ?? "") + out;
    } else if (c === "\\") word = (word ?? "") + (s[++i] ?? "");
    else word = (word ?? "") + c;
  }
  if (word !== null) words.push(word);
  return words;
}

/** A request from a curl command, such as a browser's Copy as cURL. Options it doesn't know are skipped. */
export function fromCurl(command: string): HttpRequest {
  const words = shellWords(command.trim());
  if (words[0] === "curl") words.shift();
  const r = newRequest();
  const data: string[] = [];
  const form: string[] = [];
  let method = "";
  let get = false;
  const takesValue = new Set(["-o", "--output", "-w", "--write-out", "--max-time", "-m", "--connect-timeout", "--retry", "-x", "--proxy", "--cert", "--key", "--cacert", "-r", "--range", "--resolve", "-c", "--cookie-jar"]);
  const add = (name: string, value: string) => r.headers.push({ name, value, enabled: true });
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    let inline: string | undefined;
    if (w.startsWith("--") && w.includes("=")) [w, inline] = [w.slice(0, w.indexOf("=")), w.slice(w.indexOf("=") + 1)];
    else if (/^-[XHdFuAeb]./.test(w)) [w, inline] = [w.slice(0, 2), w.slice(2)];
    const value = () => inline ?? words[++i] ?? "";
    switch (w) {
      case "-X":
      case "--request":
        method = value().toUpperCase();
        break;
      case "-H":
      case "--header": {
        const h = value();
        const colon = h.indexOf(":");
        if (colon > 0) add(h.slice(0, colon).trim(), h.slice(colon + 1).trim());
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii":
      case "--json":
        if (w === "--json" && !header(r, "content-type")) add("Content-Type", "application/json");
        data.push(value());
        break;
      case "--data-urlencode": {
        const v = value();
        const eq = v.indexOf("=");
        data.push(eq >= 0 ? `${v.slice(0, eq)}=${encodeURIComponent(v.slice(eq + 1))}` : encodeURIComponent(v));
        break;
      }
      case "-F":
      case "--form":
      case "--form-string":
        form.push(value());
        break;
      case "-u":
      case "--user":
        add("Authorization", `Basic ${btoa(value())}`);
        break;
      case "-A":
      case "--user-agent":
        add("User-Agent", value());
        break;
      case "-e":
      case "--referer":
        add("Referer", value());
        break;
      case "-b":
      case "--cookie":
        add("Cookie", value());
        break;
      case "-I":
      case "--head":
        method = "HEAD";
        break;
      case "-G":
      case "--get":
        get = true;
        break;
      case "-k":
      case "--insecure":
        r.tags.insecure = true;
        break;
      case "--url":
        r.url = value();
        break;
      default:
        if (takesValue.has(w)) value();
        else if (!w.startsWith("-") && !r.url) r.url = w;
    }
  }
  if (get && data.length) {
    r.url += (r.url.includes("?") ? "&" : "?") + data.join("&");
    data.length = 0;
  }
  if (form.length) {
    const boundary = "WebAppBoundary";
    r.headers = r.headers.filter((h) => h.name.toLowerCase() !== "content-type");
    add("Content-Type", `multipart/form-data; boundary=${boundary}`);
    r.body =
      form
        .map((f) => {
          const eq = f.indexOf("=");
          const [name, v] = [f.slice(0, eq), f.slice(eq + 1)];
          const file = v.match(/^@([^;]+)/)?.[1];
          const disposition = `Content-Disposition: form-data; name="${name}"${file ? `; filename="${file.split("/").pop()}"` : ""}`;
          return `--${boundary}\n${disposition}\n\n${file ? `< ${file}` : v}`;
        })
        .join("\n") + `\n--${boundary}--`;
  } else if (data.length) {
    r.body = data.join("&");
    if (!header(r, "content-type")) add("Content-Type", r.body.trim().startsWith("{") ? "application/json" : "application/x-www-form-urlencoded");
    if (/^\{[\s\S]*\}$|^\[[\s\S]*\]$/.test(r.body.trim()) && /json/i.test(header(r, "content-type") ?? "")) {
      try {
        r.body = JSON.stringify(JSON.parse(r.body), null, 2);
      } catch {
        // Keep the body as it was.
      }
    }
  }
  r.method = method || (data.length || form.length ? "POST" : "GET");
  return r;
}

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** A curl command that sends the prepared request. */
export function toCurl(p: Prepared): string {
  const parts = ["curl"];
  if (p.method === "HEAD") parts.push("--head");
  else if (p.method !== "GET" || p.body !== undefined || p.bodyFile || p.form) parts.push(`-X ${p.method}`);
  parts.push(shellQuote(p.url));
  for (const [k, v] of p.headers) parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  for (const f of p.form ?? []) parts.push(`-F ${shellQuote(f.file ? `${f.name}=@${f.file}${f.type ? `;type=${f.type}` : ""}` : `${f.name}=${f.value ?? ""}`)}`);
  if (p.bodyFile) parts.push(`--data-binary ${shellQuote(`@${p.bodyFile}`)}`);
  else if (p.body !== undefined) parts.push(`--data-raw ${shellQuote(p.body)}`);
  if (p.followRedirects) parts.push("-L");
  if (p.insecure) parts.push("-k");
  for (let i = 0, a = connectionArgs(p); i < a.length; i++) parts.push(a[i].startsWith("--http") ? a[i] : `${a[i]} ${shellQuote(a[++i])}`);
  return parts.join(" \\\n  ");
}

// ---- Code for Laravel's HTTP client ----

const phpString = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** A PHP literal for a JSON value, with arrays for objects, as Laravel's HTTP client takes them. */
export function phpValue(v: unknown, indent = ""): string {
  const next = indent + "    ";
  if (v === null) return "null";
  if (typeof v === "string") return phpString(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => `${next}${phpValue(x, next)},`).join("\n")}\n${indent}]` : "[]";
  const entries = Object.entries(v as object);
  return entries.length ? `[\n${entries.map(([k, x]) => `${next}${phpString(k)} => ${phpValue(x, next)},`).join("\n")}\n${indent}]` : "[]";
}

/** A Laravel `Http::` call that sends the prepared request. */
export function toLaravel(p: Prepared): string {
  const chain: string[] = [];
  const headers = p.headers.filter(([k, v]) => {
    const key = k.toLowerCase();
    if (key === "authorization" && /^Bearer\s+/i.test(v)) return chain.push(`->withToken(${phpString(v.replace(/^Bearer\s+/i, ""))})`), false;
    if (key === "authorization" && /^Basic\s+/i.test(v)) {
      try {
        const [user, ...pass] = atob(v.replace(/^Basic\s+/i, "")).split(":");
        return chain.push(`->withBasicAuth(${phpString(user)}, ${phpString(pass.join(":"))})`), false;
      } catch {
        return true;
      }
    }
    if (key === "accept" && v === "application/json") return chain.push("->acceptJson()"), false;
    return key !== "content-type" || !(p.form || /json|x-www-form-urlencoded/i.test(v));
  });
  if (headers.length) chain.unshift(`->withHeaders(${phpValue(Object.fromEntries(headers), "    ")})`);
  if (!p.followRedirects) chain.push("->withoutRedirecting()");
  if (p.insecure) chain.push("->withoutVerifying()");
  if (p.timeout !== 60) chain.push(`->timeout(${p.timeout})`);
  const type = p.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  const method = p.method.toLowerCase();
  let args = phpString(p.url);
  if (p.form) {
    for (const f of p.form.filter((f) => f.file)) chain.push(`->attach(${phpString(f.name)}, file_get_contents(${phpString(f.file!)}), ${phpString(f.filename ?? f.file!.split("/").pop()!)})`);
    const fields = Object.fromEntries(p.form.filter((f) => !f.file).map((f) => [f.name, f.value ?? ""]));
    if (!p.form.some((f) => f.file)) chain.push("->asMultipart()");
    if (Object.keys(fields).length) args += `, ${phpValue(fields, "    ")}`;
  } else if (p.body !== undefined && /json/i.test(type)) {
    try {
      args += `, ${phpValue(JSON.parse(p.body), "    ")}`;
    } catch {
      chain.push(`->withBody(${phpString(p.body)}, ${phpString(type)})`);
    }
  } else if (p.body !== undefined && /x-www-form-urlencoded/i.test(type)) {
    chain.push("->asForm()");
    args += `, ${phpValue(Object.fromEntries(new URLSearchParams(p.body)), "    ")}`;
  } else if (p.body !== undefined) chain.push(`->withBody(${phpString(p.body)}, ${phpString(type || "text/plain")})`);
  else if (p.bodyFile) chain.push(`->withBody(file_get_contents(${phpString(p.bodyFile)}), ${phpString(type || "application/octet-stream")})`);
  const call = ["get", "post", "put", "patch", "delete", "head"].includes(method) ? `->${method}(${args})` : `->send(${phpString(p.method)}, ${args})`;
  const [first, ...rest] = [...chain, call];
  return `$response = Http::${first.slice(2)}${rest.map((c) => `\n    ${c}`).join("")};`;
}

// ---- Code for JavaScript and Guzzle ----

type Body =
  | { kind: "json"; value: unknown }
  | { kind: "form"; fields: Record<string, string> }
  | { kind: "multipart"; parts: FormPart[] }
  | { kind: "text"; text: string; type: string }
  | { kind: "file"; path: string }
  | null;

/** The prepared request's body in the form the code generators write it. */
function bodyOf(p: Prepared): Body {
  const type = p.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  if (p.form) return { kind: "multipart", parts: p.form };
  if (p.bodyFile) return { kind: "file", path: p.bodyFile };
  if (p.body === undefined) return null;
  if (/json/i.test(type)) {
    try {
      return { kind: "json", value: JSON.parse(p.body) };
    } catch {
      // Sent as text.
    }
  }
  if (/x-www-form-urlencoded/i.test(type)) return { kind: "form", fields: Object.fromEntries(new URLSearchParams(p.body)) };
  return { kind: "text", text: p.body, type };
}

const js = (v: unknown, indent: string) => JSON.stringify(v, null, 2).replace(/\n/g, `\n${indent}`);
const partName = (f: FormPart) => f.filename ?? f.file!.split("/").pop()!;

/** Lines that build a FormData from multipart parts, reading files with Node's openAsBlob. */
const formDataLines = (parts: FormPart[]) => [
  "const form = new FormData();",
  ...parts.map((f) => (f.file ? `form.append(${js(f.name, "")}, await openAsBlob(${js(f.file, "")}), ${js(partName(f), "")});` : `form.append(${js(f.name, "")}, ${js(f.value ?? "", "")});`)),
];

/** The setup lines and the body expression for fetch and axios. */
function jsBody(body: Body, json: (value: unknown) => string): { setup: string[]; value?: string; imports: boolean } {
  if (!body) return { setup: [], imports: false };
  if (body.kind === "json") return { setup: [], value: json(body.value), imports: false };
  if (body.kind === "form") return { setup: [], value: `new URLSearchParams(${js(body.fields, "  ")})`, imports: false };
  if (body.kind === "multipart") return { setup: formDataLines(body.parts), value: "form", imports: true };
  if (body.kind === "file") return { setup: [], value: `await openAsBlob(${js(body.path, "")})`, imports: true };
  return { setup: [], value: js(body.text, "  "), imports: false };
}

/** JavaScript that sends the prepared request with fetch, for a browser or Node 20 and later. */
export function toFetch(p: Prepared): string {
  const b = jsBody(bodyOf(p), (v) => `JSON.stringify(${js(v, "  ")})`);
  const options = [`  method: ${js(p.method, "")},`];
  if (p.headers.length) options.push(`  headers: ${js(Object.fromEntries(p.headers), "  ")},`);
  if (b.value) options.push(`  body: ${b.value},`);
  if (!p.followRedirects) options.push(`  redirect: "manual",`);
  if (p.timeout !== 60) options.push(`  signal: AbortSignal.timeout(${p.timeout * 1000}),`);
  return [
    ...(b.imports ? [`import { openAsBlob } from "node:fs";`, ""] : []),
    ...b.setup,
    `const response = await fetch(${js(p.url, "")}, {`,
    ...options,
    "});",
    "const data = await response.text();",
  ].join("\n");
}

/** JavaScript that sends the prepared request with axios. */
export function toAxios(p: Prepared): string {
  const b = jsBody(bodyOf(p), (v) => js(v, "  "));
  const options = [`  method: ${js(p.method.toLowerCase(), "")},`, `  url: ${js(p.url, "")},`];
  if (p.headers.length) options.push(`  headers: ${js(Object.fromEntries(p.headers), "  ")},`);
  if (b.value) options.push(`  data: ${b.value},`);
  if (!p.followRedirects) options.push("  maxRedirects: 0,");
  if (p.timeout !== 60) options.push(`  timeout: ${p.timeout * 1000},`);
  return [`import axios from "axios";`, ...(b.imports ? [`import { openAsBlob } from "node:fs";`] : []), "", ...b.setup, "const response = await axios({", ...options, "});"].join("\n");
}

/** PHP that sends the prepared request with Guzzle's `$client->request()`. */
export function toGuzzle(p: Prepared): string {
  const body = bodyOf(p);
  const options: string[] = [];
  const opt = (key: string, value: string) => options.push(`    ${phpString(key)} => ${value},`);
  // Guzzle sets Content-Type itself for json and form_params.
  const headers = p.headers.filter(([k]) => k.toLowerCase() !== "content-type" || !(body?.kind === "json" || body?.kind === "form"));
  if (headers.length) opt("headers", phpValue(Object.fromEntries(headers), "    "));
  if (body?.kind === "json") opt("json", phpValue(body.value, "    "));
  else if (body?.kind === "form") opt("form_params", phpValue(body.fields, "    "));
  else if (body?.kind === "multipart") {
    const part = (f: FormPart) =>
      f.file
        ? `        ['name' => ${phpString(f.name)}, 'contents' => fopen(${phpString(f.file)}, 'r'), 'filename' => ${phpString(partName(f))}],`
        : `        ['name' => ${phpString(f.name)}, 'contents' => ${phpString(f.value ?? "")}],`;
    opt("multipart", `[\n${body.parts.map(part).join("\n")}\n    ]`);
  } else if (body?.kind === "file") opt("body", `fopen(${phpString(body.path)}, 'r')`);
  else if (body?.kind === "text") opt("body", phpString(body.text));
  if (!p.followRedirects) opt("allow_redirects", "false");
  if (p.insecure) opt("verify", "false");
  if (p.timeout !== 60) opt("timeout", String(p.timeout));
  if (p.connectTimeout) opt("connect_timeout", String(p.connectTimeout));
  if (p.proxy) opt("proxy", phpString(p.proxy));
  if (p.clientCert) opt("cert", phpString(p.clientCert));
  if (p.clientKey) opt("ssl_key", phpString(p.clientKey));
  if (p.http) opt("version", p.http === "2" ? "2.0" : "1.1");
  const args = `${phpString(p.method)}, ${phpString(p.url)}${options.length ? `, [\n${options.join("\n")}\n]` : ""}`;
  return `$client = new \\GuzzleHttp\\Client();\n$response = $client->request(${args});`;
}

// ---- Load testing ----

/** One request of a load test: its status (0 when it failed), total time and time to first byte in seconds, and curl's exit code. */
export type Sample = { code: number; total: number; ttfb: number; exit: number; bytes: number };

/** The --write-out format for each load test request, read back by parseSample. */
export const SAMPLE_FORMAT = "%{http_code} %{time_total} %{time_starttransfer} %{exitcode} %{size_download}\\n";

/**
 * curl arguments that send the prepared request `count` times, `concurrency` at a time, printing one SAMPLE_FORMAT
 * line per request. curl repeats a URL through its glob syntax, here a range in the fragment, which isn't sent.
 * A text body must already be in `p.bodyFile`, since the requests can't share stdin.
 */
export function loadArgs(p: Prepared, count: number, concurrency: number, cookies?: string): string[] {
  const args = ["-s", "-Z", "--parallel-immediate", "--parallel-max", String(concurrency), "--max-time", String(p.timeout), "-o", "/dev/null", "-w", SAMPLE_FORMAT];
  if (p.method === "HEAD") args.push("--head");
  else args.push("-X", p.method);
  if (p.followRedirects) args.push("-L");
  if (p.insecure) args.push("-k");
  args.push(...connectionArgs(p));
  if (p.connectTimeout) args.push("--connect-timeout", String(p.connectTimeout));
  // Send the cookies kept for the environment, such as a session, without changing them.
  if (cookies) args.push("-b", cookies);
  for (const [k, v] of p.headers) args.push("-H", v ? `${k}: ${v}` : `${k};`);
  for (const f of p.form ?? []) {
    if (f.file) args.push("-F", `${f.name}=@"${f.file}"${f.filename ? `;filename="${f.filename}"` : ""}${f.type ? `;type=${f.type}` : ""}`);
    else args.push("--form-string", `${f.name}=${f.value ?? ""}`);
  }
  if (p.bodyFile) args.push("--data-binary", `@${p.bodyFile}`);
  // Brackets and braces in the URL are glob syntax, so escape them.
  const url = p.url.split("#")[0].replace(/[[\]{}]/g, "\\$&");
  args.push("--", `${url}#[1-${count}]`);
  return args;
}

export function parseSample(line: string): Sample | null {
  const m = line.trim().match(/^(\d{3}) ([\d.]+) ([\d.]+) (\d+) (\d+)$/);
  return m ? { code: Number(m[1]), total: Number(m[2]), ttfb: Number(m[3]), exit: Number(m[4]), bytes: Number(m[5]) } : null;
}

export type Summary = {
  count: number;
  failed: number;
  rps: number;
  codes: [string, number][];
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  bytes: number;
};

/** Nearest-rank percentile of sorted values. */
export const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : 0);

/** Statistics for a load test's samples after `elapsed` seconds. A request fails on a curl error or a 5xx status. */
export function summarize(samples: Sample[], elapsed: number): Summary {
  const times = samples.map((s) => s.total).sort((a, b) => a - b);
  const codes = new Map<string, number>();
  for (const s of samples) {
    const key = s.code ? String(s.code) : "Error";
    codes.set(key, (codes.get(key) ?? 0) + 1);
  }
  return {
    count: samples.length,
    failed: samples.filter((s) => !s.code || s.exit || s.code >= 500).length,
    rps: elapsed > 0 ? samples.length / elapsed : 0,
    codes: [...codes].sort((a, b) => b[1] - a[1]),
    min: times[0] ?? 0,
    max: times.at(-1) ?? 0,
    mean: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0,
    p50: percentile(times, 50),
    p90: percentile(times, 90),
    p95: percentile(times, 95),
    p99: percentile(times, 99),
    bytes: samples.reduce((a, s) => a + s.bytes, 0),
  };
}

/** Counts of values in `buckets` equal-width ranges from 0 to the largest value. */
export function histogram(values: number[], buckets: number): { to: number; count: number }[] {
  const max = values.reduce((a, b) => Math.max(a, b), 0) || 1;
  const width = max / buckets;
  const counts = Array.from({ length: buckets }, (_, i) => ({ to: width * (i + 1), count: 0 }));
  for (const v of values) counts[Math.min(buckets - 1, Math.floor(v / width))].count++;
  return counts;
}

// ---- Laravel routes ----

export type Route = { method: string; uri: string; name: string | null; action: string; middleware?: string[] };

/**
 * A request for an `artisan route:list --json` route, with {{host}} for the app's address and a variable per
 * parameter. A web route signs in with the Laravel session, and an API route behind Sanctum with a bearer token.
 */
export function requestForRoute(route: Route, rules: Record<string, string> = {}): HttpRequest {
  const method = route.method.split("|").find((m) => m !== "HEAD") ?? "GET";
  const path = route.uri.replace(/\{(\w+)\??\}/g, "{{$1}}");
  const r = newRequest({ title: route.name ?? `${method} /${route.uri.replace(/^\//, "")}`, method, url: `{{host}}/${path.replace(/^\//, "")}`, headers: [{ name: "Accept", value: "application/json", enabled: true }] });
  const middleware = route.middleware ?? [];
  // Routes in the web group, or with its session middleware by class, as Filament lists them.
  if (middleware.some((m) => m === "web" || /\\StartSession$/.test(m))) r.tags.laravelSession = true;
  else if (middleware.some((m) => /^auth:sanctum|Authenticate:sanctum/.test(m))) r.headers.push({ name: "Authorization", value: "Bearer {{token}}", enabled: true });
  if (["POST", "PUT", "PATCH"].includes(method)) {
    r.headers.push({ name: "Content-Type", value: "application/json", enabled: true });
    r.body = Object.keys(rules).length ? JSON.stringify(bodyFromRules(rules), null, 2) : "{}";
  }
  return r;
}

/** The route a request calls: same method, and a path whose segments match, with {param} matching anything. */
export function matchRoute(method: string, url: string, routes: Route[]): Route | undefined {
  const path = url
    .replace(/^\{\{[^}]+\}\}/, "")
    .replace(/^https?:\/\/[^/]+/, "")
    .split(/[?#]/)[0]
    .replace(/^\/+|\/+$/g, "");
  const segments = path ? path.split("/") : [];
  const m = method === "GRAPHQL" ? "POST" : method;
  return routes.find((r) => {
    if (!r.method.split("|").includes(m)) return false;
    const parts = r.uri.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    const required = parts.filter((p) => !/^\{\w+\?\}$/.test(p)).length;
    if (segments.length < required || segments.length > parts.length) return false;
    return segments.every((s, i) => /^\{\w+\??\}$/.test(parts[i]) || s === parts[i] || /^\{\{[^}]+\}\}$/.test(s));
  });
}

/** A JSON body for Laravel validation rules, with a value of the right type for each field. */
export function bodyFromRules(rules: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const example = (rule: string, key: string): unknown => {
    if (/\b(boolean|accepted|declined)\b/.test(rule)) return false;
    if (/\b(integer|numeric|decimal|digits|min_digits)\b/.test(rule)) return 0;
    if (/\barray\b/.test(rule)) return [];
    if (/\bemail\b/.test(rule)) return "{{$random.email}}";
    if (/\buuid\b/.test(rule)) return "{{$uuid}}";
    if (/\b(date|date_format|after|before)\b/.test(rule)) return "{{$isoTimestamp}}";
    if (/\burl\b/.test(rule)) return "https://example.com";
    if (/password/.test(key)) return "password";
    return "";
  };
  const set = (target: Record<string, unknown> | unknown[], parts: string[], value: unknown) => {
    const [part, ...rest] = parts;
    if (part === "*") {
      const list = target as unknown[];
      if (!rest.length) return void (list.length || list.push(value));
      if (!list.length) list.push(rest[0] === "*" ? [] : {});
      return set(list[0] as Record<string, unknown>, rest, value);
    }
    const obj = target as Record<string, unknown>;
    if (!rest.length) {
      obj[part] ??= value;
      return;
    }
    if (typeof obj[part] !== "object" || obj[part] === null) obj[part] = rest[0] === "*" ? [] : {};
    set(obj[part] as Record<string, unknown>, rest, value);
  };
  for (const [key, rule] of Object.entries(rules)) {
    set(body, key.split("."), example(rule, key));
    if (/\bconfirmed\b/.test(rule) && !key.includes(".")) body[`${key}_confirmation`] = body[key];
  }
  return body;
}

// ---- Sync with routes ----

/** A change that brings a file's requests in line with the app's routes. */
export type SyncChange =
  | { kind: "add"; route: Route; request: HttpRequest }
  | { kind: "update"; route: Route; request: HttpRequest; updated: HttpRequest; added: string[]; removed: string[] }
  | { kind: "remove"; request: HttpRequest };

/**
 * A JSON body brought in line with validation rules: fields the rules add get an example value, fields no rule
 * validates go, and the values you set stay, in their order. Null when nothing changes, when there are no rules (they
 * may just be unreadable), or when the body isn't a plain JSON object, such as one with a {{variable}} outside quotes.
 */
export function syncBody(body: string, rules: Record<string, string>): { body: string; added: string[]; removed: string[] } | null {
  if (!Object.keys(rules).length) return null;
  const want = bodyFromRules(rules);
  let have: Record<string, unknown> = {};
  if (body.trim()) {
    try {
      have = JSON.parse(body);
    } catch {
      return null;
    }
    if (!have || typeof have !== "object" || Array.isArray(have)) return null;
  }
  const added = Object.keys(want).filter((k) => !(k in have));
  const removed = Object.keys(have).filter((k) => !(k in want));
  if (!added.length && !removed.length) return null;
  const next: Record<string, unknown> = {};
  for (const k of Object.keys(have)) if (k in want) next[k] = have[k];
  for (const k of added) next[k] = want[k];
  // The body's own indentation, two spaces if it has none.
  const indent = body.match(/\n([ \t]+)"/)?.[1] ?? "  ";
  return { body: JSON.stringify(next, null, indent), added, removed };
}

const hasBody = (method: string) => ["POST", "PUT", "PATCH"].includes(method);

/**
 * What syncing a file's requests with `routes` would change: a request for each route none calls, a body for each
 * request whose route validates other fields, and each request to {{host}} that no route answers. Requests to other
 * hosts are left alone. `rules` has each route's validation rules, by its action.
 */
export function routeSync(text: string, routes: Route[], rules: Map<string, Record<string, string>>): SyncChange[] {
  const changes: SyncChange[] = [];
  const called = new Set<Route>();
  for (const request of parseHttp(text).requests) {
    if (!/^\{\{\s*host\s*\}\}/.test(request.url)) continue;
    const route = matchRoute(request.method, request.url, routes);
    if (!route) {
      changes.push({ kind: "remove", request });
      continue;
    }
    called.add(route);
    if (!hasBody(request.method)) continue;
    const synced = syncBody(request.body, rules.get(route.action) ?? {});
    if (!synced) continue;
    const updated: HttpRequest = { ...request, headers: [...request.headers], body: synced.body };
    if (!header(updated, "content-type")) updated.headers.push({ name: "Content-Type", value: "application/json", enabled: true });
    changes.push({ kind: "update", route, request, updated, added: synced.added, removed: synced.removed });
  }
  for (const route of routes) if (!called.has(route)) changes.push({ kind: "add", route, request: requestForRoute(route, rules.get(route.action)) });
  return changes;
}

/** Lines `start` to `end` (1-based, inclusive) replaced by `lines`; `end` one before `start` inserts before `start`. */
export type LineEdit = { start: number; end: number; lines: string[] };

/**
 * The line edits that make `changes`, which don't overlap: each updated request's block rewritten (keeping the blank
 * line after it), each removed one's taken out, and new ones added after the last line with a blank line before them.
 */
export function syncEdits(text: string, changes: SyncChange[]): LineEdit[] {
  const lines = text.split("\n");
  const edits: LineEdit[] = [];
  for (const c of changes) {
    if (c.kind === "remove") edits.push({ start: c.request.start, end: c.request.end, lines: [] });
    else if (c.kind === "update") {
      const { start, end } = c.request;
      const blank = !lines[end - 1]?.trim() ? [""] : [];
      edits.push({ start, end, lines: [...formatRequest(c.updated).replace(/\n$/, "").split("\n"), ...blank] });
    }
  }
  const added = changes.flatMap((c) => (c.kind === "add" ? [formatRequest(c.request).replace(/\n$/, "")] : [])).join("\n\n").split("\n");
  if (changes.some((c) => c.kind === "add")) {
    if (!text.trim()) edits.push({ start: 1, end: lines.length, lines: [...added, ""] });
    // Text that ends in a newline has an empty last "line", which becomes the blank line before them.
    else edits.push({ start: lines.length + 1, end: lines.length, lines: [...(text.endsWith("\n") ? [] : [""]), ...added, ""] });
  }
  return edits;
}

/** The text with line edits made. */
export function applyLineEdits(text: string, edits: LineEdit[]): string {
  const lines = text.split("\n");
  // From the bottom, so earlier lines keep their numbers.
  for (const e of [...edits].sort((a, b) => b.start - a.start)) lines.splice(e.start - 1, e.end - e.start + 1, ...e.lines);
  return lines.join("\n");
}

/** Values that `path` selects in JSON: $, .key, ['key'], [n], [-n], [*], .*, and ..key for any depth. */
export function jsonQuery(value: unknown, path: string): unknown[] {
  const tokens = [...path.trim().replace(/^\$/, "").matchAll(/\.\.([\w$-]+|\*)|\.([\w$-]+|\*)|\[\s*(?:'([^']*)'|"([^"]*)"|(-?\d+)|(\*))\s*\]/g)];
  let current: unknown[] = [value];
  const children = (v: unknown) => (v && typeof v === "object" ? Object.values(v as object) : []);
  const descendants = (v: unknown): unknown[] => [v, ...children(v).flatMap(descendants)];
  for (const [, deep, key, quoted, dquoted, index, star] of tokens) {
    if (deep !== undefined) {
      const all = current.flatMap(descendants);
      current = deep === "*" ? all.flatMap(children) : all.flatMap((v) => (v && typeof v === "object" && !Array.isArray(v) && deep in (v as object) ? [(v as Record<string, unknown>)[deep]] : []));
    } else if (star !== undefined || key === "*") current = current.flatMap(children);
    else if (index !== undefined) current = current.flatMap((v) => (Array.isArray(v) ? [v.at(Number(index))].filter((x) => x !== undefined) : []));
    else {
      const k = key ?? quoted ?? dquoted;
      current = current.flatMap((v) => (v && typeof v === "object" && k in (v as object) ? [(v as Record<string, unknown>)[k]] : []));
    }
  }
  return current;
}

export type ExceptionReport = { className: string; message: string; frames: { file: string; line: number }[] };

/**
 * The exception in a Laravel error response with APP_DEBUG on: the JSON Laravel sends when asked for JSON, or the
 * file and line references in its HTML error page (Ignition's or Laravel's own).
 */
export function laravelException(body: string, status: number): ExceptionReport | null {
  if (status < 500) return null;
  try {
    const j = JSON.parse(body) as { exception?: string; message?: string; file?: string; line?: number; trace?: { file?: string; line?: number }[] };
    if (j && typeof j === "object" && j.exception) {
      const frames = [{ file: j.file, line: j.line }, ...(j.trace ?? [])].filter((f): f is { file: string; line: number } => !!f.file).map((f) => ({ file: f.file, line: f.line ?? 1 }));
      return { className: j.exception, message: j.message ?? "", frames };
    }
  } catch {
    // Not JSON: look for an HTML error page.
  }
  const text = body.replace(/\\\//g, "/");
  const seen = new Set<string>();
  const frames: { file: string; line: number }[] = [];
  for (const [, file, line] of text.matchAll(/((?:\/[\w.@~+-]+)+\.php)(?:"?\s*,\s*"line_number"\s*:\s*|:|\s+on\s+line\s+|&quot;,&quot;line_number&quot;:)(\d+)/g)) {
    if (seen.has(`${file}:${line}`) || frames.length >= 40) continue;
    seen.add(`${file}:${line}`);
    frames.push({ file, line: Number(line) });
  }
  if (!frames.length) return null;
  const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const className = text.match(/"exception_class"\s*:\s*"([^"]+)"/)?.[1].replace(/\\\\/g, "\\") ?? "";
  const json = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  let message = decode(text.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  if (json) {
    try {
      message = JSON.parse(`"${json}"`);
    } catch {
      // Keep the page title.
    }
  }
  return { className, message, frames };
}

// ---- Less typing: JSON paths under the cursor, checks without code, and the environment table ----

/** One segment of a JSON path: .key for plain names, ['key'] or ["key"] for others, [n] for array items. */
const pathSegment = (key: string | number) => (typeof key === "number" ? `[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : key.includes("'") ? `["${key}"]` : `['${key}']`);

/**
 * The JSON path of the value at `offset` in JSON text, such as $.data[0].token. On a key, it's the path of the
 * key's value; between values, the path of the object or array around them. Null when the text isn't JSON.
 */
export function jsonPathAt(text: string, offset: number): string | null {
  let i = 0;
  let found: string | null = null;
  const space = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const string = () => {
    for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    i++;
  };
  // Children come first, so the deepest value that contains the offset wins.
  const value = (path: string) => {
    space();
    const start = i;
    const open = text[i];
    if (open === "{" || open === "[") {
      i++;
      for (let n = 0; ; n++) {
        space();
        if (i >= text.length || text[i] === (open === "{" ? "}" : "]")) break;
        let child = path + pathSegment(n);
        if (open === "{") {
          const keyStart = i;
          string();
          child = path + pathSegment(JSON.parse(text.slice(keyStart, i)) as string);
          if (offset >= keyStart && offset <= i) found ??= child;
          space();
          if (text[i] === ":") i++;
        }
        const before = i;
        value(child);
        if (i === before) i++;
        space();
        if (text[i] === ",") i++;
      }
      i++;
      if (offset >= start && offset < i) found ??= path;
      return;
    }
    if (open === '"') string();
    else while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
    if (offset >= start && offset <= i && i > start) found ??= path;
  };
  try {
    value("$");
  } catch {
    return null;
  }
  return found;
}

/** A variable name for the value at a JSON path: its last key, such as token for $.data[0].token. */
export function nameForPath(path: string): string {
  const keys = [...path.matchAll(/\.([\w$-]+)|\[\s*'([^']*)'\s*\]|\[\s*"([^"]*)"\s*\]/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  return keys.at(-1)?.replace(/[^\w.-]+/g, "_") || "value";
}

export type CheckKind = "status" | "exists" | "equals" | "header" | "time" | "body";
/** A test you set up without code. `target` is a JSON path or a header name; kinds that don't need it leave it empty. */
export type Check = { kind: CheckKind; target: string; expected: string };

/**
 * Each kind of check: its label, placeholders, and code, given the target and expected value as JavaScript
 * literals. A `number` kind takes the expected value as a number. Each check runs as one client.test() call.
 */
export const CHECKS: Record<CheckKind, { label: string; target?: string; expected?: string; number?: boolean; name(c: Check): string; code(t: string, e: string): string }> = {
  status: { label: "Status is", expected: "200", name: (c) => `Status is ${c.expected}`, code: (_, e) => `client.assert(String(response.status) === ${e}, "Status was " + response.status)` },
  exists: { label: "JSON path exists", target: "$.data.id", name: (c) => `${c.target} exists`, code: (t) => `client.assert(jsonPath(response.body, ${t}) !== undefined, "Not in the response")` },
  equals: { label: "JSON path equals", target: "$.data.id", expected: "1", name: (c) => `${c.target} is ${c.expected}`, code: (t, e) => `{ const v = jsonPath(response.body, ${t}); client.assert([String(v), JSON.stringify(v)].includes(${e}), "Was " + JSON.stringify(v)); }` },
  header: { label: "Header contains", target: "Content-Type", expected: "json", name: (c) => `${c.target} contains ${c.expected}`, code: (t, e) => `client.assert(String(response.headers.valueOf(${t}) ?? "").includes(${e}), "Was " + response.headers.valueOf(${t}))` },
  time: { label: "Response time under (ms)", expected: "500", number: true, name: (c) => `Responds in under ${c.expected} ms`, code: (_, e) => `client.assert(response.time < ${e}, "Took " + response.time + " ms")` },
  body: { label: "Body contains", expected: "text", name: (c) => `Body contains ${c.expected}`, code: (_, e) => `client.assert((typeof response.body === "string" ? response.body : JSON.stringify(response.body)).includes(${e}), "Not in the body")` },
};
export const CHECKS_START = "// checks:start";
export const CHECKS_END = "// checks:end";

const checkLine = (c: Check) => {
  const k = CHECKS[c.kind];
  const expected = k.number ? String(Number(c.expected) || 0) : JSON.stringify(c.expected);
  return `client.test(${JSON.stringify(k.name(c))}, () => ${k.code(JSON.stringify(c.target), expected)});`;
};

const LITERAL = String.raw`("(?:[^"\\]|\\.)*")`;
/** A pattern for each kind's code, made from the code itself, with groups for the target and expected value. */
const checkPatterns = (Object.keys(CHECKS) as CheckKind[]).map((kind) => {
  const k = CHECKS[kind];
  const groups: string[] = [];
  const escaped = k.code("\u0001t", "\u0001e").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replace(/\u0001[te]/g, (m) => (groups.includes(m) ? `\\${groups.indexOf(m) + 2}` : (groups.push(m), m === "\u0001e" && k.number ? String.raw`(\d+(?:\.\d+)?)` : LITERAL)));
  return { kind, groups, re: new RegExp(`^client\\.test\\(${LITERAL}, \\(\\) => ${source}\\);$`) };
});

function parseCheck(line: string): Check | null {
  for (const { kind, groups, re } of checkPatterns) {
    const m = line.match(re);
    if (!m) continue;
    // Group 1 is the test's name.
    const at = (g: string) => (groups.includes(g) ? m[groups.indexOf(g) + 2] : undefined);
    const t = at("\u0001t");
    const e = at("\u0001e");
    return { kind, target: t ? (JSON.parse(t) as string) : "", expected: e === undefined ? "" : CHECKS[kind].number ? e : (JSON.parse(e) as string) };
  }
  return null;
}

/** The lines of a response handler and where its checks markers are, or null when it has none. */
function checksBlock(code: string) {
  const lines = code.split("\n");
  const start = lines.findIndex((l) => l.trim() === CHECKS_START);
  const end = lines.findIndex((l, i) => i > start && l.trim() === CHECKS_END);
  return start < 0 || end < 0 ? null : { lines, start, end };
}

/** The checks in a response handler. `editable` is false when the code between the markers isn't what writeChecks writes. */
export function readChecks(code: string): { checks: Check[]; editable: boolean } {
  const block = checksBlock(code);
  if (!block) return { checks: [], editable: true };
  const checks = block.lines.slice(block.start + 1, block.end).filter((l) => l.trim()).map((l) => parseCheck(l.trim()));
  return { checks: checks.filter((c): c is Check => !!c), editable: checks.every(Boolean) };
}

/** Writes checks between the markers, keeping the code around them. No checks removes the markers. */
export function writeChecks(code: string, checks: Check[]): string {
  const lines = checks.length ? [CHECKS_START, ...checks.map(checkLine), CHECKS_END] : [];
  const block = checksBlock(code);
  if (block) return [...block.lines.slice(0, block.start), ...lines, ...block.lines.slice(block.end + 1)].join("\n").replace(/^\n+|\n+$/g, "");
  return [code.trimEnd(), ...lines].filter(Boolean).join("\n");
}

type EnvFile = Record<string, Record<string, unknown>>;
/** A variable in the environment editor. A value that's undefined isn't set in that environment. */
export type EnvRow = { name: string; private: boolean; values: Record<string, string | undefined> };
/** Environments as a table: a column per environment, $shared first, and a row per variable. */
export type EnvTable = { envs: string[]; rows: EnvRow[] };

/** Names that look like secrets, which the environment editor keeps in the private file. */
export const looksSecret = (name: string) => /token|secret|password|passwd|key|auth/i.test(name);

/** The table for http-client.env.json and http-client.private.env.json. A variable in the private file is private. */
export function envTable(shared: EnvFile | null, secret: EnvFile | null): EnvTable {
  const envs = ["$shared", ...new Set([...Object.keys(shared ?? {}), ...Object.keys(secret ?? {})].filter((e) => e !== "$shared"))];
  const rows = new Map<string, EnvRow>();
  for (const [file, isPrivate] of [[shared, false], [secret, true]] as const)
    for (const [env, vars] of Object.entries(file ?? {}))
      for (const [name, v] of Object.entries(vars ?? {})) {
        const row = rows.get(name) ?? { name, private: false, values: {} };
        row.private ||= isPrivate;
        row.values[env] = typeof v === "string" ? v : JSON.stringify(v);
        rows.set(name, row);
      }
  return { envs, rows: [...rows.values()] };
}

/**
 * The two files' contents for a table. Every environment stays in the shared file, even without values, so it
 * shows in the menus. A variable without any value gets an empty one in each environment, so it isn't lost.
 */
export function envFiles(t: EnvTable): { shared: EnvFile; secret: EnvFile } {
  const real = t.envs.filter((e) => e !== "$shared");
  const out = { shared: {} as EnvFile, secret: {} as EnvFile };
  for (const env of t.envs) {
    const vars = { shared: {} as Record<string, string>, secret: {} as Record<string, string> };
    for (const row of t.rows) {
      if (!row.name) continue;
      const unset = Object.values(row.values).every((v) => v === undefined);
      const value = unset && (real.includes(env) || (!real.length && env === "$shared")) ? "" : row.values[env];
      if (value !== undefined) vars[row.private ? "secret" : "shared"][row.name] = value;
    }
    if (env !== "$shared" || Object.keys(vars.shared).length) out.shared[env] = vars.shared;
    if (Object.keys(vars.secret).length) out.secret[env] = vars.secret;
  }
  return out;
}

// ---- Hiding secrets ----

/** Names of headers, query parameters, and body fields whose values are secrets. */
const SECRET_NAME = /token|secret|passw(?:or)?d|api[-_]?key|authori[sz]ation|(?:^|[-_])auth(?:[-_]|$)|credential|signature|private[-_]?key|card[-_]?number|^cv[cv]$/i;
export const isSecretName = (name: string) => SECRET_NAME.test(name);
const MASK = "••••";

/** Hides a secret, keeping its last 4 characters when it's long enough that they don't give it away. A {{name}} stays. */
export const mask = (value: string) => (!value || value.startsWith(MASK) || /^\{\{[^}]+\}\}$/.test(value) ? value : value.length >= 12 ? MASK + value.slice(-4) : MASK);

/** A header's value with its secret hidden: Authorization keeps its scheme, and cookies keep their names. */
export function redactHeader(name: string, value: string): string {
  const key = name.toLowerCase();
  if (key === "cookie") return value.split(";").map((c) => (c.includes("=") ? `${c.slice(0, c.indexOf("="))}=${MASK}` : c)).join(";");
  if (key === "set-cookie") return value.includes("=") ? `${value.slice(0, value.indexOf("="))}=${MASK}${value.includes(";") ? value.slice(value.indexOf(";")) : ""}` : value;
  if (!isSecretName(name)) return value;
  const scheme = key.endsWith("authorization") && value.match(/^([A-Za-z][\w-]*)\s+(\S.*)$/);
  // Basic's last characters encode the password's, so none show.
  return scheme ? `${scheme[1]} ${/^basic$/i.test(scheme[1]) && !scheme[2].startsWith("{{") ? MASK : mask(scheme[2])}` : mask(value);
}

/** `a=1&b=2` pairs, as in a query or a form body, with secret values hidden. */
const redactPairs = (text: string) =>
  text
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return pair;
      let name = pair.slice(0, eq);
      try {
        name = decodeURIComponent(name);
      } catch {
        // Keep it as written.
      }
      return isSecretName(name) ? `${pair.slice(0, eq)}=${mask(pair.slice(eq + 1))}` : pair;
    })
    .join("&");

/** A JSON value with the values of secret fields hidden, and everything under a secret field. */
function redactJson(v: unknown, secret = false): unknown {
  if (Array.isArray(v)) return v.map((x) => redactJson(x, secret));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactJson(x, secret || isSecretName(k))]));
  return secret && v !== null ? mask(String(v)) : v;
}

function redactBody(body: string, type: string): string {
  const t = body.trim();
  if (/^[{[]/.test(t)) {
    try {
      const parsed = JSON.parse(t);
      const out = redactJson(parsed);
      return JSON.stringify(out) === JSON.stringify(parsed) ? body : JSON.stringify(out, null, t.includes("\n") ? 2 : undefined);
    } catch {
      // Not JSON.
    }
  }
  return /x-www-form-urlencoded/i.test(type) || (!type && /^[\w.%[\]-]+=\S*$/.test(t)) ? redactPairs(body) : body;
}

/**
 * The request with its secrets hidden, for the history file and for showing and copying: values of secret headers
 * (Authorization, cookies, and names with token, secret, password, or API key), query parameters, and JSON, form,
 * and multipart fields. Response bodies aren't changed.
 */
export function redact(p: Prepared): Prepared {
  const q = p.url.indexOf("?");
  const hashAt = p.url.indexOf("#", q);
  const query = q < 0 ? "" : p.url.slice(q + 1, hashAt < 0 ? undefined : hashAt);
  const type = p.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  return {
    ...p,
    url: q < 0 ? p.url : `${p.url.slice(0, q)}?${redactPairs(query)}${hashAt < 0 ? "" : p.url.slice(hashAt)}`,
    headers: p.headers.map(([k, v]) => [k, redactHeader(k, v)]),
    ...(p.body !== undefined ? { body: redactBody(p.body, type) } : {}),
    ...(p.form ? { form: p.form.map((f) => (f.value !== undefined && isSecretName(f.name) ? { ...f, value: mask(f.value) } : f)) } : {}),
  };
}

/** Whether redact hides anything in the request. */
export const hasSecrets = (p: Prepared) => JSON.stringify(redact(p)) !== JSON.stringify(p);
