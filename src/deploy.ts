// Deployment, as PhpStorm has it: servers reached over SFTP, FTP, or FTPS (src-tauri/src/deploy.rs), with
// mappings from project folders to server folders (deploydata.ts). This module has the actions (Upload to,
// Download from, Delete from, Sync with Deployed, Compare with Deployed Version), uploads and deletions on save, the
// transfer queue and its File Transfer panel and status bar item, and the Remote Host tool window, whose files
// reload when the server's copy changes. Servers are edited in deployservers.ts.
//
// Transfers run in the background, one file each, at most a few at a time per server, so the window never waits on
// the network. A network error is retried twice on its own; other failures stay in the queue with Retry, and a
// toast says what failed. Uploads replace a server's file only once the new one is complete (deploy.rs).
import { Channel, invoke } from "@tauri-apps/api/core";
import { appCacheDir, homeDir } from "@tauri-apps/api/path";
import { h, icon, iconButton, toast } from "./dom";
import { type DeployServer, type FileInfoLike, formatBytes, formatTime, foldersBetween, hostKeyProblem, joinRemote, listSome, localFor, loginNeeded, type Placed, readServers, remoteFor, type SshAlias, transient, type UploadOnSave, webUrlFor, writeServer } from "./deploydata";
import { askJumpLogin, openDeploymentServers, trustHostKey } from "./deployservers";
import { type MenuItem, showMenu } from "./files";
import { showDiff } from "./git";
import { listNav } from "./listnav";
import { keyText, trash } from "./platform.ts";
import { recordBeforeDelete } from "./localhistory";
import { confirm, pick, rank, type Item } from "./palette";
import { onProjectValue, projectScope, projectValue, setProjectScope, setProjectValue } from "./projectstate";
import { errorText, showError, status } from "./status";
import { closeView, showEditorView, showPanelView } from "./terminal";

type Host = {
  root(): string;
  openFile(path: string): unknown;
  /** Whether an open tab has unsaved changes. */
  dirty(path: string): boolean;
  /** An open file's text, or undefined when it isn't open. */
  openText(path: string): string | undefined;
  showView(name: string): void;
  /** Every open file. */
  openPaths(): string[];
  /** Reads an open file from disk again, as one edit that undo reverts. */
  reload(path: string): Promise<void>;
  /** Shows a bar above a file's editor, or removes it for null. */
  notice(path: string, make: (() => HTMLElement) | null): void;
};

let host: Host;
const $ = (id: string) => document.getElementById(id)!;

// ---- Servers ----

const SERVERS = "deploymentServers";
const DEFAULT = "deploymentServer";
const ON_SAVE = "deploymentUploadOnSave";

export const servers = () => readServers(projectValue(SERVERS));
const named = (name: string) => servers().find((s) => s.name === name);
/** The default server: the one chosen, or the only one. */
export const defaultServer = () => named(projectValue<string>(DEFAULT) ?? "") ?? (servers().length === 1 ? servers()[0] : undefined);
const uploadOnSave = (): UploadOnSave => projectValue<UploadOnSave>(ON_SAVE) ?? "never";

/** The password store's name for a server's password or passphrase: by project and server. */
const account = (name: string) => `${host.root()}#${name}`;

/** A server as deploy.rs takes it. `secret` is a password typed in the settings and not saved yet. */
const wire = (s: DeployServer, secret?: string, saved = s.name) => ({ protocol: s.protocol, host: s.host.trim(), port: s.port, user: s.user, auth: s.auth, keyFile: s.keyFile, passive: s.passive, insecureTls: s.insecureTls, account: account(saved), secret });

/** Questions being asked, by what they're about, so transfers that start together ask once. */
const asking = new Map<string, Promise<boolean>>();

/** Asks once for `key` while the question is open; `grace` keeps the answer a moment for transfers still failing. */
function askOnce(key: string, ask: () => Promise<boolean>, grace: number): Promise<boolean> {
  if (!asking.has(key)) asking.set(key, ask().finally(() => (grace ? setTimeout(() => asking.delete(key), grace) : asking.delete(key))));
  return asking.get(key)!;
}

/**
 * Runs a call to the server, answering what the connection asks first: whether to trust an SSH key that isn't
 * known yet or changed, and a jump host's password or key passphrase, saved in the password store. Each answer
 * runs the call again, which can ask the next question, such as the server's key after a jump host's password.
 */
async function reach<T>(run: () => Promise<T>): Promise<T> {
  for (let round = 0; ; round++) {
    try {
      return await run();
    } catch (e) {
      const text = String(e);
      const problem = hostKeyProblem(text);
      const login = problem ? null : loginNeeded(text);
      if ((!problem && !login) || round >= 10) throw e;
      if (problem) {
        const trusted = await askOnce(`key ${problem.host}:${problem.port}`, async () => (await trustHostKey(problem)) && (await invoke("deploy_trust_host", { host: problem.host, port: problem.port, key: problem.key, line: problem.line }), true), 1000);
        // Not "not connected", which transient() would retry, asking again.
        if (!trusted) throw new Error(`${problem.shown ?? problem.host}'s key isn't trusted, so Tusk didn't connect.`);
      } else if (login) {
        // No grace: a refused password asks again at once.
        const typed = await askOnce(`login ${login.account}`, async () => {
          const secret = await askJumpLogin(login);
          return secret !== null && (await invoke("deploy_set_secret", { account: login.account, secret }), true);
        }, 0);
        if (!typed) throw new Error(`Tusk didn't connect: the jump host ${login.hop} needs a ${login.kind}.`);
      }
    }
  }
}

/** Asks for a server, with the default first; null when there are none or you cancel. Offers to add one. */
async function chooseServer(title: string): Promise<DeployServer | null> {
  const list = servers();
  if (!list.length) {
    toast("Add a server first: Tusk uploads over SFTP, FTP, or FTPS.", { kind: "info", action: { label: "Add a Server…", run: () => editServers() } });
    return null;
  }
  const first = defaultServer();
  const ordered = first ? [first, ...list.filter((s) => s !== first)] : list;
  return new Promise((resolve) => {
    const items: Item[] = ordered.map((s) => ({ label: s.name, detail: `${s.protocol.toUpperCase().replace("-IMPLICIT", "")} · ${s.user ? `${s.user}@` : ""}${s.host}${s.rootPath ? ` · ${s.rootPath}` : ""}${s === first ? " · default" : ""}`, icon: s === first ? "codicon-star-full" : "codicon-remote", run: () => resolve(s) }));
    pick(title, (q) => rank(q, items), 0, { value: "", title, onCancel: () => resolve(null) });
  });
}

const serverFor = async (server: DeployServer | undefined | "choose", title: string) => (server === "choose" ? chooseServer(title) : (server ?? defaultServer() ?? chooseServer(title)));

/** Whether a project path is a folder: read_dir only reads folders. */
const isFolder = (path: string) => invoke("read_dir", { path }).then(() => true, () => false);
const relative = (path: string) => (path === host.root() ? "the project" : path.startsWith(`${host.root()}/`) ? path.slice(host.root().length + 1) : path);
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;
const parentOf = (path: string) => (path.lastIndexOf("/") > 0 ? path.slice(0, path.lastIndexOf("/")) : "/");

/** Opens the Deployment settings, on a server's form. */
export async function editServers(selected?: string) {
  const root = host.root();
  if (!root) return;
  const before = servers();
  const result = await openDeploymentServers({
    root,
    servers: before,
    selected,
    defaultServer: defaultServer()?.name ?? "",
    uploadOnSave: uploadOnSave(),
    shared: projectScope(SERVERS) === "shared",
    hasSecret: (name) => invoke<boolean>("deploy_has_secret", { account: account(name) }),
    test: (s, previous, secret) => reach(() => invoke<string>("deploy_test", { server: wire(s, secret, previous ?? s.name), root: s.rootPath })),
    home: (s, previous, secret) => reach(() => invoke<string>("deploy_home", { server: wire(s, secret, previous ?? s.name) })),
    sshHosts: () => invoke<SshAlias[]>("deploy_ssh_hosts"),
    homeDir: (await homeDir().catch(() => "")).replace(/\/+$/, ""),
  });
  if (!result) return;
  try {
    for (const name of result.removed) await invoke("deploy_set_secret", { account: account(name), secret: "" });
    for (const [from, to] of Object.entries(result.renamed)) await invoke("deploy_move_secret", { from: account(from), to: account(to) });
    // The record of what's on each server follows its name, and goes with it.
    for (const name of result.removed) await invoke("deploy_snapshot_move", { root, from: name, to: null }).catch(() => {});
    for (const [from, to] of Object.entries(result.renamed)) await invoke("deploy_snapshot_move", { root, from, to }).catch(() => {});
    for (const [name, secret] of Object.entries(result.secrets)) await invoke("deploy_set_secret", { account: account(name), secret });
    await setProjectValue(SERVERS, result.servers.length ? result.servers.map(writeServer) : undefined);
    await setProjectValue(DEFAULT, result.defaultServer || undefined, "local");
    await setProjectValue(ON_SAVE, result.uploadOnSave === "never" ? undefined : result.uploadOnSave, "local");
    if (result.servers.length) await setProjectScope(SERVERS, result.shared ? "shared" : "local");
    // Settings changed: log in again with them.
    await invoke("deploy_disconnect");
  } catch (e) {
    return showError("Can't save the deployment servers", e);
  }
  remote.serversChanged();
}

// ---- The transfer queue ----

