// Converts other tools' formats to and from .http files: Postman collections, Insomnia exports, and OpenAPI or
// Swagger documents in; OpenAPI and JUnit XML reports out. Free of editor imports so Node can test it.
import { formatRequest, type Header, header, type HttpRequest, newRequest } from "./httpfile.ts";

/** Imported files are JSON of many shapes, read defensively. */
type J = any;
export type Environments = Record<string, Record<string, string>>;
/** An .http file's text, its default name, how many requests it has, and variables for http-client.env.json. */
export type Imported = { name: string; text: string; count: number; env: Environments };

const BOUNDARY = "WebAppBoundary";
const on = (list: J) => (Array.isArray(list) ? list : []).filter((x: J) => x && !x.disabled);
const str = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));
const commented = (label: string, code: string) => [`# ${label} (not converted):`, ...code.split("\n").map((l) => `#   ${l}`)];
const multipart = (parts: { name: string; value?: string; file?: string }[]) =>
  parts.map((p) => `--${BOUNDARY}\nContent-Disposition: form-data; name="${p.name}"${p.file ? `; filename="${p.file.split("/").pop()}"` : ""}\n\n${p.file ? `< ${p.file}` : (p.value ?? "")}`).join("\n") + `\n--${BOUNDARY}--`;
const setHeader = (r: HttpRequest, name: string, value: string) => header(r, name) ?? r.headers.push({ name, value, enabled: true });

/** Reads a Postman collection, Insomnia export, or OpenAPI or Swagger document, whichever the JSON is. */
export function importCollection(text: string): Imported {
  let doc: J;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("The file isn't JSON. For an OpenAPI document in YAML, convert it to JSON first.");
  }
  if (/postman/.test(doc?.info?.schema ?? "") || (doc?.info && Array.isArray(doc.item))) return fromPostman(doc);
  if (doc?._type === "export" && Array.isArray(doc.resources)) return fromInsomnia(doc);
  if (doc?.openapi || doc?.swagger) return fromOpenApi(doc);
  throw new Error("The file isn't a Postman collection (v2), an Insomnia export (v4), or an OpenAPI or Swagger document.");
}

/** A file: comments and `@name = value` lines, then the requests. */
function file(name: string, head: string[], vars: [string, string][], requests: HttpRequest[], env: Environments = {}): Imported {
  const top = [...head, ...vars.map(([k, v]) => `@${k} = ${v}`)];
  return { name, text: (top.length ? top.join("\n") + "\n\n" : "") + requests.map(formatRequest).join("\n"), count: requests.length, env };
}

// ---- Postman ----

/** Postman's dynamic variables that have a PhpStorm name. */
const postmanVars = (s: string) => s.replace(/\{\{\$guid\}\}/g, "{{$uuid}}").replace(/\{\{\$randomUUID\}\}/g, "{{$uuid}}");

/** Postman's auth as a header. v2.1 lists fields as key-value pairs; v2.0 as an object. */
function postmanAuth(auth: J): Header | null {
  const get = (key: string) => {
    const list = auth?.[auth.type];
    return str(Array.isArray(list) ? list.find((x: J) => x.key === key)?.value : list?.[key]);
  };
  if (auth?.type === "bearer") return { name: "Authorization", value: `Bearer ${get("token")}`, enabled: true };
  if (auth?.type === "basic") return { name: "Authorization", value: `Basic ${get("username")} ${get("password")}`, enabled: true };
  if (auth?.type === "apikey" && get("in") !== "query") return { name: get("key") || "X-API-Key", value: get("value"), enabled: true };
  return null;
}

function postmanUrl(url: J): string {
  if (typeof url === "string") return url;
  if (url?.raw) return url.raw;
  const host = Array.isArray(url?.host) ? url.host.join(".") : str(url?.host);
  const path = Array.isArray(url?.path) ? url.path.join("/") : str(url?.path);
  const query = on(url?.query).map((q: J) => `${q.key}=${str(q.value)}`);
  return `${url?.protocol ? `${url.protocol}://` : ""}${host}${path ? `/${path}` : ""}${query.length ? `?${query.join("&")}` : ""}`;
}

