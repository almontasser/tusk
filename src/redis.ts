// Redis in the Database tool: a key browser in the sidebar, a key's value in the panel, and completion in the console.
// Keys load in batches with SCAN, which never blocks the server, and group into folders by ":".
import { invoke } from "@tauri-apps/api/core";
import type { Connection } from "./dbconfig";
import { button, type Cell, type Changes, dataGrid, el } from "./dbgrid";
import { bytesOf, hexDump } from "./dbgriddata";
import type { ListNav } from "./listnav";
import { h, icon, iconButton, toast } from "./dom";
import { monaco } from "./editor";
// @ts-expect-error Monaco ships its grammars without types.
import { language as redisGrammar } from "monaco-editor/languages/definitions/redis/redis.js";
import { showMenu } from "./files";
import { confirm, pick, rank } from "./palette";
import {
  type CommandDoc,
  columnsOf,
  commandDocs,
  commandLine,
  editCommands,
  elementName,
  filterPattern,
  formatBytes,
  formatTtl,
  globEscape,
  isBinary,
  isDangerous,
  isError,
  keyTree,
  lengthCommand,
  PAGE,
  parseDuration,
  type Reply,
  replyText,
  splitCommand,
  type TreeRow,
  typeLabel,
  typeName,
  valueKind,
  visibleRows,
} from "./redisdata";
import { withProgress } from "./status";
import { showPanelView } from "./terminal";
import { keyText, mod } from "./platform.ts";

export type RedisHost = {
  connection(): Connection | null;
  /** The panel view that shows results. */
  results: HTMLElement;
  status(text: string): void;
  friendlyError(message: string): string;
  /** The keyboard for the key tree, which it shares with the tables. */
  nav: ListNav;
  /** Asks before the panel's grid loses pending changes. */
  confirmDiscard(): Promise<boolean>;
};

let host: RedisHost;
const $ = (id: string) => document.getElementById(id)!;
const message = (e: unknown) => host.friendlyError(e instanceof Error ? e.message : String(e));

/** Runs commands in one round trip. With `atomic`, in a transaction that a refused command discards. */
const call = (commands: string[][], atomic = false) => invoke<Reply[]>("redis_call", { connection: host.connection(), commands, atomic });

/** Runs one command and returns its reply; an error reply throws. */
async function one(...args: string[]): Promise<Reply> {
  const [reply] = await call([args]);
  if (isError(reply)) throw new Error(reply.error);
  return reply;
}

/** Runs an action from a button or menu, and shows its error in a toast. */
const guard = (action: () => Promise<unknown>) => () => action().catch((e) => toast(message(e)));

// ---- Keys ----

/**
 * Loaded keys with their types, SCAN's cursor ("0" when every key matching the filter is loaded), DBSIZE, and how
 * many keys were skipped because their names aren't text.
 */
const scan = { keys: new Map<string, string>(), cursor: "0", total: 0, pattern: "*", scanning: false, error: "", generation: 0, skipped: 0 };
const expanded = new Set<string>();
/** The selected row, from listNav: `k:` and a key, or `f:` and a folder's prefix. */
const selectedId = () => host.nav.selected();
/** The server and database the tree shows, so switching connections starts over. */
let shown = "";
/** Keys per batch before the tree shows them; a sparse filter stops sooner, after a second of scanning. */
const BATCH = 500;

const connectionId = (c: Connection | null) => (c ? `${c.host}:${c.port}/${c.database}` : "");

/** Shows the filter and Add Key only for Redis. */
export function showRedisSidebar(on: boolean) {
  toolbar().hidden = !on;
  $("redis-add").hidden = !on;
  $("db-tables").classList.toggle("redis-keys", on);
}

function toolbar() {
  const existing = document.getElementById("redis-toolbar");
  if (existing) return existing;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const input = h("input", { id: "redis-filter", placeholder: "Filter keys, or a pattern such as user:*", ariaLabel: "Filter keys", spellcheck: false });
  const apply = () => {
    clearTimeout(timer);
    const pattern = filterPattern(input.value);
    if (pattern !== scan.pattern) (scan.pattern = pattern), loadMore(true);
  };
  input.oninput = () => (clearTimeout(timer), (timer = setTimeout(apply, 300)));
  input.onkeydown = (e) => {
    if (e.key === "Enter") apply();
    if (e.key === "Escape" && input.value) (input.value = ""), apply();
    if (e.key === "ArrowDown") e.preventDefault(), $("db-tables").focus();
  };
  const bar = h("div", { id: "redis-toolbar", class: "pr-toolbar" }, input);
  $("db-tables").before(bar);
  return bar;
}

/** Lists the keys of the selected connection, keeping the filter and open folders when it's the same database. */
export async function loadKeys() {
  const id = connectionId(host.connection());
  if (id !== shown) {
    shown = id;
    expanded.clear();
    host.nav.select("", { scroll: false });
    scan.pattern = "*";
    ($("redis-filter") as HTMLInputElement).value = "";
  }
  await loadMore(true);
}

/**
 * Scans the next batch of keys and reads their types in one pipelined call. `reset` starts over, as after a
 * filter change; a scan that's overtaken by a newer one drops its results.
 */
