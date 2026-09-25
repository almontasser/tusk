// The HTTP client's collection runner, which sends every request in a file in order, and its stress test, which
// sends one request many times at once with curl's parallel mode and shows live statistics.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { cacheDir, cookieJar, type Exchange, host, prepareRequest, send } from "./httpclient";
import { histogram, type HttpRequest, loadArgs, parseHttp, parseSample, type Prepared, type Sample, summarize } from "./httpfile";
import { bytes, h, icon, openExchange, setRunners, showHttpPanel } from "./httpview";

const ms = (s: number) => (s < 1 ? `${(s * 1000).toFixed(s < 0.01 ? 1 : 0)} ms` : `${s.toFixed(2)} s`);
const statusClass = (code: number) => (!code || code >= 500 ? "bad" : code >= 400 ? "warn" : code >= 300 ? "redirect" : "good");

// ---- Runner ----

const runner = h("div", { class: "http-client http-runner" });
let stopRun = false;

async function runFile(path: string) {
  const model = await host.ensureModel(path);
  const requests = parseHttp(model.getValue()).requests;
  stopRun = false;
  const rows = h("tbody");
  const summary = h("span", { class: "muted" });
  const stop = h("button", { textContent: "Stop", onclick: () => (stopRun = true) });
  runner.replaceChildren(
    h("div", { class: "http-bar" }, h("strong", {}, `Running ${path.replace(host.root() + "/", "")}`), summary, h("span", { class: "http-spacer" }), stop, h("button", { textContent: "Run Again", onclick: () => runFile(path) })),
    h("div", { class: "http-runner-list" }, h("table", { class: "http-table http-runner-table" }, h("thead", {}, h("tr", {}, ...["", "Request", "Status", "Time", "Tests"].map((t) => h("th", { textContent: t })))), rows)),
  );
  showHttpPanel("HTTP Runner", runner);
  let passed = 0;
  let failed = 0;
  const started = performance.now();
  for (const [i, r] of requests.entries()) {
    if (stopRun) break;
    const state = h("td", {}, icon("loading codicon-modifier-spin"));
    const row = h("tr", {}, state, h("td", {}, `${r.method} ${r.title || r.name || r.url}`), h("td"), h("td"), h("td"));
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
      failed++;
      continue;
    }
    const final = x.heads.at(-1);
    const ok = !x.error && !!final && final.status < 400 && x.tests.every((t) => t.passed);
    ok ? passed++ : failed++;
    state.replaceChildren(icon(ok ? "pass" : "error"));
    state.className = ok ? "good" : "bad";
    row.cells[2].replaceChildren(h("span", { class: `http-code-badge ${statusClass(final?.status ?? 0)}` }, final ? String(final.status) : "ERR"), x.error ? ` ${x.error}` : "");
    row.cells[3].textContent = x.info ? ms(x.info.time_total) : "";
    row.cells[4].textContent = x.tests.length ? `${x.tests.filter((t) => t.passed).length}/${x.tests.length}` : "";
    row.onclick = () => openExchange(x);
    row.title = "Show the response";
  }
  stop.disabled = true;
  summary.textContent = `${passed} passed, ${failed} failed${stopRun ? ", stopped" : ""} · ${ms((performance.now() - started) / 1000)}`;
  summary.className = failed ? "bad" : "good";
}

// ---- Stress test ----

const load = h("div", { class: "http-client http-load" });
let active: { id: number; unlisten: UnlistenFn[]; timer?: ReturnType<typeof setTimeout> } | null = null;

async function stopLoad() {
  if (!active) return;
  clearTimeout(active.timer);
  await invoke("pty_kill", { id: active.id }).catch(() => {});
}

async function loadTest(path: string, request: HttpRequest) {
  const title = `${request.method} ${request.title || request.url}`;
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem("httpLoad") ?? "null") as { mode: string; count: number; seconds: number; concurrency: number } | null;
    } catch {
      return null;
    }
  })() ?? { mode: "count", count: 200, seconds: 10, concurrency: 10 };
  const mode = h("select", {}, h("option", { value: "count", textContent: "Requests" }), h("option", { value: "seconds", textContent: "Seconds" }));
  mode.value = saved.mode;
  const amount = h("input", { type: "number", min: "1", value: String(saved.mode === "count" ? saved.count : saved.seconds), class: "http-number" });
  const concurrency = h("input", { type: "number", min: "1", max: "500", value: String(saved.concurrency), class: "http-number" });
  mode.onchange = () => (amount.value = String(mode.value === "count" ? saved.count : saved.seconds));
  const start = h("button", { class: "primary http-send" }, icon("play"), "Start");
  const stop = h("button", { textContent: "Stop", disabled: true, onclick: stopLoad });
  const results = h("div", { class: "http-load-results" }, h("p", { class: "http-hint" }, "Sends the request many times at once and measures how the server holds up. Scripts don't run, and cookies kept for the environment are sent. Only test servers you're allowed to load."));
  load.replaceChildren(
    h("div", { class: "http-bar" }, h("strong", { class: "http-load-title", title }, title), h("span", { class: "http-spacer" }), mode, amount, h("label", { class: "muted" }, "Concurrency"), concurrency, start, stop),
    results,
  );
  showHttpPanel("Stress Test", load);
  start.onclick = async () => {
    if (active) return;
    const n = Math.max(1, Math.floor(Number(amount.value) || 1));
    const c = Math.max(1, Math.min(500, Math.floor(Number(concurrency.value) || 1)));
    const settings = { mode: mode.value, count: mode.value === "count" ? n : saved.count, seconds: mode.value === "seconds" ? n : saved.seconds, concurrency: c };
    Object.assign(saved, settings);
    try {
      localStorage.setItem("httpLoad", JSON.stringify(settings));
    } catch {}
    const fresh = parseHttp((await host.ensureModel(path)).getValue()).requests.find((q) => q.line === request.line) ?? request;
    start.disabled = true;
    stop.disabled = false;
    await run(path, fresh, mode.value === "count" ? n : 10_000_000, mode.value === "seconds" ? n : 0, c, results).finally(() => {
      start.disabled = false;
      stop.disabled = true;
    });
  };
}