function fromPostman(doc: J): Imported {
  const requests: HttpRequest[] = [];
  const vars = new Map<string, string>(on(doc.variable).map((v: J) => [v.key, str(v.value)]));
  const scripts = (events: J) =>
    on(events).flatMap((e: J) => {
      const code = Array.isArray(e.script?.exec) ? e.script.exec.join("\n") : str(e.script?.exec);
      return code.trim() ? commented(`Postman ${e.listen === "test" ? "test" : "pre-request"} script`, code) : [];
    });
  const walk = (items: J[], folders: string[], auth: J) => {
    for (const item of items ?? []) {
      if (Array.isArray(item.item)) {
        for (const v of on(item.variable)) if (!vars.has(v.key)) vars.set(v.key, str(v.value));
        walk(item.item, [...folders, item.name], item.auth ?? auth);
        continue;
      }
      const req = typeof item.request === "string" ? { url: item.request } : (item.request ?? {});
      const r = newRequest({ title: [...folders, item.name].filter(Boolean).join(" / "), method: str(req.method || "GET").toUpperCase(), comments: scripts(item.event) });
      const url = postmanUrl(req.url);
      // Path variables, such as /posts/:id, become {{id}}, defined as file variables with Postman's values.
      for (const v of on(req.url?.variable)) if (!vars.has(v.key)) vars.set(v.key, str(v.value));
      r.url = postmanVars(url.replace(/\/:([A-Za-z_]\w*)/g, "/{{$1}}"));
      r.headers = (Array.isArray(req.header) ? req.header : []).map((x: J) => ({ name: x.key, value: postmanVars(str(x.value)), enabled: !x.disabled }));
      const a = postmanAuth(req.auth ?? auth);
      if (a && !header(r, a.name)) r.headers.push(a);
      const body = req.body ?? {};
      if (body.mode === "raw" && body.raw) {
        r.body = postmanVars(body.raw);
        const language = body.options?.raw?.language;
        if (language === "json" || (!language && /^\s*[{[]/.test(body.raw))) setHeader(r, "Content-Type", "application/json");
        else if (language === "xml") setHeader(r, "Content-Type", "application/xml");
      } else if (body.mode === "urlencoded") {
        r.body = on(body.urlencoded).map((f: J) => `${f.key}=${str(f.value)}`).join("&");
        setHeader(r, "Content-Type", "application/x-www-form-urlencoded");
      } else if (body.mode === "formdata") {
        r.headers = r.headers.filter((x) => x.name.toLowerCase() !== "content-type");
        r.headers.push({ name: "Content-Type", value: `multipart/form-data; boundary=${BOUNDARY}`, enabled: true });
        r.body = multipart(on(body.formdata).map((f: J) => (f.type === "file" ? { name: f.key, file: str(Array.isArray(f.src) ? f.src[0] : f.src) } : { name: f.key, value: str(f.value) })));
      } else if (body.mode === "graphql") {
        r.method = "GRAPHQL";
        r.body = str(body.graphql?.query).trim() + (str(body.graphql?.variables).trim() ? `\n\n${str(body.graphql.variables).trim()}` : "");
      } else if (body.mode === "file" && body.file?.src) r.body = `< ${body.file.src}`;
      requests.push(r);
    }
  };
  walk(doc.item, [], doc.auth);
  const name = doc.info?.name ?? "postman";
  return file(name, [`# Imported from the Postman collection ${name}.`, ...scripts(doc.event)], [...vars], requests);
}

// ---- Insomnia ----

/** Insomnia writes variables as {{ _.name }}. */
const insomniaVars = (s: unknown) => str(s).replace(/\{\{\s*_\.([\w.-]+)\s*\}\}/g, "{{$1}}");

/** Nested environment values become dotted names, as Insomnia reads them. */
function flatten(data: J, prefix = "", out: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, `${prefix}${k}.`, out);
    else out[`${prefix}${k}`] = insomniaVars(v);
  }
  return out;
}