async function loadMore(reset = false) {
  if (reset) (scan.generation++, scan.keys.clear()), (scan.cursor = "0"), (scan.error = ""), (scan.skipped = 0);
  else if (scan.cursor === "0" || scan.scanning) return;
  const generation = scan.generation;
  scan.scanning = true;
  render();
  try {
    const started = performance.now();
    const found = new Set<string>();
    let first = reset;
    do {
      const commands = [["SCAN", scan.cursor, "MATCH", scan.pattern, "COUNT", "1000"]];
      if (first) commands.unshift(["DBSIZE"]);
      const replies = await call(commands);
      if (generation !== scan.generation) return;
      if (first) scan.total = Number(replies.shift()) || 0;
      first = false;
      const [reply] = replies;
      if (isError(reply)) throw new Error(reply.error);
      const [cursor, batch] = reply as [string, Reply[]];
      scan.cursor = cursor;
      // A key whose name isn't text can't be typed into a command, so it's left out, and counted.
      for (const k of batch) {
        if (typeof k !== "string") scan.skipped++;
        else if (!scan.keys.has(k)) found.add(k);
      }
    } while (scan.cursor !== "0" && found.size < BATCH && performance.now() - started < 1000);
    const keys = [...found];
    const types = keys.length ? await call(keys.map((k) => ["TYPE", k])) : [];
    if (generation !== scan.generation) return;
    keys.forEach((k, i) => scan.keys.set(k, typeof types[i] === "string" ? (types[i] as string) : "?"));
    // A filter's few matches show with their folders open.
    if (scan.pattern !== "*" && scan.keys.size <= 200) for (const k of scan.keys.keys()) openFolders(k);
  } catch (e) {
    if (generation === scan.generation) scan.error = message(e);
  } finally {
    if (generation === scan.generation) (scan.scanning = false), render();
  }
}

/** Opens the folders a key is in, so it shows in the tree. */
function openFolders(key: string) {
  const parts = key.split(":");
  for (let i = 1; i < parts.length; i++) expanded.add(`${parts.slice(0, i).join(":")}:`);
}

function render() {
  const list = $("db-tables");
  const tree = keyTree([...scan.keys].map(([key, type]) => ({ key, type })));
  const items = visibleRows(tree, (p) => expanded.has(p)).map(row);
  const n = scan.keys.size;
  const filtered = scan.pattern !== "*";
  if (!n && !scan.scanning && scan.error) {
    const retry = h("button", { class: "db-action", onclick: () => loadMore(true) }, icon("refresh"), "Retry");
    items.push(h("li", { class: "muted redis-note" }, scan.error.startsWith("Can't") ? scan.error : `Can't list the keys: ${scan.error}`, h("br"), retry));
  } else if (!n && !scan.scanning) items.push(h("li", { class: "muted redis-note" }, scan.cursor !== "0" ? "No keys found yet. Click Load More to scan further." : filtered ? `No keys match ${scan.pattern}.` : "No keys in this database."));
  const count = filtered
    ? `${n.toLocaleString()} ${n === 1 ? "match" : "matches"}${scan.cursor !== "0" ? " so far" : ""} in ${scan.total.toLocaleString()} keys`
    : `${n.toLocaleString()}${scan.cursor !== "0" ? ` of ${scan.total.toLocaleString()}` : ""} ${scan.total === 1 ? "key" : "keys"}`;
  const footer = h("li", { class: "muted redis-note" });
  // Filled below when there's something to say.
  if (scan.scanning) footer.append(h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), " Scanning…");
  else if (n || filtered) footer.append(count);
  if (!scan.scanning && scan.cursor !== "0") footer.append(h("button", { class: "db-action", onclick: () => loadMore() }, icon("fold-down"), "Load More"));
  if (scan.skipped)
    footer.append(h("div", { class: "muted", title: "The editor can't send a key name that isn't UTF-8 text in a command. Read these keys with redis-cli." }, scan.skipped === 1 ? "1 key isn't listed: its name isn't text." : `${scan.skipped.toLocaleString()} keys aren't listed: their names aren't text.`));
  if (n && scan.error) footer.append(h("div", { class: "db-error" }, scan.error));
  list.replaceChildren(...items, ...(footer.childNodes.length ? [footer] : []));
}

