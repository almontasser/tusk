// HTTP client for .http files: ▶ Send Request above each request, or ⌘⏎ in one. Requests go through
// macOS's curl, so there's nothing to bundle and no browser CORS rules. Variables such as {{host}} come
// from http-client.env.json (and http-client.private.env.json, for secrets you don't commit).
import { invoke } from "@tauri-apps/api/core";
import { monaco } from "./editor";
import { type HttpRequest, parseCurlOutput, parseHttpFile, substitute, TIME_MARKER } from "./httpfile";
import { pick } from "./palette";
import { showPanelView } from "./terminal";

type Host = { root(): string; status(text: string): void };
type Environments = Record<string, Record<string, string>>;

let host: Host;
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
const envKey = () => `httpEnv:${host.root()}`;

monaco.languages.register({ id: "http", extensions: [".http", ".rest"], aliases: ["HTTP Request"] });
monaco.languages.setMonarchTokensProvider("http", {
  tokenizer: {
    root: [
      [/^###.*$/, "comment.doc"],
      [/^\s*(#|\/\/).*$/, "comment"],
      [/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(\s+)/, ["keyword", ""]],
      [/\{\{[^}]*\}\}/, "variable"],
      [/^[\w-]+(?=:)/, "attribute.name"],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/\b\d+(\.\d+)?\b/, "number"],
    ],
  },
});

/** Environments from the .http file's folder, or else the project root. Private values override shared ones. */
async function environments(path: string): Promise<Environments> {
  for (const dir of [parentOf(path), host.root()]) {
    const read = (name: string) =>
      invoke<string>("read_file", { path: `${dir}/${name}` })
        .then((t) => JSON.parse(t) as Environments)
        .catch(() => null);
    const [shared, secret] = await Promise.all([read("http-client.env.json"), read("http-client.private.env.json")]);
    if (!shared && !secret) continue;
    const merged: Environments = { ...shared };
    for (const [env, vars] of Object.entries(secret ?? {})) merged[env] = { ...merged[env], ...vars };
    return merged;
  }
  return {};
}

function selectedEnvironment(envs: Environments): string | undefined {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(envKey());
  } catch {
    // Use the first environment.
  }
  return saved && saved in envs ? saved : Object.keys(envs)[0];
}

export async function selectEnvironment(path: string) {
  const envs = await environments(path);
  if (!Object.keys(envs).length) return host.status("No http-client.env.json next to this file or in the project root.");
  pick("HTTP client environment", () =>
    Object.keys(envs).map((name) => ({
      label: name,
      detail: name === selectedEnvironment(envs) ? "Selected" : Object.keys(envs[name]).join(", "),
      run: () => {
        try {
          localStorage.setItem(envKey(), name);
        } catch {
          // Lasts until reload.
        }
        host.status(`HTTP environment: ${name}`);
      },
    })),
  );
}

// ---- Sending ----

const panel = document.createElement("div");
panel.className = "http-response";

export async function send(path: string, request: HttpRequest) {
  const envs = await environments(path);
  const envName = selectedEnvironment(envs);
  const vars = envName ? envs[envName] : {};
  const url = substitute(request.url, vars);
  const headers = request.headers.map(([k, v]) => `${k}: ${substitute(v, vars)}`);
  const body = substitute(request.body, vars);
  const args = ["-sS", "-i", "--max-time", "60", "-X", request.method, url, "-w", `${TIME_MARKER}%{time_total}`, ...headers.flatMap((h) => ["-H", h])];
  if (body) args.push("--data-binary", "@-");

  const summary = document.createElement("div");
  summary.className = "http-summary";
  summary.textContent = `${request.method} ${url} …`;
  panel.replaceChildren(summary);
  showPanelView("HTTP", panel);
  let out: string;
  try {
    out = await invoke<string>("run_capture", { cwd: parentOf(path), program: "/usr/bin/curl", args, input: body || null });
  } catch (e) {
    summary.textContent = `${request.method} ${url}`;
    const error = document.createElement("pre");
    error.className = "http-error";
    error.textContent = String(e).trim();
    panel.append(error);
    return;
  }
  const r = parseCurlOutput(out);
  const status = document.createElement("span");
  status.className = r.status >= 400 ? "status bad" : r.status >= 300 ? "status redirect" : "status good";
  status.textContent = `${r.status} ${r.statusText}`;
  summary.replaceChildren(`${request.method} ${url} → `, status, ` · ${Math.round(r.seconds * 1000)} ms${envName ? ` · ${envName}` : ""}`);

  const headerList = document.createElement("details");
  const title = document.createElement("summary");
  title.textContent = `Headers (${r.headers.length})`;
  const pre = document.createElement("pre");
  pre.textContent = r.headers.map(([k, v]) => `${k}: ${v}`).join("\n");
  headerList.append(title, pre);

  const bodyEl = document.createElement("pre");
  bodyEl.className = "http-body";
  const json = r.headers.some(([k, v]) => k.toLowerCase() === "content-type" && v.includes("json"));
  try {
    bodyEl.textContent = json ? JSON.stringify(JSON.parse(r.body), null, 2) : r.body;
  } catch {
    bodyEl.textContent = r.body;
  }
  panel.append(headerList, bodyEl);
}

/** Sends the request that contains the cursor. */
function sendAtCursor(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const line = editor.getPosition()?.lineNumber ?? 1;
  if (!model) return;
  const requests = parseHttpFile(model.getValue());
  const request = requests.filter((r) => r.line <= line).at(-1) ?? requests[0];
  if (request) send(model.uri.fsPath, request);
}

export function initHttpClient(h: Host) {
  host = h;
  monaco.editor.registerCommand("phpEditor.sendHttp", (_, path: string, request: HttpRequest) => send(path, request));
  monaco.languages.registerCodeLensProvider("http", {
    provideCodeLenses: (model) => ({
      lenses: parseHttpFile(model.getValue()).map((request) => ({
        range: new monaco.Range(request.line, 1, request.line, 1),
        command: { id: "phpEditor.sendHttp", title: "▶ Send Request", arguments: [model.uri.fsPath, request] },
      })),
      dispose() {},
    }),
  });
  monaco.editor.addEditorAction({
    id: "phpEditor.sendHttpAtCursor",
    label: "Send HTTP Request",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    precondition: "editorLangId == http",
    run: sendAtCursor,
  });
}