type Batch = { server: DeployServer; up: boolean; files: Transfer[]; quiet: boolean; title: string; reported: boolean; after?: () => void };
type Transfer = { id: number; batch: Batch; local: string; remote: string; label: string; size: number; done: number; state: "queued" | "running" | "done" | "failed" | "canceled"; error?: string; tries: number; started?: number };

const transfers: Transfer[] = [];
let ids = 1;
/** How many files go at once to one server: SFTP takes several channels well; FTP servers often limit logins. */
const limit = (s: DeployServer) => (s.protocol === "sftp" ? 4 : 2);
const KEEP_FINISHED = 500;

function enqueue(server: DeployServer, up: boolean, files: { local: string; remote: string; size: number }[], o: { quiet?: boolean; title: string; after?: () => void }) {
  const batch: Batch = { server, up, files: [], quiet: !!o.quiet, title: o.title, reported: false, after: o.after };
  for (const f of files) {
    // A save while the same file waits to upload needs no second upload: the waiting one reads the newest text.
    if (transfers.some((t) => t.state === "queued" && t.batch.up === up && t.local === f.local && t.remote === f.remote && t.batch.server.name === server.name)) continue;
    batch.files.push({ id: ids++, batch, local: f.local, remote: f.remote, label: up ? relative(f.local) : f.remote, size: f.size, done: 0, state: "queued", tries: 0 });
  }
  if (!batch.files.length) return o.after?.();
  transfers.push(...batch.files);
  // Old finished transfers go, so the list stays short.
  const finished = transfers.filter((t) => t.state === "done" || t.state === "canceled");
  if (finished.length > KEEP_FINISHED) for (const t of finished.slice(0, finished.length - KEEP_FINISHED)) transfers.splice(transfers.indexOf(t), 1);
  if (!batch.quiet) status(`${up ? "Uploading" : "Downloading"} ${batch.files.length === 1 ? nameOf(batch.files[0].local) : `${batch.files.length} files`} ${up ? "to" : "from"} ${server.name}…`, "deploy", "info");
  pump();
}

function pump() {
  const running = new Map<string, number>();
  for (const t of transfers) if (t.state === "running") running.set(t.batch.server.name, (running.get(t.batch.server.name) ?? 0) + 1);
  for (const t of transfers) {
    if (t.state !== "queued") continue;
    const n = running.get(t.batch.server.name) ?? 0;
    if (n >= limit(t.batch.server)) continue;
    running.set(t.batch.server.name, n + 1);
    void run(t);
  }
  render();
}

async function run(t: Transfer) {
  t.state = "running";
  t.started = Date.now();
  t.error = undefined;
  const progress = new Channel<[number, number]>();
  progress.onmessage = ([done, size]) => ((t.done = done), (t.size = size), render());
  const s = t.batch.server;
  try {
    await reach(() =>
      t.batch.up
        ? invoke("deploy_upload", { server: wire(s), local: t.local, remote: t.remote, id: t.id, progress })
        : invoke("deploy_download", { server: wire(s), remote: t.remote, local: t.local, id: t.id, progress }),
    );
    // Cancel can change the state while the call runs.
    const canceled = () => (t.state as Transfer["state"]) === "canceled";
    if (!canceled()) (t.state = "done"), (t.done = t.size);
  } catch (e) {
    const text = errorText(e);
    if ((t.state as Transfer["state"]) === "canceled" || text === "Canceled") t.state = "canceled";
    else if (transient(text) && t.tries < 2) {
      // The network dropped: wait a moment and try again, in the queue's order.
      t.tries++;
      t.state = "queued";
      t.done = 0;
      await new Promise((r) => setTimeout(r, 1000 * t.tries));
    } else (t.state = "failed"), (t.error = text);
  }
  finishBatch(t.batch);
  pump();
}

/** Reports a batch once all its files are done: quietly when it worked, with a toast and Retry when some failed. */
function finishBatch(b: Batch) {
  if (b.reported || b.files.some((t) => t.state === "queued" || t.state === "running")) return;
  b.reported = true;
  const failed = b.files.filter((t) => t.state === "failed");
  const done = b.files.filter((t) => t.state === "done");
  const verb = b.up ? "upload" : "download";
  const where = `${b.up ? "to" : "from"} ${b.server.name}`;
  if (failed.length) {
    const what = b.files.length === 1 ? nameOf(failed[0].local) : `${failed.length} of ${b.files.length} files`;
    toast(`Couldn't ${verb} ${what} ${where}: ${failed[0].error}`, {
      action: [
        { label: "Retry", run: () => retry(failed) },
        { label: "Show Transfers", run: showTransfers },
      ],
    });
  } else if (done.length) {
    status(`${b.up ? "Uploaded" : "Downloaded"} ${done.length === 1 ? nameOf(done[0].local) : `${done.length} files`} ${where}`, "deploy", "info");
  }
  if (done.length) b.after?.();
  // Both copies are the same now, for finding deletions made while Tusk was closed.
  if (done.length) record(b.server, { add: done.map((t) => t.local) });
  // Remote Host shows what was uploaded.
  if (b.up && done.length) remote.changedOn(b.server);
}

function retry(list: Transfer[]) {
  for (const t of list) if (t.state === "failed" || t.state === "canceled") (t.state = "queued"), (t.done = 0), (t.tries = 0), (t.error = undefined), (t.batch.reported = false);
  pump();
}

function cancel(list: Transfer[]) {
  for (const t of list) {
    if (t.state === "queued") t.state = "canceled";
    else if (t.state === "running") (t.state = "canceled"), void invoke("deploy_cancel", { id: t.id });
  }
  for (const b of new Set(list.map((t) => t.batch))) finishBatch(b);
  pump();
}

// ---- The status bar item and File Transfer panel ----

let renderQueued = false;
/** Redraws the status bar item and the panel at most once a frame, since progress arrives often. */
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderStatus();
    if (panel.isConnected) renderPanel();
  });
}

let statusTimer: ReturnType<typeof setTimeout> | undefined;
function renderStatus() {
  const el = $("deploy-status");
  const active = transfers.filter((t) => t.state === "queued" || t.state === "running");
  const failed = transfers.filter((t) => t.state === "failed");
  clearTimeout(statusTimer);
  if (active.length) {
    const batchFiles = transfers.filter((t) => active.some((a) => a.batch === t.batch));
    const total = batchFiles.reduce((n, t) => n + (t.size || 0), 0);
    const done = batchFiles.reduce((n, t) => n + (t.state === "done" ? t.size : t.done), 0);
    const finished = batchFiles.filter((t) => t.state !== "queued" && t.state !== "running").length;
    const up = active.some((t) => t.batch.up);
    el.hidden = false;
    el.className = "status-item deploy-busy";
    el.replaceChildren(h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), `${up ? "Uploading" : "Downloading"} ${Math.min(finished + 1, batchFiles.length)} of ${batchFiles.length}`, h("span", { class: "deploy-status-bar" }, h("span", { style: `width: ${total ? Math.min(100, (done / total) * 100).toFixed(1) : 0}%` })));
    el.title = `${active.length} file${active.length === 1 ? "" : "s"} left · Click to show File Transfer`;
  } else if (failed.length) {
    el.hidden = false;
    el.className = "status-item deploy-failed";
    el.replaceChildren(icon("warning"), `${failed.length} transfer${failed.length === 1 ? "" : "s"} failed`);
    el.title = "Click to show File Transfer, where you can retry them";
  } else el.hidden = true;
}

const panel = h("div", { class: "deploy-panel" });
export function showTransfers() {
  renderPanel();
  showPanelView("File Transfer", panel);
}

function renderPanel() {
  const active = transfers.filter((t) => t.state === "queued" || t.state === "running");
  const failed = transfers.filter((t) => t.state === "failed");
  const finished = transfers.filter((t) => t.state === "done" || t.state === "canceled");
  const toolbar = h(
    "div",
    { class: "deploy-panel-toolbar" },
    h("span", { class: "deploy-panel-summary" }, active.length ? `${active.length} in progress` : failed.length ? `${failed.length} failed` : transfers.length ? "All done" : "No transfers yet"),
    h("span", { class: "spacer" }),
    failed.length ? h("button", { onclick: () => retry(failed) }, icon("refresh"), `Retry ${failed.length} Failed`) : null,
    active.length ? h("button", { onclick: () => cancel(active) }, icon("debug-stop"), "Cancel All") : null,
    finished.length || failed.length ? h("button", { onclick: () => (transfers.splice(0, transfers.length, ...active), render()) }, icon("clear-all"), "Clear Finished") : null,
  );
  // Newest first: running, then waiting, then what failed, then what's done.
  const order = { running: 0, queued: 1, failed: 2, canceled: 3, done: 4 };
  const rows = [...transfers].sort((a, b) => order[a.state] - order[b.state] || b.id - a.id).slice(0, 400);
  const list = h(
    "ul",
    { class: "deploy-transfers", role: "list" },
    ...rows.map((t) => {
      const pct = t.size ? Math.min(100, (t.done / t.size) * 100) : t.state === "done" ? 100 : 0;
      const stateIcon = { running: "loading codicon-modifier-spin", queued: "clock", done: "pass-filled", failed: "error", canceled: "circle-slash" }[t.state];
      return h(
        "li",
        { class: `deploy-transfer ${t.state}`, title: `${t.local}\n${t.batch.up ? "→" : "←"} ${t.batch.server.name}:${t.remote}` },
        h("span", { class: `codicon codicon-${stateIcon}` }),
        icon(t.batch.up ? "arrow-up" : "arrow-down"),
        h("span", { class: "deploy-transfer-name" }, t.label),
        h("span", { class: "deploy-transfer-server" }, t.batch.server.name),
        t.state === "failed" ? h("span", { class: "deploy-transfer-error" }, t.error ?? "") : h("span", { class: "deploy-progress", ariaLabel: `${Math.round(pct)}%` }, h("span", { style: `width: ${pct.toFixed(1)}%` })),
        h("span", { class: "deploy-transfer-size" }, t.state === "running" && t.size ? `${formatBytes(t.done)} of ${formatBytes(t.size)}` : t.size ? formatBytes(t.size) : ""),
        t.state === "queued" || t.state === "running" ? iconButton("close", "Cancel", () => cancel([t])) : t.state === "failed" || t.state === "canceled" ? iconButton("refresh", "Retry", () => retry([t])) : t.batch.up ? null : iconButton("go-to-file", "Open", () => host.openFile(t.local)),
      );
    }),
  );
  if (!transfers.length) list.append(h("li", { class: "deploy-transfers-empty" }, "Files you upload or download show here, with their progress."));
  panel.replaceChildren(toolbar, list);
}