function row(r: TreeRow) {
  const indent = `padding-left: ${4 + r.depth * 14}px`;
  if (r.kind === "folder") {
    const f = r.folder;
    const open = expanded.has(f.prefix);
    const div = h(
      "div",
      { class: "row redis-folder", style: indent, title: `${f.prefix}*`, role: "treeitem", data: { key: `f:${f.prefix}`, label: f.name } },
      h("span", { class: `chevron codicon codicon-chevron-${open ? "down" : "right"}` }),
      icon(open ? "folder-opened" : "folder"),
      h("span", { class: "name" }, f.name || "(empty)"),
      h("span", { class: "type" }, f.count.toLocaleString()),
    );
    div.setAttribute("aria-level", String(r.depth + 1));
    div.setAttribute("aria-expanded", String(open));
    div.onclick = () => toggle(f.prefix);
    div.oncontextmenu = (e) => (e.preventDefault(), host.nav.select(`f:${f.prefix}`, { scroll: false }), folderMenu(e, f.prefix));
    return h("li", { role: "none" }, div);
  }
  const { key, type } = r.key;
  const div = h(
    "div",
    { class: "row redis-key", style: indent, title: `${key}\n${typeName[type] ?? type}`, role: "treeitem", data: { key: `k:${key}`, label: r.name } },
    h("span", { class: "chevron" }),
    h("span", { class: "redis-type", data: { type } }, typeLabel(type)),
    h("span", { class: "name" }, r.name),
  );
  div.setAttribute("aria-level", String(r.depth + 1));
  div.onclick = () => showKey(key);
  div.oncontextmenu = (e) => (e.preventDefault(), host.nav.select(`k:${key}`, { scroll: false }), keyMenu(e, key));
  return h("li", { role: "none" }, div);
}

function toggle(prefix: string) {
  expanded.has(prefix) ? expanded.delete(prefix) : expanded.add(prefix);
  render();
}

/** ⌘⌫ deletes the selected key or folder; listNav handles the other keys. */
function onTreeKey(e: KeyboardEvent) {
  if (!$("db-tables").classList.contains("redis-keys") || e.target !== $("db-tables")) return;
  const selected = selectedId();
  const [kind, id] = [selected.slice(0, 2), selected.slice(2)];
  if (e.key === "Backspace" && mod(e) && kind === "k:") e.preventDefault(), guard(() => deleteKey(id))();
  else if (e.key === "Backspace" && mod(e) && kind === "f:") e.preventDefault(), guard(() => deleteFolder(id))();
}

function keyMenu(e: MouseEvent, key: string) {
  showMenu(e.clientX, e.clientY, [
    { label: "Show Value", run: () => showKey(key) },
    { label: "Copy Name", run: () => copy(key) },
    "-",
    { label: "Rename…", run: guard(() => renameKey(key)) },
    { label: "Set Expiry…", run: guard(() => setExpiry(key)) },
    "-",
    { label: "Delete…", run: guard(() => deleteKey(key)) },
  ]);
}

function folderMenu(e: MouseEvent, prefix: string) {
  showMenu(e.clientX, e.clientY, [
    { label: "Show Only These Keys", run: () => filterTo(`${globEscape(prefix)}*`) },
    { label: "Copy Pattern", run: () => copy(`${globEscape(prefix)}*`) },
    { label: "Add Key Here…", run: guard(() => addKey(prefix)) },
    "-",
    { label: "Delete Keys…", run: guard(() => deleteFolder(prefix)) },
  ]);
}

function filterTo(pattern: string) {
  ($("redis-filter") as HTMLInputElement).value = pattern;
  scan.pattern = pattern;
  loadMore(true);
}

const copy = (text: string) => navigator.clipboard.writeText(text).then(() => host.status(`Copied ${text}`));

// ---- Key actions ----

/**
 * Asks for text in the picker. `check` returns a problem with the text, which keeps the picker open. Null for Escape.
 * `select` is the part of `value` to select, the whole of it by default.
 */
function prompt(title: string, value = "", check: (text: string) => string | null = () => null, select: [number, number] = [0, value.length]) {
  return new Promise<string | null>((resolve) => {
    const ask = (text: string, range: [number, number]): void =>
      pick(
        title,
        (q) => {
          const problem = check(q);
          return [{ label: problem ?? "Press Enter to confirm", detail: problem ? undefined : q || "(empty)", icon: problem ? "codicon-warning" : "codicon-check", run: () => (problem ? ask(q, [q.length, q.length]) : resolve(q)) }];
        },
        0,
        { value: text, select: range, onCancel: () => resolve(null) },
      );
    ask(value, select);
  });
}

/**
 * Where a page of a key's elements starts: its row's number, and for a hash or set the SCAN cursor, or for a stream
 * the entry ID, to read from.
 */
type Page = { offset: number; from: string };
const FIRST: Page[] = [{ offset: 0, from: "0" }];

/** The key the panel shows, and its page, to refresh it after an action. */
let view: { key: string; page: number; pages: Page[] } | null = null;

async function renameKey(key: string) {
  const name = await prompt(`Rename ${key}`, key, (v) => (v ? null : "Type a name."), [key.lastIndexOf(":") + 1, key.length]);
  if (name === null || name === key) return;
  if ((await one("RENAMENX", key, name)) === 0) {
    if (!(await confirm(`A key named ${name} exists. Replace it with ${key}?`, "Replace"))) return;
    await one("RENAME", key, name);
  }
  const type = scan.keys.get(key) ?? "?";
  scan.keys.delete(key);
  scan.keys.set(name, type);
  openFolders(name);
  render();
  host.nav.select(`k:${name}`);
  if (view?.key === key) showKey(name);
  host.status(`Renamed ${key} to ${name}`);
}

