// The HTTP client's collection runner, which sends every request in a file in order; its stress test, which sends
// one request many times at once with curl's parallel mode and shows live statistics; and its monitor.
import { invoke } from "@tauri-apps/api/core";
import { save } from "./platform.ts";
import { cacheDir, type Cancel, cookieJar, type Exchange, host, prepareRequest, probe, send, spawnStreaming } from "./httpclient";
import { histogram, type HttpRequest, loadArgs, overBudget, parseHttp, parseSample, type Prepared, type Sample, summarize } from "./httpfile";
import { junitReport, type ReportCase } from "./httpimport";
import { projectValue, setProjectValue } from "./projectstate";
import { bytes, h, httpFiles, icon, openExchange, setRunners, showHttpPanel } from "./httpview";

const ms = (s: number) => (s < 1 ? `${(s * 1000).toFixed(s < 0.01 ? 1 : 0)} ms` : `${s.toFixed(2)} s`);
const statusClass = (code: number) => (!code || code >= 500 ? "bad" : code >= 400 ? "warn" : code >= 300 ? "redirect" : "good");

// ---- Runner ----

const runner = h("div", { class: "http-client http-runner" });
let stopRun = false;

const runFile = (path: string) => runFiles([path]);

/** Runs every request in the project's .http files, file by file. */
export async function runAllRequests() {
  const files = (await httpFiles()).sort();
  if (!files.length) return host.status("There are no .http files in the project.");
  runFiles(files);
}

async function runFiles(paths: string[]) {
  const relative = (p: string) => p.replace(host.root() + "/", "");
  const models = await Promise.all(paths.map((p) => host.ensureModel(p)));
  const requests = paths.flatMap((path, f) => parseHttp(models[f].getValue()).requests.map((r) => ({ path, model: models[f], r })));
  stopRun = false;
  const rows = h("tbody");
  const summary = h("span", { class: "muted" });
  const stop = h("button", { textContent: "Stop", onclick: () => (stopRun = true) });
  const suites: { name: string; cases: ReportCase[] }[] = [];
  const report = h("button", { textContent: "Save Report…", title: "Save the results as JUnit XML, which CI servers read", onclick: () => saveReport(suites) });
  runner.replaceChildren(
    h("div", { class: "http-bar" }, h("strong", {}, `Running ${paths.length === 1 ? relative(paths[0]) : `${paths.length} files`}`), summary, h("span", { class: "http-spacer" }), stop, report, h("button", { textContent: "Run Again", onclick: () => runFiles(paths) })),
    h("div", { class: "http-runner-list" }, h("table", { class: "http-table http-runner-table" }, h("thead", {}, h("tr", {}, ...["", "Request", "Status", "Time", "Tests"].map((t) => h("th", { textContent: t })))), rows)),
  );
  showHttpPanel("HTTP Runner", runner);
  let passed = 0;
  let failed = 0;
  const started = performance.now();
  for (const [i, { path, model, r }] of requests.entries()) {
    if (stopRun) break;
    // A test suite per file in the report, and a heading per file in the table.
    if (suites.at(-1)?.name !== relative(path)) {
      suites.push({ name: relative(path), cases: [] });
      if (paths.length > 1) rows.append(h("tr", { class: "http-runner-file" }, h("td", { colSpan: 5 }, relative(path))));
    }
    const suite = suites.at(-1)!;
    const name = `${r.method} ${r.title || r.name || r.url}`;
    // A WebSocket request is a conversation, not one response, so it doesn't run here.
    if (r.method === "WEBSOCKET") {
      rows.append(h("tr", {}, h("td", {}, icon("circle-slash")), h("td", {}, name), h("td", { class: "muted" }, "Skipped: connect to it from the HTTP tab"), h("td"), h("td")));
      continue;
    }
    const state = h("td", {}, icon("loading codicon-modifier-spin"));
    const row = h("tr", {}, state, h("td", {}, name), h("td"), h("td"), h("td"));
    rows.append(row);
    summary.textContent = `${i + 1} of ${requests.length}`;
    // Requests later in the file run against the line they had when the run started; edits during a run shift them.
    const fresh = parseHttp(model.getValue()).requests.find((q) => q.line === r.line) ?? r;
    let x: Exchange;
    try {
      x = await send(path, fresh);
    } catch (e) {
      state.replaceChildren(icon("error"));
      row.cells[2].textContent = String(e);
      suite.cases.push({ name, seconds: 0, status: 0, error: String(e), tests: [] });
      failed++;
      continue;
    }
    const final = x.heads.at(-1);
    const slow = overBudget(x.request, x.info?.time_total);
    suite.cases.push({ name, seconds: x.info?.time_total ?? 0, status: final?.status ?? 0, error: x.error ?? (slow ? `Over budget: ${Math.round((x.info?.time_total ?? 0) * 1000)} ms > ${x.request.budget} ms` : undefined), tests: x.tests });
    const ok = !x.error && !!final && final.status < 400 && x.tests.every((t) => t.passed) && !slow;
    ok ? passed++ : failed++;
    state.replaceChildren(icon(ok ? "pass" : "error"));
    state.className = ok ? "good" : "bad";
    row.cells[2].replaceChildren(h("span", { class: `http-code-badge ${statusClass(final?.status ?? 0)}` }, final ? String(final.status) : "ERR"), x.error ? ` ${x.error}` : "");
    row.cells[3].textContent = x.info ? `${ms(x.info.time_total)}${slow ? ` (over ${x.request.budget} ms)` : ""}` : "";
    row.cells[4].textContent = x.tests.length ? `${x.tests.filter((t) => t.passed).length}/${x.tests.length}` : "";
    row.onclick = () => openExchange(x);
    row.title = "Show the response";
  }
  stop.disabled = true;
  summary.textContent = `${passed} passed, ${failed} failed${stopRun ? ", stopped" : ""} · ${ms((performance.now() - started) / 1000)}`;
  summary.className = failed ? "bad" : "good";
}