async function run(path: string, request: HttpRequest, count: number, seconds: number, concurrency: number, results: HTMLElement) {
  let prepared: Prepared;
  let env: string | undefined;
  try {
    ({ prepared, env } = await prepareRequest(path, request));
  } catch (e) {
    results.replaceChildren(h("p", { class: "http-error" }, `Couldn't prepare the request: ${e}`));
    return;
  }
  // Every request reads the body, so it goes in a file rather than on stdin.
  if (prepared.body !== undefined) {
    const file = `${await cacheDir("http-scratch")}/load-body`;
    await invoke("create_dir", { path: file.slice(0, file.lastIndexOf("/")) }).catch(() => {});
    await invoke("write_file", { path: file, contents: prepared.body });
    prepared = { ...prepared, body: undefined, bodyFile: file };
  }
  const jar = await cookieJar(env);
  const args = loadArgs(prepared, count, concurrency, (await invoke<boolean>("path_exists", { path: jar })) ? jar : undefined);
  const samples: Sample[] = [];
  /** Requests finished in each second since the start. */
  const perSecond: number[] = [];
  let began = performance.now();
  const elapsed = () => Math.max(0, (performance.now() - began) / 1000);
  let buffer = "";
  let id: number;
  try {
    // Output events are named by the terminal's ID, which only comes back after it starts, so curl waits a moment
    // for the listeners. ponytail: a fixed 0.3 s head start; have pty_spawn take an ID from the caller if it's ever short.
    const command = ["/bin/sh", "-c", 'sleep 0.3; exec "$0" "$@"', "/usr/bin/curl", ...args];
    id = await invoke<number>("pty_spawn", { cwd: path.slice(0, path.lastIndexOf("/")), command, rows: 24, cols: 200 });
    began = performance.now() + 300;
  } catch (e) {
    results.replaceChildren(h("p", { class: "http-error" }, `Couldn't start curl: ${e}`));
    return;
  }
  const done = new Promise<void>((resolve) => {
    const unlisten: UnlistenFn[] = [];
    active = { id, unlisten };
    listen<string>(`pty:${id}`, ({ payload }) => {
      buffer += payload;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const s = parseSample(line);
        if (!s) continue;
        samples.push(s);
        const second = Math.floor(elapsed());
        perSecond[second] = (perSecond[second] ?? 0) + 1;
      }
    }).then((u) => unlisten.push(u));
    listen(`pty-exit:${id}`, () => resolve()).then((u) => unlisten.push(u));
    if (seconds) active.timer = setTimeout(stopLoad, seconds * 1000);
  });
  const draw = () => render(results, samples, perSecond, elapsed(), count, seconds, concurrency);
  const ticker = setInterval(draw, 250);
  await done;
  clearInterval(ticker);
  active?.unlisten.forEach((u) => u());
  clearTimeout(active?.timer);
  active = null;
  draw();
}

function render(results: HTMLElement, samples: Sample[], perSecond: number[], elapsed: number, count: number, seconds: number, concurrency: number) {
  const s = summarize(samples, elapsed);
  const tile = (label: string, value: string, className = "") => h("div", { class: `http-tile ${className}` }, h("span", { class: "http-tile-value" }, value), h("span", { class: "http-tile-label" }, label));
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

/** A bar chart of one series, with a tooltip per bar. */
function chart(title: string, bars: { label: string; value: number; tip: string }[], format: (v: number) => string) {
  const W = 360;
  const H = 120;
  const max = Math.max(1, ...bars.map((b) => b.value));
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
    bar.setAttribute("class", "http-bar-fill");
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
  if (bars.length) label(bars[0].label.split("–")[0], 0, "start"), label(bars.at(-1)!.label.split("–")[1] ?? "", W, "end");
  return h("div", { class: "http-chart" }, h("h4", {}, title, h("span", { class: "muted" }, ` · peak ${format(max)}`)), svg);
}

setRunners(loadTest, runFile);