// ---- Uploading and downloading ----

/** Uploads project files and folders through the server's mappings, leaving out its exclusions. */
export async function upload(paths: string[], server?: DeployServer | "choose", o: { quiet?: boolean } = {}) {
  const s = await serverFor(server, "Upload to");
  if (!s) return;
  const files: { local: string; remote: string; size: number }[] = [];
  const outside: string[] = [];
  for (const path of paths) {
    const at = remoteFor(s, host.root(), path);
    if (!at) {
      outside.push(relative(path));
      continue;
    }
    const found = await invoke<FileInfoLike[]>("deploy_local_files", { root: at.localRoot, paths: [path], excludes: s.excludes });
    for (const f of found) files.push({ local: `${at.localRoot}/${f.path}`, remote: joinRemote(at.remoteRoot, f.path), size: f.size });
  }
  if (outside.length && !o.quiet)
    toast(`${outside.join(", ")} ${outside.length === 1 ? "isn't" : "aren't"} in ${s.name}'s mappings, so Tusk doesn't know where ${outside.length === 1 ? "it goes" : "they go"}.`, { kind: "info", action: { label: "Edit Mappings…", run: () => editServers(s.name) } });
  if (!files.length) {
    if (!outside.length && !o.quiet) status(`Nothing to upload: ${s.name}'s excluded paths leave out ${paths.length === 1 ? relative(paths[0]) : "those files"}.`, "deploy", "info");
    return;
  }
  enqueue(s, true, files, { quiet: o.quiet, title: `Upload to ${s.name}` });
}

/** Downloads project files and folders from the server through its mappings, replacing the local copies. */
export async function download(paths: string[], server?: DeployServer | "choose") {
  const s = await serverFor(server, "Download from");
  if (!s) return;
  const files: { local: string; remote: string; size: number }[] = [];
  try {
    await withSpinner(`Listing ${s.name}…`, async (id) => {
      for (const path of paths) {
        const at = remoteFor(s, host.root(), path);
        if (!at) {
          toast(`${relative(path)} isn't in ${s.name}'s mappings.`, { kind: "info", action: { label: "Edit Mappings…", run: () => editServers(s.name) } });
          continue;
        }
        if (!(await isFolder(path)) && (await invoke<boolean>("path_exists", { path }))) files.push({ local: path, remote: at.remote, size: 0 });
        else {
          const prefix = path === at.localRoot ? "" : path.slice(at.localRoot.length + 1);
          const found = await reach(() => invoke<FileInfoLike[]>("deploy_remote_files", { server: wire(s), dir: at.remote, excludes: s.excludes, prefix, id }));
          for (const f of found) files.push({ local: `${path}/${f.path}`, remote: joinRemote(at.remote, f.path), size: f.size });
        }
      }
    });
  } catch (e) {
    return showError(`Can't list ${s.name}`, e);
  }
  if (!files.length) return status(`Nothing to download from ${s.name}.`, "deploy", "info");
  if (!(await safeToReplace(files.map((f) => f.local)))) return;
  enqueue(s, false, files, { title: `Download from ${s.name}` });
}

/** Asks before a download replaces open files with unsaved changes. */
async function safeToReplace(locals: string[]) {
  const dirty = locals.filter((p) => host.dirty(p));
  if (!dirty.length) return true;
  return confirm(`Replace unsaved changes in ${dirty.length === 1 ? nameOf(dirty[0]) : `${dirty.length} open files`} with the server's copy?`, "Download and Replace");
}

/**
 * Asks before deleting, listing what goes. Cancel (or `keep`, its label when declining means something) is the
 * default. Resolves to true to delete, false for Cancel or `keep`, and null when `keep` is given and the dialog is
 * dismissed without choosing.
 */
function confirmDeletion(title: string, intro: string, paths: string[], action: string, keep?: string): Promise<boolean | null> {
  const { shown, more } = listSome([...paths].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
  let yes: boolean | null = keep ? null : false;
  const go = h("button", { type: "button", class: "danger", onclick: () => ((yes = true), dialog.close()) }, icon("trash"), action);
  const cancel = h("button", { type: "button", class: "primary", onclick: () => ((yes = false), dialog.close()) }, keep ?? "Cancel");
  const dialog = h(
    "dialog",
    { class: "refactor-dialog deploy-delete", ariaLabel: title },
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, icon("warning"), title),
      h("p", {}, intro),
      h("ul", { class: "deploy-delete-list" }, ...shown.map((p) => h("li", { title: p }, p)), more ? h("li", { class: "muted" }, `and ${more} more`) : null),
      h("div", { class: "buttons" }, cancel, go),
    ),
  );
  dialog.addEventListener("keydown", (e) => e.stopPropagation());
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.onclose = () => (dialog.remove(), resolve(yes));
    dialog.showModal();
    cancel.focus();
  });
}

/**
 * Deletes the server's copies of project files and folders, asking first unless `ask` is false. A mapping's own
 * folder is never deleted this way: that would take the whole site.
 */
export async function deleteFromServer(paths: string[], server?: DeployServer | "choose", o: { ask?: boolean } = {}) {
  const s = await serverFor(server, "Delete from");
  if (!s) return;
  const placed = paths.map((p) => remoteFor(s, host.root(), p)).filter((p): p is Placed => !!p && p.local !== p.localRoot);
  if (!placed.length) return status(paths.length === 1 && remoteFor(s, host.root(), paths[0]) ? `${relative(paths[0])} is a mapping's folder; delete what's in it on Remote Host instead.` : `${paths.length === 1 ? relative(paths[0]) : "Those files"} aren't in ${s.name}'s mappings.`, "deploy", "info");
  const remotes = placed.map((p) => p.remote);
  const what = remotes.length === 1 ? nameOf(remotes[0]) : `${remotes.length} items`;
  if (o.ask !== false && !(await confirmDeletion(`Delete ${what} from ${s.name}?`, `This deletes the server's ${remotes.length === 1 ? "copy" : "copies"} in ${placed[0].remoteRoot || "the login folder"}, and everything inside a folder. The project keeps its own. This can't be undone.`, placed.map((p) => relative(p.local)), `Delete from ${s.name}`))) return;
  try {
    status(`Deleting ${what} from ${s.name}…`, "deploy:progress");
    const deleted = await reach(() => invoke<number>("deploy_delete", { server: wire(s), paths: remotes }));
    record(s, { remove: placed.map((p) => p.local) });
    status(deleted ? `Deleted ${deleted === remotes.length ? what : `${deleted} of ${remotes.length} items`} from ${s.name}` : `${what} ${remotes.length === 1 ? "wasn't" : "weren't"} on ${s.name}`, "deploy", "info");
  } catch (e) {
    toast(`Couldn't delete ${what} from ${s.name}: ${errorText(e)}`, { action: { label: "Retry", run: () => deleteFromServer(paths, s, { ask: false }) } });
  } finally {
    status("", "deploy:progress");
  }
  remote.changedOn(s);
}

/** How many files one burst of deletions may take from the server without asking, as a branch switch would exceed. */
const QUIET_DELETES = 20;

/**
 * Project files changed on disk: when the default server deletes what you delete, and saved files upload to it,
 * deletes the server's copies of files that are gone. Files that appeared in the same burst, as a move or rename
 * makes, upload, so the server doesn't lose them. More than a few deletions at once ask first.
 */
export async function filesDeleted(paths: string[]) {
  const s = defaultServer();
  if (!s?.deleteRemote || uploadOnSave() === "never" || !host?.root()) return;
  const placed = paths.filter((p) => !/\.tusk-(download|upload|old)$/.test(p)).map((p) => remoteFor(s, host.root(), p)).filter((p): p is Placed => !!p && p.local !== p.localRoot);
  if (!placed.length) return;
  const exists = await invoke<boolean[]>("paths_exist", { paths: placed.map((p) => p.local) });
  let gone = placed.filter((_, i) => !exists[i]);
  if (!gone.length) return;
  const excluded = await invoke<boolean[]>("deploy_excluded", { excludes: s.excludes, paths: gone.map((p) => p.local.slice(p.localRoot.length + 1)) });
  gone = gone.filter((_, i) => !excluded[i]);
  // A folder deleted with its files: deleting the folder deletes them.
  gone = gone.filter((p) => !gone.some((o) => o !== p && p.remote.startsWith(`${o.remote}/`)));
  if (!gone.length) return;
  const added = placed.filter((_, i) => exists[i]).map((p) => p.local);
  if (added.length) void upload(added, s, { quiet: true });
  if (gone.length > QUIET_DELETES)
    return toast(`${gone.length} files in ${s.name}'s mappings were deleted here, such as by a branch switch. Delete them from ${s.name} too?`, { kind: "info", action: { label: "Review…", run: () => deleteFromServer(gone.map((p) => p.local), s) } });
  void deleteFromServer(gone.map((p) => p.local), s, { ask: false });
}