/** Saves the run's results as JUnit XML, a test case per request. */
async function saveReport(suites: { name: string; cases: ReportCase[] }[]) {
  const to = await save({ defaultPath: `${host.root()}/http-report.xml`, filters: [{ name: "JUnit XML", extensions: ["xml"] }] });
  if (to) await invoke("write_file", { path: to, contents: junitReport(suites) }).then(() => host.status(`Saved ${to}`), (e) => host.status(`Couldn't save the report: ${e}`));
}

// ---- Stress test ----

const load = h("div", { class: "http-client http-load" });
let active: { kill(): void; timer?: ReturnType<typeof setTimeout>; stopped: boolean } | null = null;
/** Concurrency levels a ramp-up steps through, up to the maximum you choose. */
const RAMP = [1, 2, 5, 10, 20, 50, 100, 200, 500];

function stopLoad() {
  if (!active) return;
  active.stopped = true;
  clearTimeout(active.timer);
  active.kill();
}

const tile = (label: string, value: string, className = "") => h("div", { class: `http-tile ${className}` }, h("span", { class: "http-tile-value" }, value), h("span", { class: "http-tile-label" }, label));

async function loadTest(path: string, request: HttpRequest) {
  const title = `${request.method} ${request.title || request.url}`;
  type Saved = { mode: string; count: number; seconds: number; step?: number; concurrency: number };
  const saved: Saved = { mode: "count", count: 200, seconds: 10, concurrency: 10, ...projectValue<Saved>("httpLoadTest") };
  saved.step ??= 5;
  const mode = h("select", { title: "Send a number of requests, send for a number of seconds, or ramp concurrency up step by step" }, h("option", { value: "count", textContent: "Requests" }), h("option", { value: "seconds", textContent: "Seconds" }), h("option", { value: "ramp", textContent: "Ramp up, seconds per step" }));
  mode.value = saved.mode;
  const valueFor = (m: string) => String(m === "count" ? saved.count : m === "seconds" ? saved.seconds : saved.step);
  const amount = h("input", { type: "number", min: "1", value: valueFor(saved.mode), class: "http-number" });
  const concurrency = h("input", { type: "number", min: "1", max: "500", value: String(saved.concurrency), class: "http-number" });
  const concurrencyLabel = h("label", { class: "muted" }, saved.mode === "ramp" ? "Up to" : "Concurrency");
  mode.onchange = () => ((amount.value = valueFor(mode.value)), (concurrencyLabel.textContent = mode.value === "ramp" ? "Up to" : "Concurrency"));
  const start = h("button", { class: "primary http-send" }, icon("play"), "Start");
  const stop = h("button", { textContent: "Stop", disabled: true, onclick: stopLoad });
  const results = h(
    "div",
    { class: "http-load-results" },
    h("p", { class: "http-hint" }, "Sends the request many times at once and measures how the server holds up. A ramp-up steps through 1, 2, 5, 10, 20, 50… requests at a time, to show where response times start to climb. Scripts don't run, and cookies kept for the environment are sent. Only test servers you're allowed to load."),
  );
  load.replaceChildren(h("div", { class: "http-bar" }, h("strong", { class: "http-load-title", title }, title), h("span", { class: "http-spacer" }), mode, amount, concurrencyLabel, concurrency, start, stop), results);
  showHttpPanel("Stress Test", load);
  start.onclick = async () => {
    if (active) return;
    const n = Math.max(1, Math.floor(Number(amount.value) || 1));
    const c = Math.max(1, Math.min(500, Math.floor(Number(concurrency.value) || 1)));
    Object.assign(saved, { mode: mode.value, concurrency: c, [mode.value === "count" ? "count" : mode.value === "seconds" ? "seconds" : "step"]: n });
    setProjectValue("httpLoadTest", { ...saved }).catch((e) => host.status(`Can't save the stress test settings: ${e instanceof Error ? e.message : e}`));
    const fresh = parseHttp((await host.ensureModel(path)).getValue()).requests.find((q) => q.line === request.line) ?? request;
    start.disabled = true;
    stop.disabled = false;
    try {
      const prepared = await loadable(path, fresh);
      if (mode.value === "ramp") await ramp(path, prepared, n, c, results);
      else {
        const count = mode.value === "count" ? n : 10_000_000;
        const seconds = mode.value === "seconds" ? n : 0;
        await burst(path, prepared, count, seconds, c, (samples, perSecond, elapsed) => render(results, samples, perSecond, elapsed, count, seconds, c));
      }
    } catch (e) {
      results.replaceChildren(h("p", { class: "http-error" }, String(e)));
    } finally {
      start.disabled = false;
      stop.disabled = true;
    }
  };
}