async function setExpiry(key: string) {
  const pttl = Number(await one("PTTL", key));
  const current = pttl > 0 ? formatTtl(Math.ceil(pttl / 1000)) : "";
  const text = await prompt(`Expire ${key} after a time, such as 90s, 15m, 2h, or 1d, or leave it empty for no expiry`, current, (v) =>
    parseDuration(v) === null ? "Type a time such as 90s, 15m, 2h, or 1d." : null,
  );
  if (text === null) return;
  const seconds = parseDuration(text)!;
  await one(...(seconds < 0 ? ["PERSIST", key] : ["EXPIRE", key, String(seconds)]));
  host.status(seconds < 0 ? `${key} no longer expires` : `${key} expires in ${formatTtl(seconds)}`);
  if (view?.key === key) showKey(key, view.page, view.pages);
}

/** UNLINK frees a big key's memory in the background; Redis before 4.0 only has DEL. */
async function unlink(keys: string[]) {
  const [reply] = await call([["UNLINK", ...keys]]);
  if (isError(reply) && /unknown command/i.test(reply.error)) return one("DEL", ...keys);
  if (isError(reply)) throw new Error(reply.error);
  return reply;
}

async function deleteKey(key: string) {
  if (!(await confirm(`Delete ${key}? This can't be undone.`, "Delete"))) return;
  await unlink([key]);
  forget([key]);
  host.status(`Deleted ${key}`);
}

/** Drops deleted keys from the tree, and from the panel when it shows one. */
function forget(keys: string[]) {
  for (const k of keys) scan.keys.delete(k);
  scan.total = Math.max(0, scan.total - keys.length);
  render();
  if (view && keys.includes(view.key)) {
    host.results.replaceChildren(el("div", "db-summary muted", `Deleted ${view.key}.`));
    view = null;
  }
}

/** Deletes every key under a folder, all of them rather than only those loaded, after counting and asking. */
async function deleteFolder(prefix: string) {
  const keys = await withProgress(
    `Counting the keys under ${prefix}…`,
    async (signal) => {
      const keys = new Set<string>();
      let cursor = "0";
      do {
        signal.throwIfAborted();
        const [c, batch] = (await one("SCAN", cursor, "MATCH", `${globEscape(prefix)}*`, "COUNT", "1000")) as [string, Reply[]];
        cursor = c;
        for (const k of batch) if (typeof k === "string") keys.add(k);
      } while (cursor !== "0");
      return keys;
    },
    { cancellable: true, error: `Can't count the keys under ${prefix}` },
  );
  if (!keys) return;
  if (!keys.size) return toast(`No keys are under ${prefix}.`, { kind: "info" });
  const n = keys.size.toLocaleString();
  if (!(await confirm(`Delete ${n} ${keys.size === 1 ? "key" : "keys"} under ${prefix}? This can't be undone.`, `Delete ${n} ${keys.size === 1 ? "Key" : "Keys"}`))) return;
  const all = [...keys];
  let deleted: string[] = [];
  // 500 keys per command, 10 commands per round trip; Cancel stops between round trips, keeping what's deleted.
  await withProgress(
    `Deleting ${n} keys under ${prefix}…`,
    async (signal, progress) => {
      for (let i = 0; i < all.length; i += 5000) {
        signal.throwIfAborted();
        const chunk = all.slice(i, i + 5000);
        const commands: string[][] = [];
        for (let j = 0; j < chunk.length; j += 500) commands.push(["UNLINK", ...chunk.slice(j, j + 500)]);
        const replies = await call(commands);
        // A command that failed deleted nothing; the others went through.
        commands.forEach((c, j) => !isError(replies[j]) && (deleted = deleted.concat(c.slice(1))));
        const failed = replies.find(isError);
        if (failed) throw new Error(failed.error);
        progress(`Deleted ${deleted.length.toLocaleString()} of ${n} keys under ${prefix}…`);
      }
    },
    { cancellable: true, error: `Can't delete the keys under ${prefix}` },
  );
  if (deleted.length === all.length) expanded.delete(prefix);
  forget(deleted);
  host.status(deleted.length === all.length ? `Deleted ${n} keys under ${prefix}` : `Deleted ${deleted.length.toLocaleString()} of ${n} keys under ${prefix}`);
}

const NEW_TYPES: [string, string, string][] = [
  ["String", "string", "Text, JSON, or a serialized value"],
  ["Hash", "hash", "Fields with values, such as an object's attributes"],
  ["List", "list", "Items in order, such as a queue"],
  ["Set", "set", "Unique members, in no order"],
  ["Sorted Set", "zset", "Unique members ordered by a score, such as a leaderboard"],
  ["Stream", "stream", "An append-only log of entries"],
];

