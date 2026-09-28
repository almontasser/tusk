// The HTTP client's Laravel tools: feature tests from requests, the Logs and Queries response tabs, and finding the
// app's address. laraveltools.ts has the parts Node tests. This module only defines functions, so importing
// httpview, which imports it back, is safe.
import { withProgress } from "./status";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { groupQueries, withBindings } from "./cachegrind";
import { dotenv, ENV_FILE, environmentDir, environments, type Environments, type Exchange, history, host, prepareRequest, requestAt, selectedEnvironment, setEnvironment } from "./httpclient";
import { type HttpRequest, redact } from "./httpfile";
import { h, iconButton, localPath } from "./httpview";
import { type Address, addTest, appAddresses as rankAddresses, featureTest, featureTestFile, fileReferences, parseLaravelLog, phpPorts, requestPath, testFileName } from "./laraveltools";
import { pick } from "./palette";

const ms = (t: number) => `${t < 10 ? t.toFixed(2) : Math.round(t)} ms`;

// ---- Feature tests ----

/** A request's last exchange: the one shown, when it's that request's, or else the newest in the history. */
export async function lastExchange(path: string, r: HttpRequest, shown: Exchange | null) {
  const same = (x: Exchange) => x.path === path && (r.name ? x.name === r.name : x.line === r.line);
  return shown && same(shown) ? shown : (await history()).find(same);
}

async function usesPest() {
  const root = host.root();
  if (await invoke<boolean>("path_exists", { path: `${root}/vendor/pestphp/pest` })) return true;
  return (await invoke<string>("read_file", { path: `${root}/composer.json` }).catch(() => "")).includes('"pestphp/pest"');
}

/** Asks for a file in tests/Feature and writes a Pest or PHPUnit test there that sends the request and checks its response. */
export async function generateFeatureTest(x: Exchange | undefined) {
  const final = x?.heads.at(-1);
  if (!x || !final) return host.status("Send the request first: the test checks its last response.");
  // The history file keeps no secrets, so an exchange read from it gets its request prepared again from the file.
  let request = x.request;
  if (x.secrets) {
    const found = await requestAt(x.path, x.line).catch(() => null);
    if (found?.request) request = (await prepareRequest(x.path, found.request)).prepared;
  }
  const pest = await usesPest();
  const body = /json/i.test(x.contentType) ? await invoke<string>("read_file", { path: x.bodyPath }).catch(() => "") : "";
  const suggested = testFileName(requestPath(request.url)).replace(/\.php$/, "");
  const write = async (name: string) => {
    const path = `${host.root()}/tests/Feature/${name}.php`;
    const exists = await invoke<boolean>("path_exists", { path });
    const model = exists ? await host.ensureModel(path) : null;
    const test = featureTest({ request, status: final.status, contentType: x.contentType, body, name: x.name || `${request.method} ${requestPath(request.url)}`, pest, existing: model?.getValue() });
    let line: number;
    if (model) {
      const added = addTest(model.getValue(), test, pest);
      const clean = !host.isDirty(path);
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: added.text }], () => null);
      // Saved, unless it had unsaved edits of yours.
      if (clean) await host.save(path);
      line = added.line;
    } else {
      const text = featureTestFile(name, test, pest);
      await invoke("create_file", { path, contents: text });
      line = text.slice(0, text.indexOf(test)).split("\n").length;
    }
    await host.openAt(path, line);
    host.status(`${exists ? "Added a test to" : "Created"} tests/Feature/${name}.php`);
  };
  pick(
    `Feature test file in tests/Feature (${pest ? "Pest" : "PHPUnit"}). An existing file gets the test added.`,
    (q) => {
      const name = (q.trim() || suggested).replace(/\.php$/, "").replace(/\W+/g, "");
      return name ? [{ label: `tests/Feature/${name}.php`, detail: `${request.method} ${requestPath(redact(request).url)} · ${final.status}`, icon: "codicon-beaker", run: () => write(name) }] : [];
    },
    0,
    { value: suggested, select: [0, suggested.length] },
  );
}

// ---- The Logs tab ----

export const logCount = (x: Exchange) => parseLaravelLog(x.appLog ?? "").length;

/** Text with each PHP file:line reference as a link that opens it. */
function linked(text: string) {
  const parts: (string | Node)[] = [];
  let at = 0;
  for (const ref of fileReferences(text)) {
    const path = localPath(ref.file);
    parts.push(text.slice(at, ref.index), h("button", { class: "link", textContent: text.slice(ref.index, ref.index + ref.length), onclick: () => host.openAt(path, ref.line) }));
    at = ref.index + ref.length;
  }
  parts.push(text.slice(at));
  return parts;
}