/** The request prepared for repeating: every request reads the body, so a text body goes in a file. */
async function loadable(path: string, request: HttpRequest): Promise<{ prepared: Prepared; jar?: string }> {
  let { prepared, env } = await prepareRequest(path, request);
  if (prepared.body !== undefined) {
    const file = `${await cacheDir("http-scratch")}/load-body`;
    await invoke("create_dir", { path: file.slice(0, file.lastIndexOf("/")) }).catch(() => {});
    await invoke("write_file", { path: file, contents: prepared.body });
    prepared = { ...prepared, body: undefined, bodyFile: file };
  }
  const jar = await cookieJar(env);
  return { prepared, jar: (await invoke<boolean>("path_exists", { path: jar })) ? jar : undefined };
}

/** Sends `count` requests (or for `seconds`), `concurrency` at a time, calling `update` with the results as they come. */
async function burst(path: string, { prepared, jar }: { prepared: Prepared; jar?: string }, count: number, seconds: number, concurrency: number, update: (samples: Sample[], perSecond: number[], elapsed: number) => void) {
  const samples: Sample[] = [];
  /** Requests finished in each second since the start. */
  const perSecond: number[] = [];
  const began = performance.now();
  const elapsed = () => (performance.now() - began) / 1000;
  let buffer = "";
  const run = await spawnStreaming(path.slice(0, path.lastIndexOf("/")), ["/usr/bin/curl", ...loadArgs(prepared, count, concurrency, jar)], (text) => {
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const s = parseSample(line);
      if (!s) continue;
      samples.push(s);
      const second = Math.floor(elapsed());
      perSecond[second] = (perSecond[second] ?? 0) + 1;
    }
  });
  active = { kill: run.kill, stopped: false };
  if (seconds) active.timer = setTimeout(stopLoad, seconds * 1000);
  const ticker = setInterval(() => update(samples, perSecond, elapsed()), 250);
  await run.exited;
  clearInterval(ticker);
  clearTimeout(active.timer);
  const stopped = active.stopped;
  active = null;
  update(samples, perSecond, elapsed());
  return { samples, elapsed: elapsed(), stopped };
}