/** Adds a key, asking for its type, name, and first value, since Redis has no empty hash, list, set, or stream. */
export async function addKey(prefix = selectedId().startsWith("f:") ? selectedId().slice(2) : "") {
  if (host.connection()?.driver !== "redis") return;
  const chosen = await new Promise<(typeof NEW_TYPES)[number] | null>((resolve) =>
    pick("Type of the new key", (q) => rank(q, NEW_TYPES.map((t) => ({ label: t[0], detail: t[2], run: () => resolve(t) }))), 0, { value: "", onCancel: () => resolve(null) }),
  );
  if (!chosen) return;
  const [label, type] = chosen;
  const key = await prompt(`Name of the new ${label.toLowerCase()}`, prefix, (v) => (!v ? "Type a name." : scan.keys.has(v) ? "A key with this name exists." : null), [prefix.length, prefix.length]);
  if (key === null) return;
  if ((await one("EXISTS", key)) === 1) throw new Error(`A key named ${key} exists.`);
  const ask = (title: string, value = "") => prompt(title, value);
  let command: string[] | null = null;
  if (type === "string") {
    const v = await ask(`Value of ${key}`);
    if (v !== null) command = ["SET", key, v, "NX"];
  } else if (type === "hash" || type === "stream") {
    const field = await prompt(`First field of ${key}`, "", (v) => (v ? null : "Type a field name."));
    const v = field === null ? null : await ask(`Value of ${field}`);
    if (field !== null && v !== null) command = type === "hash" ? ["HSET", key, field, v] : ["XADD", key, "*", field, v];
  } else if (type === "zset") {
    const member = await ask(`First member of ${key}`);
    const score = member === null ? null : await prompt(`Score of ${member}`, "0", (v) => (/^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(v.trim()) ? null : "A score is a number."));
    if (member !== null && score !== null) command = ["ZADD", key, "NX", score.trim(), member];
  } else {
    const v = await ask(`First ${type === "list" ? "item" : "member"} of ${key}`);
    if (v !== null) command = [type === "list" ? "RPUSH" : "SADD", key, v];
  }
  if (!command) return;
  await one(...command);
  scan.keys.set(key, type);
  scan.total++;
  openFolders(key);
  render();
  host.nav.select(`k:${key}`);
  showKey(key);
}

// ---- The key's value ----

let valueEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let ticker: ReturnType<typeof setInterval> | undefined;

function disposeEditor() {
  valueEditor?.getModel()?.dispose();
  valueEditor?.dispose();
  valueEditor = null;
  clearInterval(ticker);
}

const EDITOR: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  fontSize: 12,
  fontFamily: "JetBrains Mono, JetBrainsMono Nerd Font Mono, SF Mono, Menlo, Cascadia Mono, Consolas, DejaVu Sans Mono, monospace",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: "none",
  lineDecorationsWidth: 6,
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
  fixedOverflowWidgets: true,
  overviewRulerLanes: 0,
  wordWrap: "on",
  tabSize: 2,
};

/**
 * Shows a key in the panel: a header with its type, size, and time to live, and its value. A string or JSON value
 * opens in an editor; a hash, list, set, sorted set, or stream in the grid, a page at a time. `pages` holds where
 * each page shown so far starts.
 */
export async function showKey(key: string, page = 0, pages: Page[] = FIRST) {
  if (!(await host.confirmDiscard())) return;
  const results = host.results;
  results.onkeydown = null;
  disposeEditor();
  view = { key, page, pages };
  const header = el("div", "redis-key-header");
  const summary = el("div", "db-summary muted", "Loading…");
  results.replaceChildren(header, summary);
  showPanelView("Database", results);
  const stale = () => view?.key !== key || view.page !== page || !results.contains(summary);
  try {
    const [typeReply, pttl, memory] = await call([["TYPE", key], ["PTTL", key], ["MEMORY", "USAGE", key]]);
    if (stale()) return;
    if (isError(typeReply)) throw new Error(typeReply.error);
    const type = String(typeReply);
    if (type === "none") {
      summary.replaceChildren(el("span", "db-error", `${key} no longer exists. It may have expired, or been deleted or renamed.`));
      forgetMissing(key);
      return;
    }
    if (scan.keys.has(key) && scan.keys.get(key) !== type) scan.keys.set(key, type), render();
    const meta = el("span", "redis-meta");
    header.append(
      h("span", { class: "redis-type", data: { type } }, typeLabel(type)),
      h("span", { class: "redis-key-name", title: key }, key),
      meta,
      h(
        "span",
        { class: "redis-key-actions" },
        iconButton("refresh", "Refresh", () => showKey(key, page, pages)),
        iconButton("copy", "Copy Name", () => copy(key)),
        iconButton("edit", "Rename…", guard(() => renameKey(key))),
        iconButton("watch", "Set Expiry…", guard(() => setExpiry(key))),
        iconButton("trash", "Delete…", guard(() => deleteKey(key))),
      ),
    );
    const ttl = h("button", { class: "redis-ttl", title: "Set Expiry…", onclick: guard(() => setExpiry(key)) });
    const expires = Date.now() + Number(pttl);
    const tick = () => {
      const left = Math.ceil((expires - Date.now()) / 1000);
      ttl.textContent = Number(pttl) < 0 ? "No expiry" : left > 0 ? `Expires in ${formatTtl(left)}` : "Expired";
      ttl.classList.toggle("soon", Number(pttl) >= 0 && left <= 60);
    };
    tick();
    if (Number(pttl) >= 0) ticker = setInterval(() => (ttl.isConnected ? tick() : clearInterval(ticker)), 1000);
    const size = (length: number | null) => {
      const [singular, plural] = elementName[type] ?? ["", ""];
      const memoryText = typeof memory === "number" ? `${formatBytes(memory)} in memory` : "";
      const count = singular && length !== null ? `${length.toLocaleString()} ${length === 1 ? singular : plural}` : "";
      const badge = meta.querySelector(".badge");
      meta.replaceChildren(...(badge ? [badge, " "] : []), ...[typeName[type] ?? type, count, memoryText].filter(Boolean).flatMap((t) => [t, " · "]), ttl);
    };
    size(null);
    if (type === "string" || type === "ReJSON-RL") await textView(key, type, header, summary, size, stale);
    else if (columnsOf[type]) await collectionView(key, type, page, pages, summary, size, stale);
    else summary.textContent = `The editor can't show ${type} values. Read this key with its module's commands in the console.`;
  } catch (e) {
    if (!stale()) summary.replaceChildren(el("span", "db-error", message(e)));
  }
}