function fromInsomnia(doc: J): Imported {
  const byId = new Map<string, J>(doc.resources.map((x: J) => [x._id, x]));
  const folders = (id: string): string[] => {
    const parent = byId.get(id);
    return parent?._type === "request_group" ? [...folders(parent.parentId), parent.name] : [];
  };
  const requests = doc.resources
    .filter((x: J) => x._type === "request")
    .map((x: J) => {
      const r = newRequest({ title: [...folders(x.parentId), x.name].filter(Boolean).join(" / "), method: str(x.method || "GET").toUpperCase(), url: insomniaVars(x.url) });
      r.headers = (x.headers ?? []).filter((h: J) => h.name).map((h: J) => ({ name: h.name, value: insomniaVars(h.value), enabled: !h.disabled }));
      const auth = x.authentication ?? {};
      if (!auth.disabled && auth.type === "bearer") r.headers.push({ name: "Authorization", value: `${auth.prefix || "Bearer"} ${insomniaVars(auth.token)}`, enabled: true });
      if (!auth.disabled && auth.type === "basic") r.headers.push({ name: "Authorization", value: `Basic ${insomniaVars(auth.username)} ${insomniaVars(auth.password)}`, enabled: true });
      const body = x.body ?? {};
      const type = str(body.mimeType);
      if (type === "application/graphql") {
        let g: J = {};
        try {
          g = JSON.parse(body.text);
        } catch {
          g = { query: body.text };
        }
        r.method = "GRAPHQL";
        r.body = str(g.query).trim() + (g.variables && Object.keys(g.variables).length ? `\n\n${JSON.stringify(g.variables, null, 2)}` : "");
        r.headers = r.headers.filter((h) => h.name.toLowerCase() !== "content-type");
      } else if (type === "multipart/form-data") {
        r.headers = r.headers.filter((h) => h.name.toLowerCase() !== "content-type");
        r.headers.push({ name: "Content-Type", value: `multipart/form-data; boundary=${BOUNDARY}`, enabled: true });
        r.body = multipart(on(body.params).map((p: J) => (p.type === "file" ? { name: p.name, file: str(p.fileName) } : { name: p.name, value: insomniaVars(p.value) })));
      } else if (type === "application/x-www-form-urlencoded") r.body = on(body.params).map((p: J) => `${p.name}=${insomniaVars(p.value)}`).join("&");
      else if (body.fileName) r.body = `< ${body.fileName}`;
      else if (body.text) r.body = insomniaVars(body.text);
      if (type && type !== "application/graphql" && type !== "multipart/form-data") setHeader(r, "Content-Type", type);
      return r;
    });
  // The base environment applies to every other one, as $shared does.
  const env: Environments = {};
  const workspaces = new Set(doc.resources.filter((x: J) => x._type === "workspace").map((x: J) => x._id));
  for (const e of doc.resources.filter((x: J) => x._type === "environment")) {
    const name = workspaces.has(e.parentId) ? "$shared" : e.name;
    env[name] = { ...env[name], ...flatten(e.data) };
  }
  const name = doc.resources.find((x: J) => x._type === "workspace")?.name ?? "insomnia";
  return file(name, [`# Imported from the Insomnia workspace ${name}.`], [], requests, env);
}

// ---- OpenAPI and Swagger ----

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];