async function ramp(path: string, request: { prepared: Prepared; jar?: string }, stepSeconds: number, max: number, results: HTMLElement) {
  const levels = [...RAMP.filter((c) => c < max), max];
  const steps: { concurrency: number; summary: ReturnType<typeof summarize> }[] = [];
  const live = h("div", {});
  const draw = () =>
    results.replaceChildren(
      h("div", { class: "http-progress" }, h("span", { style: `width:${(steps.length / levels.length) * 100}%` })),
      live,
      h(
        "div",
        { class: "http-charts" },
        chart("Requests per second at each concurrency", steps.map((st) => ({ label: String(st.concurrency), value: st.summary.rps, tip: `${st.concurrency} at a time: ${st.summary.rps.toFixed(1)} requests per second` })), (v) => v.toFixed(0)),
        chart("95th percentile response time at each concurrency", steps.map((st) => ({ label: String(st.concurrency), value: st.summary.p95, tip: `${st.concurrency} at a time: 95% took ${ms(st.summary.p95)} or less`, bad: st.summary.failed > 0 })), (v) => ms(v)),
        h(
          "div",
          { class: "http-chart" },
          h("h4", {}, "Steps"),
          h(
            "table",
            { class: "http-table" },
            h("thead", {}, h("tr", {}, ...["At a time", "Req/s", "Median", "95th", "Failed"].map((t) => h("th", { textContent: t })))),
            h("tbody", {}, ...steps.map((st) => h("tr", {}, h("td", {}, String(st.concurrency)), h("td", {}, st.summary.rps.toFixed(1)), h("td", {}, ms(st.summary.p50)), h("td", {}, ms(st.summary.p95)), h("td", { class: st.summary.failed ? "bad" : "" }, String(st.summary.failed))))),
          ),
        ),
      ),
    );
  for (const concurrency of levels) {
    draw();
    const result = await burst(path, request, 10_000_000, stepSeconds, concurrency, (samples, _, elapsed) => {
      const s = summarize(samples, elapsed);
      live.replaceChildren(h("div", { class: "http-tiles" }, tile("Now at a time", String(concurrency)), tile("Requests per second", s.rps.toFixed(1)), tile("95th percentile", ms(s.p95)), tile("Failed", String(s.failed), s.failed ? "bad" : "")));
    });
    steps.push({ concurrency, summary: summarize(result.samples, result.elapsed) });
    if (result.elapsed < stepSeconds - 0.5) break; // Stopped.
  }
  live.replaceChildren();
  draw();
}

function render(results: HTMLElement, samples: Sample[], perSecond: number[], elapsed: number, count: number, seconds: number, concurrency: number) {
  const s = summarize(samples, elapsed);
  const progress = seconds ? Math.min(1, elapsed / seconds) : Math.min(1, s.count / count);
  const errors = s.codes.filter(([code]) => code === "Error" || Number(code) >= 500).reduce((a, [, n]) => a + n, 0);
  results.replaceChildren(
    h("div", { class: "http-progress", title: `${Math.round(progress * 100)}%` }, h("span", { style: `width:${progress * 100}%` })),
    h(
      "div",
      { class: "http-tiles" },
      tile("Requests", `${s.count}${seconds ? "" : ` / ${count}`}`),
      tile("Requests per second", s.rps.toFixed(1)),
      tile("Failed", `${s.failed} (${s.count ? ((s.failed / s.count) * 100).toFixed(1) : "0"}%)`, errors ? "bad" : ""),
      tile("Median", ms(s.p50)),
      tile("95th percentile", ms(s.p95)),
      tile("99th percentile", ms(s.p99)),
      tile("Slowest", ms(s.max)),
      tile("Received", bytes(s.bytes)),
    ),
    h(
      "div",
      { class: "http-charts" },
      chart("Requests completed per second", perSecond.map((n, i) => ({ label: `${i}–${i + 1} s`, value: n ?? 0, tip: `${n ?? 0} requests in second ${i + 1}` })), (v) => String(v)),
      chart(
        "Response times",
        histogram(samples.map((x) => x.total), 20).map((b, i, all) => ({ label: `${ms(i ? all[i - 1].to : 0)}–${ms(b.to)}`, value: b.count, tip: `${b.count} requests took ${ms(i ? all[i - 1].to : 0)} to ${ms(b.to)}` })),
        (v) => String(v),
      ),
      h(
        "div",
        { class: "http-chart" },
        h("h4", {}, "Status codes"),
        h("table", { class: "http-table" }, h("tbody", {}, ...s.codes.map(([code, n]) => h("tr", {}, h("td", {}, h("span", { class: `http-code-badge ${statusClass(Number(code) || 0)}` }, code)), h("td", {}, String(n)), h("td", { class: "muted" }, `${((n / s.count) * 100).toFixed(1)}%`))))),
        h("p", { class: "http-hint" }, `Mean ${ms(s.mean)} · fastest ${ms(s.min)} · 90th percentile ${ms(s.p90)} · ${concurrency} at a time · ${elapsed.toFixed(1)} s`),
      ),
    ),
  );
}