function forgetMissing(key: string) {
  if (!scan.keys.delete(key)) return;
  scan.total = Math.max(0, scan.total - 1);
  render();
}

/** A string, or a RedisJSON document, in an editor: ⌘S or Save writes it back, keeping its time to live. */
async function textView(key: string, type: string, header: HTMLElement, summary: HTMLElement, size: (n: number | null) => void, stale: () => boolean) {
  const json = type === "ReJSON-RL";
  const [value, length] = await call(json ? [["JSON.GET", key]] : [["GET", key], ["STRLEN", key]]);
  if (stale()) return;
  if (isError(value)) throw new Error(value.error);
  size(Number(length ?? 0));
  const container = el("div", "redis-value");
  if (isBinary(value)) {
    summary.textContent = `This value isn't text: ${formatBytes(value.binary)} of binary data, such as a compressed cache entry, so it's read-only.${value.binary > 1024 ? " The first 1 KB shows." : ""}`;
    const dump = hexDump(bytesOf(`\\x${value.hex}`));
    host.results.append(container);
    valueEditor = monaco.editor.create(container, { ...EDITOR, readOnly: true, wordWrap: "off", model: monaco.editor.createModel(dump, "plaintext") });
    return;
  }
  let original = String(value ?? "");
  const kind = json ? "json" : valueKind(original);
  if (kind) header.querySelector(".redis-meta")!.prepend(h("span", { class: "badge" }, kind === "json" ? "JSON" : "PHP serialized"), " ");
  summary.replaceChildren();
  const save = button(summary, "Save", "check", guard(write));
  const revert = button(summary, "Revert", "discard", () => valueEditor?.setValue(original));
  if (kind === "json")
    button(summary, "Format JSON", "json", () => {
      try {
        valueEditor?.setValue(JSON.stringify(JSON.parse(valueEditor.getValue()), null, 2));
      } catch (e) {
        toast(`Not valid JSON: ${message(e)}`);
      }
    });
  const hint = el("span", "", keyText(" ⌘S saves"));
  summary.append(hint);
  host.results.append(container);
  valueEditor = monaco.editor.create(container, { ...EDITOR, model: monaco.editor.createModel(original, kind === "json" ? "json" : "plaintext") });
  const editor = valueEditor;
  const changed = () => (save.disabled = revert.disabled = editor.getValue() === original);
  changed();
  editor.onDidChangeModelContent(changed);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, guard(write));
  async function write() {
    const text = editor.getValue();
    if (text === original) return;
    if (json) JSON.parse(text); // Throws, with the position, before RedisJSON refuses it.
    // KEEPTTL (Redis 6) keeps the key's expiry, which a plain SET would drop.
    await one(...(json ? ["JSON.SET", key, "$", text] : ["SET", key, text, "KEEPTTL"]));
    original = text;
    changed();
    if (!json) size(new TextEncoder().encode(text).length);
    host.status(`Saved ${key}`);
  }
}