function fromOpenApi(doc: J): Imported {
  const at = (ref: string) => ref.replace(/^#\//, "").split("/").reduce((o: J, k) => o?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], doc);
  const deref = (x: J, seen = new Set<string>()): J => (x?.$ref && !seen.has(x.$ref) ? (seen.add(x.$ref), deref(at(x.$ref), seen)) : x);
  /** An example value for a schema: its example or default, or a skeleton of its type. `refs` stops cycles. */
  const example = (schema: J, refs: string[] = []): unknown => {
    if (!schema) return null;
    if (schema.$ref) return refs.includes(schema.$ref) ? null : example(at(schema.$ref), [...refs, schema.$ref]);
    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    if (schema.enum?.length) return schema.enum[0];
    if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s: J) => example(s, refs)).filter((o: unknown) => o && typeof o === "object" && !Array.isArray(o)));
    const alt = schema.oneOf ?? schema.anyOf;
    if (alt?.length) return example(alt[0], refs);
    const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== "null") : schema.type;
    if (type === "object" || schema.properties)
      return Object.fromEntries(
        Object.entries(schema.properties ?? {})
          .filter(([, s]) => !deref(s)?.readOnly)
          .map(([k, s]) => [k, example(s, refs)]),
      );
    if (type === "array") return schema.items ? [example(schema.items, refs)] : [];
    if (type === "integer" || type === "number") return 0;
    if (type === "boolean") return false;
    if (type === "string") return schema.format === "uuid" ? "{{$uuid}}" : schema.format === "date-time" ? "{{$isoTimestamp}}" : schema.format === "email" ? "{{$random.email}}" : "";
    return null;
  };
  const paramValue = (p: J) => {
    const first = p.examples && Object.values(p.examples)[0];
    const v = p.example ?? deref(first)?.value ?? p.schema?.example ?? p.schema?.default ?? p.default ?? p.schema?.enum?.[0] ?? p.enum?.[0];
    return v === undefined ? "" : str(v);
  };
  // Swagger 2 names the server with host and basePath; OpenAPI 3 with servers, whose {variables} take their defaults.
  const s0 = doc.servers?.[0];
  let server = doc.swagger ? (doc.host ? `${doc.schemes?.[0] ?? "https"}://${doc.host}` : "") + (doc.basePath ?? "") : str(s0?.url);
  server = server.replace(/\{(\w+)\}/g, (_, v) => str(s0?.variables?.[v]?.default) || `{{${v}}}`).replace(/\/+$/, "");
  const absolute = /^https?:\/\//.test(server);
  const schemes = doc.components?.securitySchemes ?? doc.securityDefinitions ?? {};
  const requests: HttpRequest[] = [];
  for (const [path, item] of Object.entries<J>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (!op) continue;
      // An operation's parameter replaces the path's with the same name and place.
      const params = new Map<string, J>();
      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])].map((x) => deref(x))) if (p?.name) params.set(`${p.in}:${p.name}`, p);
      const list = [...params.values()];
      const query = list.filter((p) => p.in === "query").map((p) => `${p.name}=${paramValue(p)}`);
      const title = `${op.tags?.[0] ? `[${op.tags[0]}] ` : ""}${op.summary || op.operationId || `${method.toUpperCase()} ${path}`}`;
      const r = newRequest({
        title,
        method: method.toUpperCase(),
        url: `{{host}}${absolute ? "" : server}${path.replace(/\{([^}]+)\}/g, "{{$1}}")}${query.length ? `?${query.join("&")}` : ""}`,
        headers: list.filter((p) => p.in === "header").map((p) => ({ name: p.name, value: paramValue(p) || `{{${p.name}}}`, enabled: true })),
      });
      if (op.operationId && op.operationId !== title) r.tags.name = op.operationId;
      for (const requirement of op.security ?? doc.security ?? []) {
        const scheme = schemes[Object.keys(requirement)[0]];
        if ((scheme?.type === "http" && /bearer/i.test(scheme.scheme)) || scheme?.type === "oauth2" || scheme?.type === "openIdConnect") setHeader(r, "Authorization", "Bearer {{token}}");
        else if (scheme?.type === "http" && /basic/i.test(scheme.scheme)) setHeader(r, "Authorization", "Basic {{user}} {{password}}");
        else if (scheme?.type === "apiKey" && scheme.in === "header") setHeader(r, scheme.name, `{{${scheme.name.replace(/[^\w.-]/g, "_")}}}`);
        else continue;
        break;
      }
      // The body: OpenAPI 3's requestBody, or Swagger 2's body or formData parameters.
      let type = "";
      let value: unknown;
      if (doc.swagger) {
        const body = list.find((p) => p.in === "body");
        const form = list.filter((p) => p.in === "formData");
        const consumes: string[] = op.consumes ?? doc.consumes ?? [];
        if (body) (type = consumes.find((c) => /json/.test(c)) ?? consumes[0] ?? "application/json"), (value = example(body.schema));
        else if (form.length) {
          type = form.some((p) => p.type === "file") || consumes.some((c) => /multipart/.test(c)) ? "multipart/form-data" : "application/x-www-form-urlencoded";
          value = Object.fromEntries(form.map((p) => [p.name, paramValue(p)]));
        }
      } else {
        const content = deref(op.requestBody)?.content ?? {};
        type = Object.keys(content).find((c) => /json/.test(c)) ?? Object.keys(content)[0] ?? "";
        const media = content[type];
        const first = media?.examples && Object.values(media.examples)[0];
        value = media?.example ?? deref(first)?.value ?? example(media?.schema);
      }
      if (type) {
        if (/multipart/.test(type)) {
          r.headers.push({ name: "Content-Type", value: `multipart/form-data; boundary=${BOUNDARY}`, enabled: true });
          r.body = multipart(Object.entries((value as object) ?? {}).map(([name, v]) => ({ name, value: str(v) })));
        } else {
          r.headers.push({ name: "Content-Type", value: type, enabled: true });
          r.body = /x-www-form-urlencoded/.test(type) ? Object.entries((value as object) ?? {}).map(([k, v]) => `${k}=${str(v)}`).join("&") : /json/.test(type) ? JSON.stringify(value ?? {}, null, 2) : str(value);
        }
      }
      requests.push(r);
    }
  }
  const name = doc.info?.title ?? "openapi";
  return file(name, [`# Imported from the ${doc.swagger ? "Swagger" : "OpenAPI"} document ${name}${doc.info?.version ? ` ${doc.info.version}` : ""}.`], [], requests, absolute ? { local: { host: server } } : {});
}

