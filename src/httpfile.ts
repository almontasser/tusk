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
};

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT", "GRAPHQL", "WEBSOCKET"];
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
};

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