// ---- What Tusk put on each server ----

/** A project file's path relative to the project, as deploy.rs records it; null outside the project. */
const projectRel = (path: string) => (path === host.root() ? "" : path.startsWith(`${host.root()}/`) ? path.slice(host.root().length + 1) : null);

/**
 * Updates deploy.rs's record of the project files on a server: `add` are there now, as they are here; `remove`
 * (files or folders) aren't; `under`, a project folder, is replaced by `add` whole. Server files opened from Remote
 * Host aren't in the project, so they aren't recorded.
 */
function record(s: DeployServer, o: { add?: string[]; remove?: string[]; under?: string }) {
  const rel = (paths: string[] = []) => paths.map(projectRel).filter((p): p is string => p !== null);
  const add = rel(o.add);
  const remove = rel(o.remove).filter(Boolean);
  const under = o.under === undefined ? null : projectRel(o.under);
  if (!add.length && !remove.length && under === null) return;
  invoke("deploy_snapshot_update", { root: host.root(), server: s.name, under, add, remove }).catch((e) => console.warn("deploy: can't record", e));
}

/**
 * Files Tusk put on the default server that were deleted here while it was closed, such as by a branch switch in
 * a terminal: when that server deletes what you delete, one confirmation lists them before they go there too.
 * **Keep on Server** forgets them, so they're not asked about again; closing the dialog asks next time.
 */