// ---- Export to OpenAPI ----

/**
 * An OpenAPI 3.0 document for requests: a path per URL, with {{variables}} in the path as path parameters, the query
 * as query parameters, and JSON and form bodies as examples. `### [tag] summary` titles give the tag. The first
 * request to a method and path wins.
 */
export function toOpenApi(requests: HttpRequest[], title: string, server?: string): object {
  const paths: J = {};
  const ids = new Set<string>();
  let bearer = false;
  for (const r of requests) {
    if (r.method === "WEBSOCKET") continue;
    const method = r.method === "GRAPHQL" ? "post" : r.method.toLowerCase();
    const [rawPath, query = ""] = r.url
      .replace(/^\{\{[^}]+\}\}/, "")
      .replace(/^https?:\/\/[^/]+/, "")
      .split("#")[0]
      .split("?");
    const path = `/${rawPath.replace(/^\/+/, "").replace(/\{\{\s*([\w.-]+)\s*\}\}/g, "{$1}")}`;
    if (paths[path]?.[method]) continue;
    const parameters: J[] = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    for (const pair of query.split("&").filter(Boolean)) {
      const [name, value = ""] = [pair.split("=")[0], pair.slice(pair.indexOf("=") + 1)];
      parameters.push({ name, in: "query", schema: { type: "string" }, ...(pair.includes("=") && value && !value.includes("{{") ? { example: decodeURIComponentSafe(value) } : {}) });
    }
    const [, tag, summary] = r.title.match(/^\[([^\]]+)\]\s*(.*)$/) ?? [null, null, r.title];
    const op: J = { ...(tag ? { tags: [tag] } : {}), summary: summary || `${r.method} ${path}`, responses: { default: { description: "Response" } } };
    const id = r.tags.name?.replace(/[^\w.-]+/g, "_");
    if (id && !ids.has(id)) ids.add(id), (op.operationId = id);
    if (parameters.length) op.parameters = parameters;
    if (/^Bearer\s/i.test(header(r, "authorization") ?? "")) (op.security = [{ bearerAuth: [] }]), (bearer = true);
    const type = r.method === "GRAPHQL" ? "application/json" : (header(r, "content-type") ?? (/^\s*[{[]/.test(r.body) ? "application/json" : "text/plain"));
    if (r.body && !/^<@?\s/.test(r.body.trim())) {
      let example: unknown = r.body;
      if (r.method === "GRAPHQL") example = { query: r.body };
      else if (/json/.test(type)) {
        try {
          // {{name}} outside a string isn't JSON, so it's quoted for the example.
          example = JSON.parse(r.body.replace(/("(?:[^"\\]|\\.)*")|\{\{[^}]*\}\}/g, (m, s) => s ?? JSON.stringify(m)));
        } catch {
          // Keep the text.
        }
      } else if (/x-www-form-urlencoded/.test(type)) example = Object.fromEntries(r.body.split("&").map((p) => [p.split("=")[0], decodeURIComponentSafe(p.slice(p.indexOf("=") + 1))]));
      op.requestBody = { content: { [type.split(";")[0].trim()]: { example } } };
    }
    (paths[path] ??= {})[method] = op;
  }
  return {
    openapi: "3.0.3",
    info: { title, version: "1.0.0" },
    ...(server ? { servers: [{ url: server }] } : {}),
    paths,
    ...(bearer ? { components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } } } : {}),
  };
}