/** A page of a hash, list, set, sorted set, or stream in the grid, with edits applied in one transaction. */
async function collectionView(key: string, type: string, page: number, pages: Page[], summary: HTMLElement, size: (n: number | null) => void, stale: () => boolean) {
  const length = [lengthCommand[type], key];
  let values: Reply[][] = [];
  let next: string | null = null;
  let total = 0;
  const { offset: first, from } = pages[page];
  const pairs = (flat: Reply[]) => Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i], flat[2 * i + 1]]);
  if (type === "list" || type === "zset") {
    const read = type === "list" ? ["LRANGE", key, String(first), String(first + PAGE - 1)] : ["ZRANGE", key, String(first), String(first + PAGE - 1), "WITHSCORES"];
    const [items, count] = await call([read, length]);
    if (isError(items)) throw new Error(items.error);
    total = Number(count);
    values = type === "list" ? (items as Reply[]).map((v) => [v]) : pairs(items as Reply[]);
    if (first + PAGE < total) next = "";
  } else if (type === "hash" || type === "set") {
    // SCAN's COUNT is a hint, so a page reads until it has a page's worth, or the end.
    let cursor = from;
    let flat: Reply[] = [];
    let counted = false;
    do {
      const commands = [[type === "hash" ? "HSCAN" : "SSCAN", key, cursor, "COUNT", String(PAGE)]];
      if (!counted) commands.push(length);
      const [reply, count] = await call(commands);
      if (isError(reply)) throw new Error(reply.error);
      if (!counted) (total = Number(count)), (counted = true);
      cursor = String((reply as Reply[])[0]);
      flat = flat.concat((reply as Reply[])[1] as Reply[]);
    } while (cursor !== "0" && (type === "hash" ? flat.length / 2 : flat.length) < PAGE);
    values = type === "hash" ? pairs(flat) : flat.map((m) => [m]);
    next = cursor === "0" ? null : cursor;
  } else {
    const start = page ? from : "-";
    const [entries, count] = await call([["XRANGE", key, start, "+", "COUNT", String(PAGE)], length]);
    if (isError(entries)) throw new Error(entries.error);
    total = Number(count);
    values = (entries as [string, Reply[]][]).map(([id, fields]) => [id, JSON.stringify(Object.fromEntries(pairs(fields).map(([f, v]) => [replyText(f), replyText(v)])))]);
    if (values.length === PAGE) next = `(${String(values[values.length - 1][0])}`;
  }
  if (stale()) return;
  size(total);
  const binary = new Set(values.flatMap((cells, r) => (cells.some(isBinary) ? [r] : [])));
  const cells: Cell[][] = values.map((row) => row.map(replyText));
  const columns = columnsOf[type];
  const n = cells.length;
  const paged = page > 0 || next !== null;
  const [singular, plural] = elementName[type];
  summary.replaceChildren(paged ? `${(first + 1).toLocaleString()}–${(first + n).toLocaleString()} of ${total.toLocaleString()} ${plural}` : `${n.toLocaleString()} ${n === 1 ? singular : plural}`);
  if (binary.size) summary.append(` · ${binary.size} binary ${binary.size === 1 ? "row is" : "rows are"} read-only`);
  if (page > 0) button(summary, "Previous", "chevron-left", () => showKey(key, page - 1, pages)).classList.add("db-page");
  if (next !== null) button(summary, "Next", "chevron-right", () => showKey(key, page + 1, [...pages.slice(0, page + 1), { offset: first + n, from: next! }])).classList.add("db-page");
  // The grid's changes hold text only: Redis has no NULL or DEFAULT, so the grid offers neither.
  const commands = (changes: Changes) => {
    if ([...changes.deletes, ...changes.edits.keys()].some((r) => binary.has(r))) throw new Error("Rows with binary values can't be changed here.");
    return editCommands(type, key, cells, changes as Changes<Cell>, first);
  };
  const grid = dataGrid({
    columns,
    rows: cells,
    // A list numbers rows by their Redis index, from 0.
    first: type === "list" ? first : first + 1,
    toolbar: summary,
    table: key,
    edit: {
      nulls: false,
      empty: type === "stream" ? false : "empty",
      editable: (r) => type !== "stream" && !binary.has(r),
      describe: (changes) => commands(changes).map(commandLine),
      submit: async (changes) => {
        const failed = (await call(commands(changes), true)).find(isError);
        if (failed) throw new Error(failed.error);
      },
      target: key,
      again: () => showKey(key, page, pages),
    },
  });
  host.results.append(grid.element);
}

// ---- Console ----

/** Asks before a command that changes the whole server or database, such as FLUSHDB. */
export async function confirmCommands(commands: string[][]) {
  const risky = commands.filter(isDangerous);
  if (!risky.length) return true;
  const c = host.connection()!;
  return confirm(`Run ${risky.map((r) => r[0].toUpperCase()).join(", ")} on ${c.host}:${c.port}, database ${c.database || 0}? This affects the whole ${/^(FLUSHALL|SHUTDOWN|REPLICAOF|SLAVEOF|FAILOVER|DEBUG)$/i.test(risky[0][0]) ? "server" : "database"}.`, "Run");
}

/** Runs several console lines in one round trip, and shows each command's reply in a row. */
export async function runLines(lines: string[]) {
  if (!(await host.confirmDiscard())) return;
  const results = host.results;
  results.onkeydown = null;
  disposeEditor();
  view = null;
  const summary = el("div", "db-summary muted", "Running…");
  results.replaceChildren(summary);
  showPanelView("Database", results);
  const commands: string[][] = [];
  for (const [i, line] of lines.entries()) {
    const args = splitCommand(line);
    if (!args) return summary.replaceChildren(el("span", "db-error", `Line ${i + 1} has an unclosed quote: ${line}`));
    commands.push(args);
  }
  if (!(await confirmCommands(commands))) return summary.replaceChildren("Cancelled.");
  const started = performance.now();
  let replies: Reply[];
  try {
    replies = await call(commands);
  } catch (e) {
    return summary.replaceChildren(el("span", "db-error", message(e)));
  }
  const errors = replies.filter(isError).length;
  summary.replaceChildren(`${commands.length} commands in ${Math.round(performance.now() - started)} ms${errors ? ` · ${errors} failed` : ""}`);
  const failed = replies.map((r, i) => (isError(r) ? i + 1 : 0)).filter(Boolean);
  if (failed.length) summary.append(` (line ${failed.slice(0, 10).join(", ")}${failed.length > 10 ? ", …" : ""})`);
  results.append(dataGrid({ columns: ["command", "reply"], rows: lines.map((line, i) => [line, replyText(replies[i])]), toolbar: summary }).element);
}