async function closedDeletions() {
  const s = defaultServer();
  const root = host?.root();
  if (!s?.deleteRemote || uploadOnSave() === "never" || !root) return;
  const missing = await invoke<FileInfoLike[]>("deploy_snapshot_missing", { root, server: s.name }).catch(() => []);
  if (!missing.length) return;
  const locals = missing.map((f) => `${root}/${f.path}`);
  let placed = locals.map((l) => remoteFor(s, root, l)).filter((p): p is Placed => !!p && p.local !== p.localRoot);
  const excluded = await invoke<boolean[]>("deploy_excluded", { excludes: s.excludes, paths: placed.map((p) => p.local.slice(p.localRoot.length + 1)) });
  placed = placed.filter((_, i) => !excluded[i]);
  // What the mappings no longer send there, or now exclude, isn't Tusk's to delete: forget it.
  const unmapped = locals.filter((l) => !placed.some((p) => p.local === l));
  if (unmapped.length) record(s, { remove: unmapped });
  if (!placed.length || host.root() !== root) return;
  const n = placed.length;
  const files = `${n} file${n === 1 ? "" : "s"}`;
  const choice = await confirmDeletion(
    `Delete ${n === 1 ? nameOf(placed[0].local) : files} from ${s.name}?`,
    `${n === 1 ? "This file was" : "These files were"} uploaded to ${s.name}, then deleted in the project, such as by a branch switch while Tusk was closed. The server still has ${n === 1 ? "it" : "them"}. Deleting from the server can't be undone.`,
    placed.map((p) => relative(p.local)),
    `Delete from ${s.name}`,
    "Keep on Server",
  );
  if (choice === null || host.root() !== root) return;
  if (!choice) {
    record(s, { remove: placed.map((p) => p.local) });
    return status(`Kept ${files} on ${s.name}. Tusk won't ask about ${n === 1 ? "it" : "them"} again.`, "deploy", "info");
  }
  // Folders left empty on the server go too, when they're gone here as well.
  const folders = [...new Set(placed.flatMap((p) => foldersBetween([p.local], p.localRoot)))];
  const exists = await invoke<boolean[]>("paths_exist", { paths: folders });
  const prune = folders.filter((_, i) => !exists[i]).map((f) => remoteFor(s, root, f)!.remote);
  try {
    status(`Deleting ${files} from ${s.name}…`, "deploy:progress");
    const deleted = await reach(() => invoke<number>("deploy_delete", { server: wire(s), paths: placed.map((p) => p.remote), prune }));
    record(s, { remove: placed.map((p) => p.local) });
    status(`Deleted ${deleted} file${deleted === 1 ? "" : "s"} from ${s.name}${deleted < n ? `; ${n - deleted} weren't there anymore` : ""}`, "deploy", "info");
  } catch (e) {
    toast(`Couldn't delete ${files} from ${s.name}: ${errorText(e)}`, { action: { label: "Retry", run: () => void closedDeletions() } });
  } finally {
    status("", "deploy:progress");
  }
  remote.changedOn(s);
}

/** Runs a listing with a spinner in the status bar and Cancel, which stops deploy.rs's walk by `id`. */
async function withSpinner<T>(label: string, task: (id: number) => Promise<T>): Promise<T> {
  const id = ids++;
  status(label, "deploy:progress");
  try {
    return await task(id);
  } finally {
    status("", "deploy:progress");
  }
}

/** Uploads a saved file when the settings say so, and always for a server file opened from Remote Host. */
export function afterSave(path: string, explicit: boolean) {
  if (!host?.root()) return;
  const origin = remoteOrigin(path);
  if (origin) {
    const s = named(origin.server);
    // Saving answers a "changed on the server" bar: yours replaces the server's.
    if (s) enqueue(s, true, [{ local: path, remote: origin.remote, size: 0 }], { quiet: true, title: `Upload to ${s.name}`, after: () => (host.notice(path, null), void remember(s, origin.remote, path)) });
    return;
  }
  const mode = uploadOnSave();
  if (mode === "never" || (mode === "explicit" && !explicit)) return;
  const s = defaultServer();
  if (s && remoteFor(s, host.root(), path)) void upload([path], s, { quiet: true });
}

// ---- Comparing ----

const readLocal = async (path: string) => host.openText(path) ?? (await invoke<string>("read_file", { path }));

/** Shows the file's differences from the server's copy in the diff view, with Upload. */
export async function compareWithDeployed(path: string, server?: DeployServer | "choose") {
  const s = await serverFor(server, "Compare with the version on");
  if (!s) return;
  const at = remoteFor(s, host.root(), path);
  if (!at) return toast(`${relative(path)} isn't in ${s.name}'s mappings.`, { kind: "info", action: { label: "Edit Mappings…", run: () => editServers(s.name) } });
  try {
    status(`Reading ${nameOf(path)} from ${s.name}…`, "deploy:progress");
    const theirs = await reach(() => invoke<string | null>("deploy_read", { server: wire(s), path: at.remote }));
    if (theirs === null) return toast(`${nameOf(path)} isn't on ${s.name} yet.`, { kind: "info", action: { label: `Upload to ${s.name}`, run: () => upload([path], s) } });
    const ours = await readLocal(path);
    if (theirs === ours) return status(`${nameOf(path)} is the same on ${s.name}.`, "deploy", "info");
    showDiff(relative(path), theirs, ours, `${s.name} ↔ Local`, { label: `Upload to ${s.name}`, title: `Replace ${at.remote} with your copy`, run: () => upload([path], s) });
  } catch (e) {
    showError(`Can't compare with ${s.name}`, e);
  } finally {
    status("", "deploy:progress");
  }
}

type Difference = { path: string; kind: "local" | "remote" | "changed"; newer: "local" | "remote" | ""; local: FileInfoLike | null; remote: FileInfoLike | null };
type Choice = "upload" | "download" | "skip" | "delete";

/** The Sync with Deployed tab: what differs between a project folder and the server, and what to do with each. */
class SyncView {
  readonly el = h("div", { class: "deploy-sync" });
  private differences: Difference[] = [];
  private choices = new Map<string, Choice>();
  private state: "comparing" | "ready" | "failed" = "comparing";
  private error = "";
  private progress = "";
  private compareId = 0;
  private list = h("ul", { class: "deploy-sync-list", role: "listbox", ariaLabel: "Differences" });
  private nav = listNav(this.list, { rows: "li[data-key]", open: (row) => this.diff(row.dataset.key!) });

  constructor(
    readonly server: DeployServer,
    readonly at: Placed,
  ) {
    this.list.addEventListener("keydown", (e) => {
      const key = this.nav.selected();
      if (!key) return;
      const choice = e.key === "ArrowRight" ? "upload" : e.key === "ArrowLeft" ? "download" : e.key === " " || e.key === "Backspace" ? "skip" : e.key === "Delete" ? "delete" : null;
      if (!choice) return;
      e.preventDefault();
      e.stopPropagation();
      this.set(key, choice);
    });
  }

  get title() {
    return `Sync ${nameOf(this.at.local)} · ${this.server.name}`;
  }

  show() {
    showEditorView(this.title, this.el, "sync", () => this.close());
    void this.compare();
  }

  private close() {
    if (this.state === "comparing") void invoke("deploy_cancel", { id: this.compareId });
    syncViews.delete(this.key);
  }

  get key() {
    return `${this.server.name}\n${this.at.local}`;
  }

  async compare() {
    this.state = "comparing";
    this.progress = "Listing both sides…";
    this.render();
    const id = (this.compareId = ids++);
    const progress = new Channel<[number, number]>();
    progress.onmessage = ([done, total]) => {
      if (!total || this.state !== "comparing") return;
      this.progress = `Comparing the contents of ${done} of ${total} files whose times differ…`;
      this.render();
    };
    try {
      const differences = await reach(() => invoke<Difference[]>("deploy_compare", { server: wire(this.server), root: this.at.localRoot, local: this.at.local, remote: this.at.remote, excludes: this.server.excludes, id, progress }));
      if (id !== this.compareId) return;
      this.differences = differences;
      this.choices = new Map(differences.map((d) => [d.path, defaultChoice(d)]));
      this.state = "ready";
      void this.recordServerFiles(differences);
    } catch (e) {
      if (id !== this.compareId) return;
      this.state = "failed";
      this.error = errorText(e);
    }
    this.render();
  }

  /** After a comparison, every project file here that isn't only in the project is on the server: record them. */
  private async recordServerFiles(differences: Difference[]) {
    const found = await invoke<FileInfoLike[]>("deploy_local_files", { root: this.at.localRoot, paths: [this.at.local], excludes: this.server.excludes }).catch(() => null);
    if (!found) return;
    const onlyHere = new Set(differences.filter((d) => d.kind === "local").map((d) => this.localPath(d)));
    record(this.server, { under: this.at.local, add: found.map((f) => `${this.at.localRoot}/${f.path}`).filter((p) => !onlyHere.has(p)) });
  }

  private set(path: string, choice: Choice) {
    const d = this.differences.find((x) => x.path === path);
    if (!d || (choice === "upload" && !d.local) || (choice === "download" && !d.remote) || (choice === "delete" && d.kind === "changed")) return;
    this.choices.set(path, choice);
    this.render();
  }

  private setAll(choice: Choice | "newer") {
    for (const d of this.differences) this.choices.set(d.path, choice === "newer" ? defaultChoice(d) : choice === "upload" && !d.local ? "skip" : choice === "download" && !d.remote ? "skip" : choice);
    this.render();
  }

  /** Whether a single file is compared, rather than a folder; deploy.rs then names it by its file name. */
  fileMode = false;
  private localPath = (d: Difference) => (this.fileMode ? this.at.local : `${this.at.local}/${d.path}`);
  private remotePath = (d: Difference) => (this.fileMode ? this.at.remote : joinRemote(this.at.remote, d.path));

  private async diff(path: string) {
    const d = this.differences.find((x) => x.path === path);
    if (!d) return;
    const local = this.localPath(d);
    try {
      status(`Reading ${nameOf(path)} from ${this.server.name}…`, "deploy:progress");
      const theirs = d.remote ? ((await reach(() => invoke<string | null>("deploy_read", { server: wire(this.server), path: this.remotePath(d) }))) ?? "") : "";
      const ours = d.local ? await readLocal(local) : "";
      showDiff(relative(local), theirs, ours, `${this.server.name} ↔ Local`, d.local ? { label: `Upload to ${this.server.name}`, run: () => this.runOne(d, "upload") } : { label: "Download", run: () => this.runOne(d, "download") });
    } catch (e) {
      showError(`Can't compare ${nameOf(path)}`, e);
    } finally {
      status("", "deploy:progress");
    }
  }

  private runOne(d: Difference, choice: Choice) {
    this.choices.set(d.path, choice);
    void this.synchronize([d]);
  }

  private async synchronize(only?: Difference[]) {
    const list = (only ?? this.differences).filter((d) => this.choices.get(d.path) !== "skip");
    const ups = list.filter((d) => this.choices.get(d.path) === "upload").map((d) => ({ local: this.localPath(d), remote: this.remotePath(d), size: d.local?.size ?? 0 }));
    const downs = list.filter((d) => this.choices.get(d.path) === "download").map((d) => ({ local: this.localPath(d), remote: this.remotePath(d), size: d.remote?.size ?? 0 }));
    const deletes = list.filter((d) => this.choices.get(d.path) === "delete");
    const remoteDeletes = deletes.filter((d) => d.kind === "remote").map((d) => this.remotePath(d));
    const localDeletes = deletes.filter((d) => d.kind === "local").map((d) => this.localPath(d));
    if (downs.length && !(await safeToReplace(downs.map((d) => d.local)))) return;
    if (deletes.length) {
      const listed = deletes.map((d) => `${d.kind === "remote" ? this.server.name : "Project"}: ${d.path}`);
      const where = remoteDeletes.length && localDeletes.length ? `from ${this.server.name} and the project` : remoteDeletes.length ? `from ${this.server.name}` : "from the project";
      const intro = `${remoteDeletes.length ? `Deleting from ${this.server.name} can't be undone.` : ""}${localDeletes.length ? ` Project files go to the ${trash}, and Local History keeps them.` : ""}`.trim();
      if (!(await confirmDeletion(`Delete ${deletes.length} file${deletes.length === 1 ? "" : "s"} ${where}?`, intro, listed, "Delete and Synchronize"))) return;
    }
    let left = (ups.length ? 1 : 0) + (downs.length ? 1 : 0) + (deletes.length ? 1 : 0);
    const after = () => --left <= 0 && void this.compare();
    if (ups.length) enqueue(this.server, true, ups, { title: `Upload to ${this.server.name}`, after });
    if (downs.length) enqueue(this.server, false, downs, { title: `Download from ${this.server.name}`, after });
    if (deletes.length) void this.remove(remoteDeletes, localDeletes).finally(after);
    if (left) (this.state = "comparing"), (this.progress = `Synchronizing ${list.length} file${list.length === 1 ? "" : "s"}…`), this.render();
  }

  /** Deletes the chosen files: the server's with deploy_delete, the project's to the trash, kept in Local History. */
  private async remove(remotes: string[], locals: string[]) {
    try {
      if (remotes.length) await reach(() => invoke("deploy_delete", { server: wire(this.server), paths: remotes }));
      for (const path of locals) {
        await recordBeforeDelete(path, false);
        await invoke("trash_path", { path });
      }
      if (remotes.length) remote.changedOn(this.server);
    } catch (e) {
      showError(`Couldn't delete every file`, e);
    }
  }

  render() {
    const head = h(
      "header",
      { class: "deploy-sync-head" },
      h("div", { class: "deploy-sync-title" }, h("h2", {}, this.at.local === host.root() ? nameOf(host.root()) : relative(this.at.local), h("span", { class: "muted" }, ` ↔ ${this.server.name}:${this.at.remote || "~"}`))),
      h("span", { class: "spacer" }),
      iconButton("refresh", "Compare Again", () => void this.compare()),
    );
    if (this.state === "comparing")
      return this.el.replaceChildren(head, h("div", { class: "deploy-sync-wait" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), h("p", {}, this.progress), h("button", { onclick: () => (invoke("deploy_cancel", { id: this.compareId }), (this.compareId = -1), (this.state = "failed"), (this.error = "Canceled."), this.render()) }, "Cancel")));
    if (this.state === "failed")
      return this.el.replaceChildren(head, h("div", { class: "deploy-sync-wait failed" }, icon("error"), h("p", {}, this.error), h("div", { class: "deploy-sync-actions" }, h("button", { onclick: () => void this.compare() }, icon("refresh"), "Try Again"), h("button", { onclick: () => editServers(this.server.name) }, icon("settings-gear"), "Edit Server…"))));
    if (!this.differences.length) return this.el.replaceChildren(head, h("div", { class: "deploy-sync-wait same" }, icon("pass-filled"), h("p", {}, `Everything in ${relative(this.at.local)} matches ${this.server.name}.`)));
    const count = (k: Difference["kind"]) => this.differences.filter((d) => d.kind === k).length;
    const chosen = this.differences.filter((d) => this.choices.get(d.path) !== "skip").length;
    const deleting = this.differences.filter((d) => this.choices.get(d.path) === "delete").length;
    const summary = h(
      "div",
      { class: "deploy-sync-summary" },
      h("span", {}, `${this.differences.length} difference${this.differences.length === 1 ? "" : "s"}`),
      count("changed") ? h("span", { class: "chip changed" }, `${count("changed")} changed`) : null,
      count("local") ? h("span", { class: "chip local" }, `${count("local")} only in the project`) : null,
      count("remote") ? h("span", { class: "chip remote" }, `${count("remote")} only on ${this.server.name}`) : null,
      h("span", { class: "spacer" }),
      h("span", { class: "deploy-hint" }, "Set all:"),
      h("button", { onclick: () => this.setAll("newer"), title: "Upload what's newer here, download what's newer there; skip files only on the server. Nothing is deleted unless you choose it." }, "By Date"),
      h("button", { onclick: () => this.setAll("upload") }, icon("arrow-up"), "Upload"),
      h("button", { onclick: () => this.setAll("download") }, icon("arrow-down"), "Download"),
      h("button", { onclick: () => this.setAll("skip") }, "Skip"),
    );
    const scrolled = this.list.scrollTop;
    this.list.replaceChildren(
      ...this.differences.map((d) => {
        const choice = this.choices.get(d.path)!;
        const toggle = (c: Choice, name: string, title: string, disabled: boolean) =>
          h("button", { class: `deploy-choice${choice === c ? " on" : ""}`, title, disabled, ariaPressed: String(choice === c), onclick: (e: MouseEvent) => (e.stopPropagation(), this.set(d.path, c)) }, icon(name));
        const side = (f: FileInfoLike | null, newer: boolean) => h("span", { class: `deploy-side${newer ? " newer" : ""}` }, f ? `${formatBytes(f.size)} · ${formatTime(f.mtime)}` : "—");
        return h(
          "li",
          { role: "option", data: { key: d.path, label: d.path }, class: `deploy-sync-row ${d.kind}${choice === "delete" ? " deleting" : ""}`, ondblclick: () => void this.diff(d.path) },
          h(
            "span",
            { class: "deploy-choices" },
            toggle("download", "arrow-left", `Download (←)`, !d.remote),
            toggle("skip", "dash", "Skip (Space)", false),
            toggle("upload", "arrow-right", `Upload (→)`, !d.local),
            toggle("delete", "trash", d.kind === "changed" ? "Only files on one side can be deleted here" : d.kind === "remote" ? `Delete from ${this.server.name} (${keyText("⌦")})` : `Delete from the project (${keyText("⌦")})`, d.kind === "changed"),
          ),
          h("span", { class: "deploy-kind", title: d.kind === "local" ? "Only in the project" : d.kind === "remote" ? `Only on ${this.server.name}` : "Changed" }, icon(d.kind === "local" ? "diff-added" : d.kind === "remote" ? "cloud" : "diff-modified")),
          h("span", { class: "deploy-sync-path" }, d.path),
          side(d.local, d.newer === "local"),
          side(d.remote, d.newer === "remote"),
          iconButton("diff", "Compare (⏎)", () => void this.diff(d.path)),
        );
      }),
    );
    const columns = h("div", { class: "deploy-sync-columns" }, h("span", {}, "Action"), h("span", {}), h("span", {}, "File"), h("span", {}, "In the project"), h("span", {}, `On ${this.server.name}`), h("span", {}));
    const go = h("button", { class: "primary", disabled: !chosen, onclick: () => void this.synchronize() }, icon("sync"), chosen ? `Synchronize ${chosen} File${chosen === 1 ? "" : "s"}${deleting ? ` (${deleting} to Delete)` : ""}` : "Nothing to Synchronize");
    this.el.replaceChildren(head, summary, columns, this.list, h("footer", { class: "deploy-sync-foot" }, h("span", { class: "deploy-hint" }, `← download · Space skip · → upload · ${keyText("⌦")} delete · ⏎ compare`), h("span", { class: "spacer" }), go));
    this.list.scrollTop = scrolled;
    if (!this.nav.selected() && this.differences.length) this.nav.select(this.differences[0].path, { scroll: false });
  }
}

/** Upload what's newer in the project, download what's newer on the server, and leave the server's own files. */
const defaultChoice = (d: Difference): Choice => (d.kind === "local" ? "upload" : d.kind === "remote" ? "skip" : d.newer === "local" ? "upload" : d.newer === "remote" ? "download" : "skip");

const syncViews = new Map<string, SyncView>();

/** Compares a project file or folder with the server, in a tab where you choose what to upload and download. */
export async function syncWithDeployed(path: string, server?: DeployServer | "choose") {
  const s = await serverFor(server, "Sync with");
  if (!s) return;
  const at = remoteFor(s, host.root(), path);
  if (!at) return toast(`${relative(path)} isn't in ${s.name}'s mappings.`, { kind: "info", action: { label: "Edit Mappings…", run: () => editServers(s.name) } });
  const view = new SyncView(s, at);
  view.fileMode = !(await isFolder(path));
  const open = syncViews.get(view.key);
  if (open) closeView(open.el);
  syncViews.set(view.key, view);
  view.show();
}

// ---- Menus ----

/** The Deployment submenu for a project file or folder, in the tree's and the editor's context menus. */
export function deploymentMenu(path: string, isDir: boolean): MenuItem[] {
  if (!host?.root()) return [];
  const list = servers();
  if (!list.length) return [{ label: "Deployment", items: [{ label: "Add a Server…", run: () => editServers() }] }];
  const s = defaultServer();
  const mapped = s && remoteFor(s, host.root(), path);
  const items: MenuItem[] = [
    ...(mapped ? [{ label: `Upload to ${s.name}`, keys: "⌥⇧⌘X", run: () => upload([path], s) }] : []),
    { label: "Upload to…", run: () => upload([path], "choose") },
    ...(mapped ? [{ label: `Download from ${s.name}`, run: () => download([path], s) }] : []),
    { label: "Download from…", run: () => download([path], "choose") },
    "-",
    ...(mapped ? [{ label: `Sync with Deployed to ${s.name}…`, run: () => syncWithDeployed(path, s) }] : [{ label: "Sync with Deployed to…", run: () => syncWithDeployed(path, "choose") }]),
    ...(isDir ? [] : [{ label: mapped ? `Compare with Deployed Version on ${s.name}` : "Compare with Deployed Version…", run: () => compareWithDeployed(path, mapped ? s : "choose") }]),
    ...(mapped && mapped.local !== mapped.localRoot ? [{ label: `Delete from ${s.name}…`, run: () => deleteFromServer([path], s) }] : []),
    ...(!isDir && mapped && webUrlFor(s, remoteFor(s, host.root(), path)!.remote) ? [{ label: `Open on ${s.name} in the Browser`, run: () => invoke("open_url", { url: webUrlFor(s, remoteFor(s, host.root(), path)!.remote) }) }] : []),
    "-",
    { label: "Remote Host", run: () => showRemoteHost() },
    { label: "Deployment Settings…", run: () => editServers(s?.name) },
  ];
  return [{ label: "Deployment", items }];
}

// ---- Server files opened in the editor ----

let cacheDir = "";
/** Where a server's file is kept while you edit it: `<app cache>/remote/<server>/<path on the server>`. */
const cachePath = (server: string, remote: string) => `${cacheDir}/${encodeURIComponent(server)}/${remote.replace(/^\/+/, "")}`;

/** The server and path of a file opened from Remote Host, from its place in the cache. */
function remoteOrigin(path: string): { server: string; remote: string } | null {
  if (!cacheDir || !path.startsWith(`${cacheDir}/`)) return null;
  const rest = path.slice(cacheDir.length + 1);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  return { server: decodeURIComponent(rest.slice(0, slash)), remote: `/${rest.slice(slash + 1)}` };
}

/** Downloads a server's file and opens it; saving it uploads it back. */
async function openRemote(s: DeployServer, remote: string, size: number) {
  if (size > 16 * 1024 * 1024) return toast(`${nameOf(remote)} is ${formatBytes(size)}; download it to the project instead of opening it.`, { kind: "info" });
  const local = cachePath(s.name, remote);
  if (host.dirty(local) && !(await confirm(`Replace your unsaved changes to ${nameOf(remote)} with the server's copy?`, "Reload from Server"))) return host.openFile(local);
  try {
    status(`Opening ${nameOf(remote)} from ${s.name}…`, "deploy:progress");
    const progress = new Channel<[number, number]>();
    await reach(() => invoke("deploy_download", { server: wire(s), remote, local, id: ids++, progress }));
    await remember(s, remote, local);
    host.notice(local, null);
    host.openFile(local);
    await host.reload(local);
    status(`Opened ${nameOf(remote)} from ${s.name}. Saving it uploads it back.`, "deploy", "info");
  } catch (e) {
    showError(`Can't open ${nameOf(remote)}`, e);
  } finally {
    status("", "deploy:progress");
  }
}

// ---- Server files that change on the server ----

/** The server's size and time of each server file open in the editor, as last downloaded or uploaded. */
const synced = new Map<string, { mtime: number; size: number }>();

async function remember(s: DeployServer, remote: string, local: string) {
  const e = await invoke<Entry | null>("deploy_stat", { server: wire(s), path: remote }).catch(() => null);
  if (e) synced.set(local, { mtime: e.mtime, size: e.size });
}

/** Times this close count as the same, as in deploy.rs: servers round them. */
const sameState = (a: { mtime: number; size: number }, b: { mtime: number; size: number }) => a.size === b.size && Math.abs(a.mtime - b.mtime) <= 2;

let checking = false;
let lastCheck = 0;

/**
 * Looks for server files open in the editor that changed on the server: with a stat each, when the window gets
 * focus and every half minute. One without unsaved changes reloads; one with them gets a bar that asks.
 */
async function checkRemoteFiles(force = false) {
  if (checking || !cacheDir || (!force && Date.now() - lastCheck < 5000)) return;
  const open = host.openPaths().filter((p) => remoteOrigin(p));
  if (!open.length) return;
  checking = true;
  lastCheck = Date.now();
  try {
    for (const path of open) {
      const o = remoteOrigin(path)!;
      const s = named(o.server);
      if (!s || transfers.some((t) => t.local === path && (t.state === "queued" || t.state === "running"))) continue;
      // In the background: no host key prompt, and a server that's offline isn't reported.
      let e: Entry | null;
      try {
        e = await invoke<Entry | null>("deploy_stat", { server: wire(s), path: o.remote });
      } catch {
        continue;
      }
      // A file restored with the session has no record yet: its download gave it the server's time.
      const known = synced.get(path) ?? (await invoke<FileInfoLike[]>("deploy_local_files", { root: parentOf(path), paths: [path], excludes: [] }).then((f) => f[0], () => undefined));
      if (e && known && sameState(e, known)) {
        synced.set(path, { mtime: e.mtime, size: e.size });
        continue;
      }
      if (!e) host.notice(path, () => goneBar(path, s, o.remote));
      else if (!host.dirty(path)) await reloadRemote(path, s, o.remote, true);
      else host.notice(path, () => changedBar(path, s, o.remote, e));
    }
  } finally {
    checking = false;
  }
}

/** Downloads a server file open in the editor again, replacing its text. */
async function reloadRemote(path: string, s: DeployServer, file: string, quiet = false) {
  try {
    await reach(() => invoke("deploy_download", { server: wire(s), remote: file, local: path, id: ids++, progress: new Channel() }));
    await remember(s, file, path);
    host.notice(path, null);
    await host.reload(path);
    remote.changedOn(s);
    status(quiet ? `Reloaded ${nameOf(file)}: it changed on ${s.name}` : `Loaded ${nameOf(file)} from ${s.name}`, "deploy", "info");
  } catch (e) {
    showError(`Can't reload ${nameOf(file)} from ${s.name}`, e);
  }
}

const noticeButton = (label: string, run: () => unknown, primary = false) => h("button", { type: "button", class: primary ? "primary" : "", onclick: run }, label);

function changedBar(path: string, s: DeployServer, remote: string, e: Entry) {
  return h(
    "div",
    { class: "deploy-notice", role: "alert" },
    icon("cloud"),
    h("span", {}, `${nameOf(remote)} changed on ${s.name} (${formatTime(e.mtime)}) while you were editing it.`),
    noticeButton("Compare", async () => {
      try {
        const theirs = (await reach(() => invoke<string | null>("deploy_read", { server: wire(s), path: remote }))) ?? "";
        showDiff(nameOf(remote), theirs, host.openText(path) ?? "", `${s.name} ↔ Yours`, { label: "Load Server's", title: "Replace your unsaved changes with the server's copy", run: () => reloadRemote(path, s, remote) });
      } catch (err) {
        showError(`Can't read ${nameOf(remote)} from ${s.name}`, err);
      }
    }),
    noticeButton("Keep Mine", () => (synced.set(path, { mtime: e.mtime, size: e.size }), host.notice(path, null), status(`Saving ${nameOf(remote)} replaces ${s.name}'s copy.`, "deploy", "info"))),
    noticeButton("Load Server's", () => reloadRemote(path, s, remote), true),
  );
}

function goneBar(path: string, s: DeployServer, remote: string) {
  return h(
    "div",
    { class: "deploy-notice", role: "alert" },
    icon("warning"),
    h("span", {}, `${nameOf(remote)} isn't on ${s.name} anymore: it was deleted or renamed there.`),
    noticeButton("Dismiss", () => host.notice(path, null)),
    noticeButton(`Upload to ${s.name}`, () => (host.notice(path, null), enqueue(s, true, [{ local: path, remote, size: 0 }], { title: `Upload to ${s.name}`, after: () => void remember(s, remote, path) })), true),
  );
}

// ---- Remote Host ----

type Entry = { name: string; dir: boolean; link: boolean; size: number; mtime: number; mode: number | null };

/** The Remote Host tool window: a server's folders as a tree, loaded as you open them. */
class RemoteHost {
  private server: DeployServer | undefined;
  private root = "";
  private children = new Map<string, Entry[] | "loading" | { error: string }>();
  private expanded = new Set<string>();
  private entries = new Map<string, Entry>();
  private tree = $("remote-tree");
  private nav = listNav(this.tree, {
    rows: "li[data-key]",
    open: (row) => this.open(row.dataset.key!),
    toggle: (row, expand) => this.toggle(row.dataset.key!, expand),
  });

  constructor() {
    $("remote-server").onclick = () => this.chooseServer();
    $("remote-refresh").onclick = () => this.refresh();
    $("remote-new-folder").onclick = () => this.newFolder(this.selectedFolder());
    $("remote-settings").onclick = () => editServers(this.server?.name);
    $("remote-collapse").onclick = () => (this.expanded.clear(), this.render());
    this.tree.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const path = (e.target as HTMLElement).closest<HTMLElement>("li[data-key]")?.dataset.key ?? this.root;
      if (path) this.nav.select(path, { scroll: false }), showMenu(e.clientX, e.clientY, this.menu(path));
    });
    this.tree.addEventListener("keydown", (e) => {
      const path = this.nav.selected();
      if (!path) return;
      if (e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) e.preventDefault(), this.remove(path);
      else if (e.key === "F2" || (e.key === "F6" && e.shiftKey)) e.preventDefault(), this.rename(path);
    });
    // Drag files or folders from the Project tree onto a folder to upload them there.
    this.tree.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes("text/plain") || !this.server) return;
      e.preventDefault();
      this.tree.querySelectorAll(".drop-target").forEach((r) => r.classList.remove("drop-target"));
      this.dropRow(e)?.classList.add("drop-target");
    });
    this.tree.addEventListener("dragleave", () => this.tree.querySelectorAll(".drop-target").forEach((r) => r.classList.remove("drop-target")));
    this.tree.addEventListener("drop", (e) => {
      e.preventDefault();
      this.tree.querySelectorAll(".drop-target").forEach((r) => r.classList.remove("drop-target"));
      const path = e.dataTransfer?.getData("text/plain");
      const folder = this.dropFolder(e);
      if (path && folder && this.server && path.startsWith(`${host.root()}`)) void this.uploadInto(path, folder);
    });
  }

  private dropRow = (e: DragEvent) => (e.target as HTMLElement).closest<HTMLElement>("li[data-key]");
  private dropFolder(e: DragEvent) {
    const key = this.dropRow(e)?.dataset.key;
    if (!key) return this.root;
    return this.entries.get(key)?.dir ? key : parentOf(key);
  }
  private selectedFolder() {
    const key = this.nav.selected();
    if (!key) return this.root;
    return this.entries.get(key)?.dir || key === this.root ? key : parentOf(key);
  }

  serversChanged() {
    const name = this.server?.name;
    this.server = (name && named(name)) || defaultServer() || servers()[0];
    this.children.clear();
    this.entries.clear();
    this.expanded.clear();
    this.root = "";
    if ($("view-remote").hidden) return this.renderServer();
    void this.start();
  }

  async show() {
    if (!this.server || !named(this.server.name)) this.server = defaultServer() ?? servers()[0];
    if (!this.root || !this.children.size) await this.start();
    else this.render();
  }

  private renderServer() {
    const s = this.server;
    $("remote-server-name").textContent = s ? `${s.name} · ${s.user ? `${s.user}@` : ""}${s.host}` : "No server";
  }

  private async start() {
    this.renderServer();
    const s = this.server;
    if (!s) return this.render();
    this.root = joinRemote(s.rootPath);
    // Paths in the tree are absolute, so a file opened from it knows where it goes back to.
    if (!this.root.startsWith("/")) {
      this.children.set("", "loading");
      this.render();
      try {
        this.root = joinRemote(await reach(() => invoke<string>("deploy_home", { server: wire(s) })), this.root);
      } catch (e) {
        this.children.set("", { error: errorText(e) });
        return this.render();
      }
      this.children.delete("");
    }
    this.expanded.add(this.root);
    await this.load(this.root);
  }

  private async chooseServer() {
    const s = await chooseServer("Browse a server");
    if (!s) return;
    this.server = s;
    this.children.clear();
    this.expanded.clear();
    this.entries.clear();
    await this.start();
  }

  /** Lists the open folders again after a change to the server it shows. */
  changedOn(s: DeployServer) {
    if (s.name === this.server?.name && this.root && !$("view-remote").hidden) void this.refresh();
  }

  private async refresh() {
    const open = [...this.expanded];
    this.children.clear();
    if (!this.root) return this.start();
    await Promise.all(open.map((p) => this.load(p)));
  }

  private async load(dir: string) {
    const s = this.server;
    if (!s) return;
    this.children.set(dir, "loading");
    this.render();
    try {
      const list = await reach(() => invoke<Entry[]>("deploy_list", { server: wire(s), path: dir }));
      if (s !== this.server) return;
      this.children.set(dir, list);
      for (const e of list) this.entries.set(joinRemote(dir, e.name), e);
    } catch (e) {
      this.children.set(dir, { error: errorText(e) });
    }
    this.render();
  }

  private toggle(path: string, expand = !this.expanded.has(path)) {
    const e = this.entries.get(path);
    if (path !== this.root && !e?.dir) return;
    if (expand) {
      this.expanded.add(path);
      if (!Array.isArray(this.children.get(path))) void this.load(path);
    } else this.expanded.delete(path);
    this.render();
  }

  private open(path: string) {
    const e = this.entries.get(path);
    if (!e || e.dir) return this.toggle(path);
    void openRemote(this.server!, path, e.size);
  }

  render() {
    const tree = this.tree;
    if (!this.server) {
      return tree.replaceChildren(h("li", { class: "remote-empty" }, h("p", {}, "Browse a server's files, open them to edit, and drag project files onto it to upload."), h("button", { class: "primary", onclick: () => editServers() }, icon("add"), "Add a Server…")));
    }
    const rows: HTMLElement[] = [];
    const walk = (dir: string, depth: number) => {
      const kids = this.children.get(dir);
      if (kids === "loading") return rows.push(h("li", { class: "remote-note", style: `padding-left: ${depth * 12 + 22}px` }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), "Loading…"));
      if (kids && !Array.isArray(kids)) {
        // A root path that isn't there yet, as before the first upload: offer to create it.
        const missingRoot = dir === this.root && /doesn't exist|550|\[501\]/.test(kids.error);
        return rows.push(
          h(
            "li",
            { class: "remote-note failed", style: `padding-left: ${depth * 12 + 6}px` },
            icon(missingRoot ? "info" : "error"),
            h(
              "div",
              {},
              h("p", {}, missingRoot ? `The root path doesn't exist on ${this.server!.name} yet.` : kids.error),
              h(
                "div",
                { class: "remote-note-actions" },
                missingRoot ? h("button", { class: "deploy-link", onclick: () => this.change(() => invoke("deploy_mkdir", { server: wire(this.server!), path: dir }), dir, `Can't create ${dir}`) }, "Create It") : null,
                h("button", { class: "deploy-link", onclick: () => this.load(dir) }, "Retry"),
                h("button", { class: "deploy-link", onclick: () => editServers(this.server!.name) }, "Edit Server…"),
              ),
            ),
          ),
        );
      }
      if (kids && !kids.length) return rows.push(h("li", { class: "remote-note", style: `padding-left: ${depth * 12 + 22}px` }, "Empty folder"));
      for (const e of kids ?? []) {
        const path = joinRemote(dir, e.name);
        const open = this.expanded.has(path);
        rows.push(
          h(
            "li",
            {
              role: "treeitem",
              class: `row${e.dir ? " dir" : ""}`,
              data: { key: path, label: e.name },
              ariaLevel: String(depth + 1),
              ...(e.dir ? { ariaExpanded: String(open) } : {}),
              title: `${path}${e.dir ? "" : `\n${formatBytes(e.size)}`}${e.mtime ? ` · ${formatTime(e.mtime)}` : ""}${e.mode ? ` · ${e.mode.toString(8).padStart(3, "0")}` : ""}`,
              style: `padding-left: ${depth * 12 + 4}px`,
              onclick: (ev: MouseEvent) => ev.detail === 1 && e.dir && (ev.target as HTMLElement).closest(".chevron") && this.toggle(path),
              ondblclick: () => this.open(path),
            },
            h("span", { class: `chevron codicon ${e.dir ? (open ? "codicon-chevron-down" : "codicon-chevron-right") : ""}` }),
            icon(e.dir ? (open ? "folder-opened" : "folder") : e.link ? "file-symlink-file" : "file"),
            h("span", { class: "name" }, e.name),
            h("span", { class: "remote-meta" }, e.dir ? "" : formatBytes(e.size)),
          ),
        );
        if (e.dir && open) walk(path, depth + 1);
      }
    };
    const rootOpen = this.expanded.has(this.root);
    if (this.root)
      rows.push(
        h(
          "li",
          { role: "treeitem", class: "row dir remote-root", data: { key: this.root, label: this.root }, ariaLevel: "0", ariaExpanded: String(rootOpen), title: this.root, onclick: (ev: MouseEvent) => (ev.target as HTMLElement).closest(".chevron") && this.toggle(this.root) },
          h("span", { class: `chevron codicon ${rootOpen ? "codicon-chevron-down" : "codicon-chevron-right"}` }),
          icon("remote"),
          h("span", { class: "name" }, this.root),
        ),
      );
    if (rootOpen || !this.root) walk(this.root, 1);
    const scrolled = tree.scrollTop;
    tree.replaceChildren(...rows);
    tree.scrollTop = scrolled;
  }

  private placed(path: string): Placed | null {
    return this.server ? localFor(this.server, host.root(), path) : null;
  }

  private menu(path: string): MenuItem[] {
    const s = this.server!;
    const e = this.entries.get(path);
    const isDir = path === this.root || !!e?.dir;
    const at = this.placed(path);
    const url = webUrlFor(s, path);
    const folder = isDir ? path : parentOf(path);
    return [
      ...(isDir ? [] : [{ label: "Open", keys: "⏎", run: () => this.open(path) }]),
      ...(at ? [{ label: `Download to ${relative(at.local)}`, run: () => this.downloadTo(path, at, isDir) }] : []),
      ...(at && !isDir ? [{ label: "Compare with Local Version", run: () => compareWithDeployed(at.local, s) }] : []),
      ...(at && isDir ? [{ label: "Sync with Local Folder…", run: () => syncWithDeployed(at.local, s) }] : []),
      "-",
      { label: "New Folder…", run: () => this.newFolder(folder) },
      { label: "New File…", run: () => this.newFile(folder) },
      ...(path !== this.root ? [{ label: "Rename…", keys: "⇧F6", run: () => this.rename(path) }, { label: "Delete…", keys: "⌦", run: () => this.remove(path) }] : []),
      "-",
      { label: "Copy Path", run: () => navigator.clipboard.writeText(path).then(() => status(`Copied ${path}`, "deploy", "info")) },
      ...(url ? [{ label: "Open in the Browser", run: () => invoke("open_url", { url }) }, { label: "Copy URL", run: () => navigator.clipboard.writeText(url).then(() => status(`Copied ${url}`, "deploy", "info")) }] : []),
      { label: "Refresh", run: () => this.load(folder) },
    ];
  }

  private async downloadTo(path: string, at: Placed, isDir: boolean) {
    if (!isDir) {
      if (!(await safeToReplace([at.local]))) return;
      return enqueue(this.server!, false, [{ local: at.local, remote: path, size: this.entries.get(path)?.size ?? 0 }], { title: `Download from ${this.server!.name}` });
    }
    void download([at.local], this.server);
  }

  private async uploadInto(local: string, folder: string) {
    const s = this.server!;
    const base = parentOf(local);
    const found = await invoke<FileInfoLike[]>("deploy_local_files", { root: base, paths: [local], excludes: s.excludes });
    if (!found.length) return status(`Nothing to upload: ${s.name}'s excluded paths leave out ${nameOf(local)}.`, "deploy", "info");
    enqueue(s, true, found.map((f) => ({ local: `${base}/${f.path}`, remote: joinRemote(folder, f.path), size: f.size })), { title: `Upload to ${s.name}`, after: () => this.load(folder) });
  }

  private async ask(title: string, value: string): Promise<string | null> {
    return new Promise((resolve) => {
      let done = false;
      pick(title, (q) => (q.trim() && !q.includes("/") ? [{ label: q.trim(), detail: "Press ⏎", run: () => ((done = true), resolve(q.trim())) }] : []), 0, {
        value,
        title,
        onCancel: () => !done && resolve(null),
      });
    });
  }

  private async newFolder(dir: string) {
    const name = await this.ask(`New folder in ${dir}`, "");
    if (!name) return;
    await this.change(() => invoke("deploy_mkdir", { server: wire(this.server!), path: joinRemote(dir, name) }), dir, `Can't create ${name}`);
  }

  private async newFile(dir: string) {
    const name = await this.ask(`New file in ${dir}`, "");
    if (!name) return;
    const remote = joinRemote(dir, name);
    if (this.children.get(dir) instanceof Array && (this.children.get(dir) as Entry[]).some((e) => e.name === name)) return showError(`${name} already exists in ${dir}`);
    // An empty file, written through the upload path so it lands whole, then opened.
    const local = cachePath(this.server!.name, remote);
    try {
      await invoke("create_dir", { path: parentOf(local) });
      await invoke("write_file", { path: local, contents: "" });
      await reach(() => invoke("deploy_upload", { server: wire(this.server!), local, remote, id: ids++, progress: new Channel() }));
      await this.load(dir);
      host.openFile(local);
    } catch (e) {
      showError(`Can't create ${name}`, e);
    }
  }

  private async rename(path: string) {
    const name = await this.ask(`Rename ${nameOf(path)}`, nameOf(path));
    if (!name || name === nameOf(path)) return;
    await this.change(() => invoke("deploy_rename", { server: wire(this.server!), from: path, to: joinRemote(parentOf(path), name) }), parentOf(path), `Can't rename ${nameOf(path)}`);
  }

  private async remove(path: string) {
    if (path === this.root) return;
    const e = this.entries.get(path);
    const what = e?.dir ? `the folder ${nameOf(path)} and everything in it` : nameOf(path);
    if (!(await confirm(`Delete ${what} from ${this.server!.name}? This can't be undone.`, "Delete from Server"))) return;
    status(`Deleting ${nameOf(path)} from ${this.server!.name}…`, "deploy:progress");
    await this.change(() => invoke("deploy_remove", { server: wire(this.server!), path, dir: !!e?.dir && !e.link }), parentOf(path), `Can't delete ${nameOf(path)}`);
    status("", "deploy:progress");
  }

  private async change(run: () => Promise<unknown>, reload: string, failure: string) {
    try {
      await reach(run);
    } catch (e) {
      showError(failure, e);
    }
    await this.load(reload);
  }
}

let remote: RemoteHost;

export function showRemoteHost() {
  host.showView("remote");
}

/** Called when the Remote Host tool window shows. */
export const remoteHostShown = () => void remote.show();

// ---- Setup ----

export function initDeployment(h: Host) {
  host = h;
  remote = new RemoteHost();
  $("deploy-status").onclick = showTransfers;
  appCacheDir().then((dir) => (cacheDir = `${dir}/remote`));
  onProjectValue(SERVERS, () => remote.serversChanged());
  window.addEventListener("focus", () => void checkRemoteFiles());
  setInterval(() => document.visibilityState === "visible" && void checkRemoteFiles(true), 30_000);
}

/** A project opened: forget the last one's servers and connections; transfers already running finish. */
export function deploymentProjectOpened() {
  void invoke("deploy_disconnect");
  remote?.serversChanged();
  // Once the window has settled, not in the way of the project opening.
  setTimeout(() => void closedDeletions(), 1500);
}

export const isRemoteFile = (path: string) => !!remoteOrigin(path);
export const remoteFileLabel = (path: string) => {
  const o = remoteOrigin(path);
  return o ? `${o.server}:${o.remote}` : "";
};