// ---- Monitor ----
// Sends the request again every few seconds, without scripts or history, and charts the results.

const watch = h("div", { class: "http-client http-load" });
let watching: { timer: ReturnType<typeof setTimeout>; cancel: Cancel; stopped: boolean } | null = null;

function stopMonitor() {
  if (!watching) return;
  watching.stopped = true;
  clearTimeout(watching.timer);
  watching.cancel.current?.();
  watching = null;
}

function monitor(path: string, request: HttpRequest) {
  stopMonitor();
  const title = `${request.method} ${request.title || request.url}`;
  const interval = h("input", { type: "number", min: "1", value: "5", class: "http-number" });
  const start = h("button", { class: "primary http-send" }, icon("play"), "Start");
  const stop = h("button", { textContent: "Stop", disabled: true });
  const results = h("div", { class: "http-load-results" }, h("p", { class: "http-hint" }, "Sends the request every few seconds and charts its status and response time, such as to watch an endpoint during a deploy. Scripts don't run, and the checks stay out of the history."));
  watch.replaceChildren(h("div", { class: "http-bar" }, h("strong", { class: "http-load-title", title }, title), h("span", { class: "http-spacer" }), h("label", { class: "muted" }, "Every (seconds)"), interval, start, stop), results);
  showHttpPanel("Monitor", watch);
  stop.onclick = () => {
    stopMonitor();
    start.disabled = false;
    stop.disabled = true;
  };
  start.onclick = async () => {
    const fresh = parseHttp((await host.ensureModel(path)).getValue()).requests.find((q) => q.line === request.line) ?? request;
    let prepared: Prepared;
    let env: string | undefined;
    try {
      ({ prepared, env } = await prepareRequest(path, fresh));
    } catch (e) {
      results.replaceChildren(h("p", { class: "http-error" }, `Couldn't prepare the request: ${e}`));
      return;
    }
    start.disabled = true;
    stop.disabled = false;
    const checks: { time: number; status: number; seconds: number; error?: string }[] = [];
    const state = { timer: 0 as unknown as ReturnType<typeof setTimeout>, cancel: {} as Cancel, stopped: false };
    watching = state;
    const tick = async () => {
      state.cancel = {};
      const t = await probe(prepared, path, env, state.cancel);
      if (state.stopped) return;
      const status = t.heads.at(-1)?.status ?? 0;
      checks.push({ time: Date.now(), status, seconds: t.info?.time_total ?? 0, error: t.error });
      drawMonitor(results, checks);
      state.timer = setTimeout(tick, Math.max(1, Number(interval.value) || 5) * 1000);
    };
    tick();
  };
}