function decodeURIComponentSafe(s: string) {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

// ---- JUnit reports ----

/** A request the runner sent: its status (0 when there's no response), curl's error, and its client.test results. */
export type ReportCase = { name: string; seconds: number; status: number; error?: string; tests: { name: string; passed: boolean; message?: string }[] };

const xml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

/** Why a request failed, or "" when it passed: a status of 400 or more, no response, or a failed test. */
export function failureOf(c: ReportCase): string {
  const reasons = [c.error, !c.status && !c.error ? "No response" : "", c.status >= 400 ? `Status ${c.status}` : "", ...c.tests.filter((t) => !t.passed).map((t) => `Test failed: ${t.name}${t.message ? `: ${t.message}` : ""}`)];
  return reasons.filter(Boolean).join("\n");
}

/** JUnit XML: a test suite per .http file and a test case per request, with its tests' results in a failure's text. */
export function junitReport(suites: { name: string; cases: ReportCase[] }[]): string {
  const count = (cases: ReportCase[]) => cases.filter((c) => failureOf(c)).length;
  const time = (cases: ReportCase[]) => cases.reduce((a, c) => a + c.seconds, 0).toFixed(3);
  const all = suites.flatMap((s) => s.cases);
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuites name="HTTP requests" tests="${all.length}" failures="${count(all)}" time="${time(all)}">`];
  for (const s of suites) {
    out.push(`  <testsuite name="${xml(s.name)}" tests="${s.cases.length}" failures="${count(s.cases)}" errors="0" time="${time(s.cases)}">`);
    for (const c of s.cases) {
      const failure = failureOf(c);
      const open = `    <testcase classname="${xml(s.name)}" name="${xml(c.name)}" time="${c.seconds.toFixed(3)}"`;
      if (!failure) {
        out.push(`${open}/>`);
        continue;
      }
      const details = [failure, ...c.tests.map((t) => `${t.passed ? "Passed" : "Failed"}: ${t.name}${t.message ? ` (${t.message})` : ""}`)].join("\n");
      out.push(`${open}>`, `      <failure message="${xml(failure.split("\n")[0])}">${xml(details)}</failure>`, "    </testcase>");
    }
    out.push("  </testsuite>");
  }
  out.push("</testsuites>");
  return out.join("\n") + "\n";
}
