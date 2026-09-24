// Reads .http files (PhpStorm's HTTP client format) and curl's output. Free of editor imports so Node can test it.

export type HttpRequest = {
  name: string;
  /** 1-based line of the request line (METHOD URL). */
  line: number;
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
};

const METHODS = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+(\S+)(?:\s+HTTP\/[\d.]+)?\s*$/i;
const isComment = (line: string) => /^\s*(#|\/\/)/.test(line);

/** The requests in a file. Requests are separated by lines starting with ###, which may name them. */
export function parseHttpFile(text: string): HttpRequest[] {
  const lines = text.split(/\r?\n/);
  const requests: HttpRequest[] = [];
  let start = 0;
  const flush = (end: number, name: string) => {
    let i = start;
    while (i < end && (!lines[i].trim() || isComment(lines[i]))) i++;
    if (i >= end) return;
    const first = lines[i].trim();
    const m = first.match(METHODS);
    const request: HttpRequest = { name, line: i + 1, method: m ? m[1].toUpperCase() : "GET", url: m ? m[2] : first.split(/\s+/)[0], headers: [], body: "" };
    i++;
    // Indented lines continue the URL, such as one query parameter per line.
    while (i < end && /^\s+[?&]/.test(lines[i])) request.url += lines[i++].trim();
    for (; i < end && lines[i].trim(); i++) {
      if (isComment(lines[i])) continue;
      const colon = lines[i].indexOf(":");
      if (colon > 0) request.headers.push([lines[i].slice(0, colon).trim(), lines[i].slice(colon + 1).trim()]);
    }
    request.body = lines.slice(i, end).filter((l) => !isComment(l)).join("\n").trim();
    requests.push(request);
  };
  let name = "";
  lines.forEach((line, i) => {
    if (line.startsWith("###")) {
      flush(i, name);
      name = line.replace(/^###\s*/, "").trim();
      start = i + 1;
    }
  });
  flush(lines.length, name);
  return requests;
}

/** Replaces {{name}} with the environment's value. Unknown names stay as they are. */
export const substitute = (text: string, vars: Record<string, string>) =>
  text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (all, name) => (name in vars ? vars[name] : all));

export type HttpResponse = { status: number; statusText: string; headers: [string, string][]; body: string; seconds: number };

/** Marker between the body and the timing that curl's --write-out adds. */
export const TIME_MARKER = "\n__HTTP_TIME__";

/** Parses `curl -i` output. Interim responses, such as 100 Continue, are skipped. */
export function parseCurlOutput(out: string): HttpResponse {
  const at = out.lastIndexOf(TIME_MARKER);
  const seconds = at >= 0 ? Number(out.slice(at + TIME_MARKER.length)) || 0 : 0;
  let rest = at >= 0 ? out.slice(0, at) : out;
  for (;;) {
    const end = rest.search(/\r?\n\r?\n/);
    const head = end >= 0 ? rest.slice(0, end) : rest;
    const body = end >= 0 ? rest.slice(end).replace(/^\r?\n\r?\n/, "") : "";
    const [statusLine, ...headerLines] = head.split(/\r?\n/);
    const m = statusLine.match(/^HTTP\/[\d.]+\s+(\d+)\s*(.*)$/);
    if (m && /^1\d\d$/.test(m[1]) && body.startsWith("HTTP/")) {
      rest = body;
      continue;
    }
    return {
      status: m ? Number(m[1]) : 0,
      statusText: m ? m[2].trim() : "",
      headers: headerLines.map((l): [string, string] => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]).filter(([k]) => k),
      body,
      seconds,
    };
  }
}