/** Command docs from the server, for completion and signature help: COMMAND DOCS (Redis 7), or COMMAND's names. */
let docs: { id: string; list: Promise<CommandDoc[]> } | null = null;
function commandList() {
  const id = connectionId(host.connection());
  if (docs?.id === id) return docs.list;
  const names = async () => ((await one("COMMAND")) as Reply[]).map((c) => String((c as Reply[])[0]).toUpperCase()).sort().map((name) => ({ name, summary: "", syntax: name, group: "", since: "" }));
  const list = one("COMMAND", "DOCS").then(commandDocs, names).catch(() => [] as CommandDoc[]);
  docs = { id, list };
  return list;
}

/** The command a console line up to the caret is on, by its first word, or first two for a subcommand. */
async function docFor(line: string) {
  const words = line.trim().split(/\s+/);
  const list = await commandList();
  return list.find((d) => d.name === `${words[0]} ${words[1] ?? ""}`.toUpperCase()) ?? list.find((d) => d.name === words[0].toUpperCase());
}

function registerConsole() {
  const redis = () => host.connection()?.driver === "redis";
  // Monaco's Redis grammar, with the console's # comments, which it would read as commands.
  monaco.languages.setMonarchTokensProvider("redis", { ...redisGrammar, tokenizer: { ...redisGrammar.tokenizer, root: [[/^\s*#.*$/, "comment"], ...redisGrammar.tokenizer.root] } });
  monaco.languages.registerCompletionItemProvider("redis", {
    async provideCompletionItems(model, position) {
      if (!redis()) return { suggestions: [] };
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      if (line.trimStart().startsWith("#")) return { suggestions: [] };
      const typed = line.match(/[^\s"']*$/)![0];
      const range = new monaco.Range(position.lineNumber, position.column - typed.length, position.lineNumber, position.column);
      const words = line.trimStart().split(/\s+/);
      const { Function, Method, Field } = monaco.languages.CompletionItemKind;
      if (words.length === 1) {
        return {
          suggestions: (await commandList())
            .filter((d) => !d.name.includes(" "))
            .map((d) => ({ label: d.name, kind: Function, detail: d.summary, documentation: d.syntax, insertText: `${d.name} `, range, command: { id: "editor.action.triggerParameterHints", title: "" } })),
        };
      }
      const subcommands = words.length === 2 ? (await commandList()).filter((d) => d.name.startsWith(`${words[0].toUpperCase()} `)) : [];
      if (subcommands.length)
        return { suggestions: subcommands.map((d) => ({ label: d.name.split(" ")[1], kind: Method, detail: d.summary, documentation: d.syntax, insertText: `${d.name.split(" ")[1]} `, range })) };
      // Keys from the tree, and from one SCAN for the typed prefix, which finds keys the tree hasn't loaded.
      const keys = new Map([...scan.keys].filter(([k]) => k.startsWith(typed)));
      if (typed) {
        const found = await call([["SCAN", "0", "MATCH", `${globEscape(typed)}*`, "COUNT", "1000"]]).catch(() => []);
        const batch = Array.isArray(found[0]) ? ((found[0] as Reply[])[1] as Reply[]) : [];
        for (const k of batch) if (typeof k === "string" && !keys.has(k)) keys.set(k, "");
      }
      return {
        suggestions: [...keys].slice(0, 500).map(([k, type]) => ({ label: k, kind: Field, detail: typeName[type] ?? "key", insertText: /[\s"']/.test(k) ? commandLine([k]) : k, range })),
      };
    },
  });
  monaco.languages.registerSignatureHelpProvider("redis", {
    signatureHelpTriggerCharacters: [" "],
    signatureHelpRetriggerCharacters: [" "],
    async provideSignatureHelp(model, position) {
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      if (!redis() || !/\S\s/.test(line.trimStart()) || line.trimStart().startsWith("#")) return null;
      const doc = await docFor(line);
      if (!doc) return null;
      return { value: { signatures: [{ label: doc.syntax, documentation: doc.summary, parameters: [] }], activeSignature: 0, activeParameter: 0 }, dispose() {} };
    },
  });
  monaco.languages.registerHoverProvider("redis", {
    async provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      const line = model.getLineContent(position.lineNumber);
      if (!redis() || !word || line.slice(0, word.startColumn - 1).trim()) return null;
      const doc = await docFor(line);
      if (!doc) return null;
      return { contents: [{ value: `\`\`\`\n${doc.syntax}\n\`\`\`` }, { value: [doc.summary, doc.since && `Since Redis ${doc.since}.`].filter(Boolean).join(" ") }] };
    },
  });
}

export function initRedis(h: RedisHost) {
  host = h;
  const add = iconButton("add", "Add Key…", guard(() => addKey()));
  add.id = "redis-add";
  add.hidden = true;
  $("db-console").before(add);
  const tree = $("db-tables");
  tree.tabIndex = 0;
  tree.addEventListener("keydown", onTreeKey);
  registerConsole();
}