/** What Laravel logged while the request ran, each entry with its level, message, and a stack trace to open. */
export function logsView(x: Exchange) {
  const pane = h("div", { class: "http-pane" });
  const entries = parseLaravelLog(x.appLog ?? "");
  if (!x.appLog) return pane.append(h("p", { class: "http-hint" }, "Laravel logged nothing while the request ran. Entries it writes to storage/logs show here.")), pane;
  // A custom log format: show it as it is.
  if (!entries.length) return pane.append(h("pre", { class: "http-log" }, ...linked(x.appLog))), pane;
  for (const e of entries) {
    const own = fileReferences(e.detail).find((r) => !/\/vendor\//.test(r.file));
    pane.append(
      h(
        "div",
        { class: `http-app-log ${e.level}` },
        h(
          "div",
          { class: "http-app-log-head" },
          h("span", { class: "http-app-log-level" }, e.level),
          h("span", { class: "http-app-log-message" }, e.message),
          own ? h("button", { class: "link", textContent: `${localPath(own.file).replace(host.root() + "/", "")}:${own.line}`, onclick: () => host.openAt(localPath(own.file), own.line) }) : null,
          h("span", { class: "muted" }, e.time.slice(11)),
        ),
        e.detail ? h("details", {}, h("summary", {}, /\[stacktrace\]/.test(e.detail) ? "Stack trace" : "Details"), h("pre", { class: "http-log" }, ...linked(e.detail))) : null,
      ),
    );
  }
  return pane;
}

// ---- The Queries tab ----

/** The queries a profiled request ran, grouped by SQL with duplicates flagged, and each run's bindings and time. */
export function queriesView(x: Exchange) {
  const pane = h("div", { class: "http-pane" });
  if (!x.queries) return pane.append(h("p", { class: "http-hint" }, "Send with Profiler to see the queries this request ran.")), pane;
  if (!x.queries.length) return pane.append(h("p", { class: "http-hint" }, "The request ran no queries through Laravel's database connection.")), pane;
  const groups = groupQueries(x.queries);
  const flagged = groups.filter((g) => g.kind).length;
  pane.append(h("p", { class: "http-hint" }, `${x.queries.length} ${x.queries.length === 1 ? "query" : "queries"} · ${ms(x.queries.reduce((t, q) => t + q.time, 0))}${flagged ? ` · ${flagged} repeated` : ""}. Slowest first.`));
  for (const g of groups)
    pane.append(
      h(
        "details",
        { class: "http-query" },
        h(
          "summary",
          { title: g.kind === "duplicate" ? "The same query with the same bindings ran more than once." : g.kind === "repeated" ? "The same query ran with different bindings, often once per item in a loop (an N+1 query)." : "" },
          g.kind ? h("span", { class: `query-flag ${g.kind}` }, g.kind) : null,
          h("code", { class: "http-query-sql" }, g.sql),
          h("span", { class: "muted" }, `${g.runs.length}×`),
          h("span", { class: "http-query-time" }, ms(g.time)),
          iconButton("copy", "Copy with bindings", () => navigator.clipboard.writeText(withBindings(g.runs[0])).then(() => host.status("Copied the query"))),
        ),
        ...g.runs.slice(0, 100).map((run) => h("div", { class: "http-query-run", title: withBindings(run) }, h("span", {}, run.bindings.join(", ") || "No bindings"), h("span", { class: "muted" }, ms(run.time)))),
      ),
    );
  return pane;
}

// ---- The app's address ----

/** Where the app might answer, best first, from Sail's settings, Herd's or Valet's sites, PHP servers, and .env. */
export async function appAddresses(): Promise<Address[]> {
  const root = host.root();
  const read = (path: string) => invoke<string>("read_file", { path }).catch(() => null);
  let compose: string | null = null;
  for (const file of ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"]) if ((compose = await read(`${root}/${file}`)) !== null) break;
  const home = await homeDir();
  let valet: Parameters<typeof rankAddresses>[0]["valet"] = null;
  for (const [dir, app] of [[`${home}/Library/Application Support/Herd/config/valet`, "Herd"], [`${home}/.config/valet`, "Valet"]]) {
    let config: { tld?: string; paths?: string[] };
    try {
      config = JSON.parse((await read(`${dir}/config.json`)) ?? "");
    } catch {
      continue;
    }
    // Linked sites are symbolic links in Sites; secured ones have a certificate.
    const out = await invoke<string>("run_capture", { cwd: dir, program: "/bin/sh", args: ["-c", 'for f in Sites/*; do [ -L "$f" ] && printf "%s\\t%s\\n" "${f#Sites/}" "$(readlink "$f")"; done; ls Certificates 2>/dev/null; true'], input: null, any_status: true }).catch(() => "");
    const lines = out.split("\n");
    valet = { tld: config.tld ?? "test", paths: config.paths ?? [], links: lines.filter((l) => l.includes("\t")).map((l) => l.split("\t") as [string, string]), secured: lines.filter((l) => l.endsWith(".crt")).map((l) => l.slice(0, -4)), app };
    break;
  }
  const lsof = await invoke<string>("run_capture", { cwd: "/", program: "/usr/sbin/lsof", args: ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fcn"], input: null, any_status: true }).catch(() => "");
  return rankAddresses({ root, env: await dotenv(), compose, valet, phpPorts: phpPorts(lsof) });
}

/** Lists where the app might answer and sets the one you choose as `host` in the selected environment. */
export async function detectAppAddress(path = "") {
  if (!host.root()) return;
  const found = await withProgress("Looking for the app's address…", () => Promise.all([appAddresses(), environments(path)]), { error: "Can't look for the app's address" });
  if (!found) return;
  const [list, envs] = found;
  const env = selectedEnvironment(envs) ?? "local";
  pick(`Set host in the ${env} environment`, () =>
    list.map((a) => ({ label: a.url, detail: `${a.source}${envs[env]?.host === a.url ? " · Current" : ""}`, icon: "codicon-globe", run: () => saveHost(path, env, a.url) })),
  );
}

/** Writes `host` into an environment in the shared environment file, creating the file when needed. */
async function saveHost(path: string, env: string, url: string) {
  const file = `${path ? await environmentDir(path) : host.root()}/${ENV_FILE}`;
  const text = await invoke<string>("read_file", { path: file }).catch(() => null);
  let all: Environments = {};
  try {
    if (text !== null) all = JSON.parse(text);
  } catch {
    return host.status(`Can't set host: ${ENV_FILE} isn't valid JSON.`);
  }
  all[env] = { ...all[env], host: url };
  await invoke("write_file", { path: file, contents: JSON.stringify(all, null, 2) + "\n" });
  setEnvironment(env);
  host.status(`Set host to ${url} in the ${env} environment`);
}