function drawMonitor(results: HTMLElement, checks: { time: number; status: number; seconds: number; error?: string }[]) {
  const ok = (c: (typeof checks)[number]) => !c.error && c.status > 0 && c.status < 500;
  const up = checks.filter(ok).length;
  const times = checks.filter(ok).map((c) => c.seconds);
  const s = summarize(times.map((t) => ({ code: 200, total: t, ttfb: t, exit: 0, bytes: 0 })), 1);
  const last = checks.at(-1)!;
  const recent = checks.slice(-60);
  results.replaceChildren(
    h(
      "div",
      { class: "http-tiles" },
      tile("Last status", last.error && !last.status ? "Failed" : String(last.status), ok(last) ? "" : "bad"),
      tile("Up", `${((up / checks.length) * 100).toFixed(1)}%`, up < checks.length ? "bad" : ""),
      tile("Checks", String(checks.length)),
      tile("Median", ms(s.p50)),
      tile("95th percentile", ms(s.p95)),
      tile("Slowest", ms(s.max)),
    ),
    h(
      "div",
      { class: "http-charts" },
      chart(
        "Response time per check (the last 60)",
        recent.map((c) => ({ label: new Date(c.time).toLocaleTimeString(), value: c.seconds, tip: `${new Date(c.time).toLocaleTimeString()}: ${c.error && !c.status ? c.error : c.status} in ${ms(c.seconds)}`, bad: !ok(c) })),
        (v) => ms(v),
      ),
      h(
        "div",
        { class: "http-chart" },
        h("h4", {}, "Latest checks"),
        h("table", { class: "http-table" }, h("tbody", {}, ...checks.slice(-8).reverse().map((c) => h("tr", {}, h("td", {}, new Date(c.time).toLocaleTimeString()), h("td", {}, h("span", { class: `http-code-badge ${statusClass(c.status)}` }, c.status ? String(c.status) : "ERR")), h("td", {}, c.error && !c.status ? c.error : ms(c.seconds)))))),
      ),
    ),
  );
}

/** A bar chart of one series, with a tooltip per bar. */
function chart(title: string, bars: { label: string; value: number; tip: string; bad?: boolean }[], format: (v: number) => string) {
  const W = 360;
  const H = 120;
  const max = Math.max(0, ...bars.map((b) => b.value)) || 1;
  const gap = 2;
  const width = bars.length ? (W - gap * (bars.length - 1)) / bars.length : W;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H + 16}`);
  svg.setAttribute("class", "http-bars");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", title);
  const baseline = document.createElementNS(ns, "line");
  Object.entries({ x1: "0", x2: String(W), y1: String(H), y2: String(H), class: "http-axis" }).forEach(([k, v]) => baseline.setAttribute(k, v));
  svg.append(baseline);
  bars.forEach((b, i) => {
    const height = (b.value / max) * (H - 4);
    const hit = document.createElementNS(ns, "rect");
    Object.entries({ x: String(i * (width + gap)), y: "0", width: String(Math.max(1, width)), height: String(H), class: "http-bar-hit" }).forEach(([k, v]) => hit.setAttribute(k, v));
    const bar = document.createElementNS(ns, "path");
    const x = i * (width + gap);
    const r = Math.min(4, width / 2, height);
    // Rounded at the top, square on the baseline.
    bar.setAttribute("d", height ? `M${x},${H} V${H - height + r} Q${x},${H - height} ${x + r},${H - height} H${x + width - r} Q${x + width},${H - height} ${x + width},${H - height + r} V${H} Z` : "");
    bar.setAttribute("class", `http-bar-fill${b.bad ? " bad" : ""}`);
    const tip = document.createElementNS(ns, "title");
    tip.textContent = b.tip;
    const group = document.createElementNS(ns, "g");
    group.append(tip, hit, bar);
    svg.append(group);
  });
  const label = (text: string, x: number, anchor: string) => {
    const t = document.createElementNS(ns, "text");
    Object.entries({ x: String(x), y: String(H + 12), "text-anchor": anchor, class: "http-axis-label" }).forEach(([k, v]) => t.setAttribute(k, v));
    t.textContent = text;
    svg.append(t);
  };
  // A range label, such as 0–1 s, marks its start on the left and the last one's end on the right.
  if (bars.length) label(bars[0].label.split("–")[0], 0, "start"), label(bars.at(-1)!.label.split("–").at(-1)!, W, "end");
  return h("div", { class: "http-chart" }, h("h4", {}, title, h("span", { class: "muted" }, ` · peak ${format(max)}`)), svg);
}

setRunners(loadTest, runFile, monitor);
document.getElementById("http-run-all")?.addEventListener("click", () => host.root() && runAllRequests());
