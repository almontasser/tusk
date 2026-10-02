// The Deployment dialog: the project's servers in a list, and the selected one's connection, paths, mappings, and
// exclusions in a form, as PhpStorm's Deployment settings have them. Nothing is saved until you click Save;
// deploy.ts writes what changed. Also the dialog that asks whether to trust a server's SSH key.
import { mod, open, passwordStore, shortcutText } from "./platform.ts";
import { h, icon } from "./dom";
import { listNav } from "./listnav";
import { errorText } from "./status";
import { type Auth, DEFAULT_EXCLUDES, DEFAULT_PORTS, type DeployServer, type HostKeyProblem, mappingRemote, newServer, PROTOCOLS, type Protocol, serverProblem, SUGGESTED_EXCLUDES, type UploadOnSave } from "./deploydata";

/** A server being edited. `previous` is its saved name; `secret` a password or passphrase typed here. */
type Draft = { server: DeployServer; key: string; previous?: string; dirty: boolean; secret?: string; hasSecret: boolean };

export type ServersResult = {
  servers: DeployServer[];
  /** Saved names that are gone, and new names by old name, so their passwords follow. */
  removed: string[];
  renamed: Record<string, string>;
  /** Passwords and passphrases typed, by the server's new name; "" removes one. */
  secrets: Record<string, string>;
  defaultServer: string;
  uploadOnSave: UploadOnSave;
  shared: boolean;
};

type Options = {
  root: string;
  servers: DeployServer[];
  selected?: string;
  defaultServer: string;
  uploadOnSave: UploadOnSave;
  shared: boolean;
  /** Whether a saved server has a password or passphrase in the password store. */
  hasSecret(name: string): Promise<boolean>;
  /** Connects with a draft (the typed secret, else the saved server's), and says what answered; throws its error. */
  test(server: DeployServer, previous: string | undefined, secret: string | undefined): Promise<string>;
  /** The server's login folder, for an empty root path. */
  home(server: DeployServer, previous: string | undefined, secret: string | undefined): Promise<string>;
};

const AUTHS: [Auth, string][] = [
  ["agent", "SSH agent"],
  ["key", "Key pair"],
  ["password", "Password"],
];

/** Opens the dialog. Resolves with what to save, or null when canceled. */
export function openDeploymentServers(o: Options): Promise<ServersResult | null> {
  document.getElementById("deploy-servers")?.remove();
  let keys = 0;
  const drafts: Draft[] = o.servers.map((s) => ({ server: structuredClone(s), key: `s${keys++}`, previous: s.name, dirty: false, hasSecret: false }));
  const removed: string[] = [];
  let defaultServer = o.defaultServer;
  let current: Draft | undefined = drafts.find((d) => d.server.name === o.selected) ?? drafts.find((d) => d.server.name === defaultServer) ?? drafts[0];
  let result: ServersResult | null = null;
  // Whether each saved server has a secret, for the password field's placeholder; asked once, in the background.
  for (const d of drafts) o.hasSecret(d.server.name).then((has) => ((d.hasSecret = has), d === current && placeholders()));

  // ---- The list ----

  const list = h("ul", { class: "ds-list", role: "listbox", ariaLabel: "Servers" });
  const nav = listNav(list, { rows: "li[data-key]", onSelect: (row) => choose(drafts.find((d) => d.key === row.dataset.key)!) });
  const protocolName = (p: Protocol) => PROTOCOLS.find(([v]) => v === p)![1].replace(/ \(.*/, "");
  const renderList = () => {
    list.replaceChildren(
      ...drafts.map((d) =>
        h(
          "li",
          { role: "option", data: { key: d.key, label: d.server.name }, title: `${protocolName(d.server.protocol)} · ${d.server.user ? `${d.server.user}@` : ""}${d.server.host || "no host"}` },
          icon(d.server.protocol === "sftp" ? "remote" : "cloud"),
          h("span", { class: "ds-name" }, d.server.name || "Unnamed"),
          d.server.name === defaultServer ? h("span", { class: "deploy-default", title: "The default server: Upload, Download, and uploads on save use it" }, icon("star-full")) : null,
          h("span", { class: "ds-origin" }, protocolName(d.server.protocol)),
          d.dirty ? h("span", { class: "ds-dirty", title: "Changed" }, "•") : null,
        ),
      ),
      ...(drafts.length ? [] : [h("li", { class: "deploy-empty" }, "No servers yet")]),
    );
  };
  const add = (from?: Draft) => {
    const base = from ? structuredClone(from.server) : newServer("");
    let name = from ? `${from.server.name} copy` : "staging";
    for (let i = 2; drafts.some((d) => d.server.name === name); i++) name = `${from ? `${from.server.name} copy` : "staging"} ${i}`;
    base.name = name;
    const d: Draft = { server: base, key: `s${keys++}`, dirty: true, hasSecret: false };
    drafts.push(d);
    if (!defaultServer) defaultServer = name;
    renderList();
    nav.select(d.key);
    (from ? fields.name : fields.host).focus();
    if (from) fields.name.select();
  };
  const remove = () => {
    if (!current) return;
    if (current.previous !== undefined) removed.push(current.previous);
    const i = drafts.indexOf(current);
    drafts.splice(i, 1);
    if (defaultServer === current.server.name) defaultServer = drafts[0]?.server.name ?? "";
    renderList();
    if (drafts.length) nav.select(drafts[Math.min(i, drafts.length - 1)].key);
    else (current = undefined), load();
  };
  const addButton = h("button", { type: "button", class: "icon-button", title: "Add a server", onclick: () => add() }, icon("add"));
  const copyButton = h("button", { type: "button", class: "icon-button", title: "Duplicate", onclick: () => current && add(current) }, icon("copy"));
  const removeButton = h("button", { type: "button", class: "icon-button", title: "Remove", onclick: remove }, icon("remove"));
  const defaultButton = h("button", { type: "button", class: "icon-button", title: "Use as the default server", onclick: () => current && ((defaultServer = current.server.name), renderList(), load()) }, icon("star-empty"));
  list.onkeydown = (e) => {
    if ((e.key === "Backspace" || e.key === "Delete") && mod(e)) e.preventDefault(), remove();
  };

  // ---- The form ----

  const input = (label: string, props: { placeholder?: string; type?: string; inputMode?: string; autocomplete?: AutoFill } = {}) => {
    const el = h("input", { spellcheck: false, ...props });
    return { el, row: h("label", { class: "field" }, label, el) };
  };
  const name = input("Name", { placeholder: "Such as staging or production" });
  const protocol = h("select", { ariaLabel: "Type" }, ...PROTOCOLS.map(([v, l]) => h("option", { value: v }, l)));
  const host = input("Host", { placeholder: "example.com or 203.0.113.5" });
  const port = input("Port", { inputMode: "numeric" });
  const user = input("User", { placeholder: "forge" });
  const auth = h("select", { ariaLabel: "Log in with" }, ...AUTHS.map(([v, l]) => h("option", { value: v }, l)));
  const authRow = h("label", { class: "field" }, "Log in with", auth);
  const secret = input("Password", { type: "password", autocomplete: "off" });
  const keyFile = input("Key file", { placeholder: "Empty: ~/.ssh/id_ed25519, id_ecdsa, or id_rsa" });
  const keyBrowse = h("button", {
    type: "button",
    class: "ds-browse",
    title: "Choose a private key",
    onclick: async () => {
      const path = await open({ multiple: false, directory: false, defaultPath: keyFile.el.value || undefined }).catch(() => null);
      if (typeof path === "string") (keyFile.el.value = path), keyFile.el.dispatchEvent(new Event("input", { bubbles: true }));
    },
  }, "Browse…");
  const keyRow = h("div", { class: "field-with-button" }, keyFile.row, keyBrowse);
  const passive = h("input", { type: "checkbox" });
  const passiveRow = h("label", { class: "ds-check", title: "The client opens every connection, which works through firewalls and NAT. Turn it off only for servers that need active mode." }, passive, "Passive mode");
  const insecure = h("input", { type: "checkbox" });
  const insecureRow = h("label", { class: "ds-check", title: "For a server with a self-signed certificate. The connection is still encrypted, but Tusk can't tell it's your server." }, insecure, "Don't check the server's certificate");
  const rootPath = input("Root path", { placeholder: "Empty: the folder you log in to" });
  const detect = h("button", { type: "button", class: "ds-browse", title: "Fill in the folder you log in to", onclick: () => detectRoot() }, "Detect");
  const webUrl = input("Web URL", { placeholder: "https://staging.example.com" });
  const testResult = h("span", { class: "ds-test", role: "status" });
  const testButton = h("button", { type: "button", onclick: () => test() }, icon("plug"), "Test Connection");
  const problem = h("div", { class: "ds-problem", role: "alert" });

  const mappingRows = h("div", { class: "deploy-mappings" });
  const addMapping = h("button", { type: "button", class: "deploy-link", onclick: () => (current!.server.mappings.push({ local: "", remote: "" }), touch(), renderMappings(), mappingRows.querySelector<HTMLInputElement>(".deploy-mapping:last-child input")?.focus()) }, icon("add"), "Add Mapping");
  const excludes = h("textarea", { rows: 5, spellcheck: false, ariaLabel: "Excluded paths", placeholder: "One per line, such as node_modules or storage/logs" });
  const suggestions = h("div", { class: "deploy-suggestions" });

  const section = (title: string, hint: string, ...children: (Node | string)[]) => h("fieldset", { class: "ds-ssh deploy-section" }, h("legend", {}, title), hint ? h("p", { class: "deploy-hint" }, hint) : null, ...children);
  const connection = section(
    "Connection",
    "",
    h("div", { class: "ds-row" }, h("label", { class: "field" }, "Type", protocol), authRow),
    h("div", { class: "ds-row" }, host.row, port.row),
    h("div", { class: "ds-row" }, user.row, secret.row),
    keyRow,
    h("div", { class: "deploy-checks" }, passiveRow, insecureRow),
    h("div", { class: "ds-test-row" }, testButton, testResult),
  );
  const paths = section("Paths", "", h("div", { class: "field-with-button" }, rootPath.row, detect), webUrl.row);
  const mappings = section("Mappings", "Where project folders go on the server. A server path without a leading / is inside the root path.", mappingRows, addMapping);
  const exclusions = section("Excluded paths", "Never uploaded or downloaded. A name matches at any depth, as in .gitignore; a path with / matches from the mapping's folder.", excludes, suggestions);
  const empty = h("div", { class: "deploy-empty-form" }, icon("cloud-upload"), h("p", {}, "Add a server to upload the project over SFTP, FTP, or FTPS."), h("button", { type: "button", class: "primary", onclick: () => add() }, icon("add"), "Add Server"));
  const form = h("div", { class: "ds-form" }, name.row, connection, paths, mappings, exclusions);
  const fields = { name: name.el, host: host.el };

  function choose(d: Draft) {
    current = d;
    load();
  }

  const placeholders = () => {
    if (!current) return;
    const s = current.server;
    const label = s.protocol === "sftp" && s.auth === "key" ? "Passphrase" : "Password";
    (secret.row.firstChild as Text).textContent = label;
    secret.el.placeholder = current.secret !== undefined ? "" : current.hasSecret ? `Saved in ${passwordStore}; type to change` : s.protocol === "sftp" && s.auth === "key" ? "Empty for a key without one" : s.protocol !== "sftp" && !s.user ? "Empty for anonymous" : "";
  };

  /** Fills the form from the selected draft. */
  function load() {
    form.hidden = !current;
    empty.hidden = !!current;
    for (const b of [copyButton, removeButton, defaultButton]) b.disabled = !current;
    if (!current) return;
    const s = current.server;
    name.el.value = s.name;
    protocol.value = s.protocol;
    host.el.value = s.host;
    port.el.value = String(s.port);
    user.el.value = s.user;
    auth.value = s.auth;
    secret.el.value = current.secret ?? "";
    keyFile.el.value = s.keyFile;
    passive.checked = s.passive;
    insecure.checked = s.insecureTls;
    rootPath.el.value = s.rootPath;
    webUrl.el.value = s.webUrl;
    excludes.value = s.excludes.join("\n");
    defaultButton.replaceChildren(icon(s.name === defaultServer ? "star-full" : "star-empty"));
    defaultButton.title = s.name === defaultServer ? "The default server" : "Use as the default server";
    testResult.textContent = "";
    testResult.className = "ds-test";
    problem.textContent = "";
    renderMappings();
    shape();
  }

  /** Shows the fields the protocol and login have. */
  function shape() {
    const s = current!.server;
    const sftp = s.protocol === "sftp";
    authRow.hidden = !sftp;
    secret.row.hidden = sftp && s.auth === "agent";
    keyRow.hidden = !sftp || s.auth !== "key";
    passiveRow.hidden = sftp;
    insecureRow.hidden = s.protocol === "sftp" || s.protocol === "ftp";
    (passiveRow.parentElement as HTMLElement).hidden = sftp;
    user.el.placeholder = sftp ? "forge" : "Empty for anonymous";
    placeholders();
    renderSuggestions();
  }

  function renderMappings() {
    const s = current!.server;
    mappingRows.replaceChildren(
      h("div", { class: "deploy-mapping deploy-mapping-head" }, h("span", {}, "Project folder"), h("span", {}), h("span", {}, "Server path"), h("span", {})),
      ...s.mappings.map((m, i) => {
        const local = h("input", { spellcheck: false, value: m.local, placeholder: "The whole project", ariaLabel: "Project folder" });
        const remote = h("input", { spellcheck: false, value: m.remote, placeholder: s.rootPath ? "The root path" : "The login folder", ariaLabel: "Server path" });
        const resolved = h("span", { class: "deploy-resolved" });
        const show = () => {
          const at = mappingRemote(s, m);
          resolved.textContent = at ? `→ ${at}` : "→ the login folder";
        };
        show();
        local.oninput = () => ((m.local = local.value), touch());
        remote.oninput = () => ((m.remote = remote.value), touch(), show());
        const browse = h("button", {
          type: "button",
          class: "icon-button",
          title: "Choose a project folder",
          onclick: async () => {
            const path = await open({ multiple: false, directory: true, defaultPath: m.local ? `${o.root}/${m.local}` : o.root }).catch(() => null);
            if (typeof path !== "string") return;
            if (path !== o.root && !path.startsWith(`${o.root}/`)) return (problem.textContent = "Choose a folder inside the project.");
            m.local = local.value = path.slice(o.root.length + 1);
            touch();
          },
        }, icon("folder-opened"));
        const del = h("button", { type: "button", class: "icon-button", title: "Remove the mapping", disabled: s.mappings.length === 1, onclick: () => (s.mappings.splice(i, 1), touch(), renderMappings()) }, icon("close"));
        return h("div", { class: "deploy-mapping" }, h("div", { class: "deploy-mapping-local" }, local, browse), icon("arrow-right"), h("div", { class: "deploy-mapping-remote" }, remote, resolved), del);
      }),
    );
  }

  function renderSuggestions() {
    const s = current!.server;
    const missing = [...DEFAULT_EXCLUDES, ...SUGGESTED_EXCLUDES].filter((p) => !s.excludes.includes(p));
    suggestions.replaceChildren(
      ...(missing.length ? [h("span", { class: "deploy-hint" }, "Add:")] : []),
      ...missing.map((p) => h("button", { type: "button", class: "deploy-chip", title: `Exclude ${p}`, onclick: () => ((s.excludes = [...s.excludes, p]), (excludes.value = s.excludes.join("\n")), touch(), renderSuggestions()) }, p)),
    );
  }

  /** Reads the form into the selected draft. */
  function read(target?: EventTarget | null) {
    const s = current!.server;
    const was = s.protocol;
    s.name = name.el.value.trim();
    s.protocol = protocol.value as Protocol;
    if (was !== s.protocol && (!port.el.value || Number(port.el.value) === DEFAULT_PORTS[was])) port.el.value = String(DEFAULT_PORTS[s.protocol]);
    s.host = host.el.value.trim();
    s.port = Number(port.el.value) || DEFAULT_PORTS[s.protocol];
    s.user = user.el.value.trim();
    s.auth = auth.value as Auth;
    s.keyFile = keyFile.el.value.trim();
    s.passive = passive.checked;
    s.insecureTls = insecure.checked;
    s.rootPath = rootPath.el.value.trim();
    s.webUrl = webUrl.el.value.trim();
    if (target === excludes) s.excludes = excludes.value.split("\n").map((l) => l.trim()).filter(Boolean);
    if (target === secret.el) current!.secret = secret.el.value;
    if (target === rootPath.el) for (const el of mappingRows.querySelectorAll<HTMLInputElement>(".deploy-mapping-remote input")) el.dispatchEvent(new Event("input"));
  }
  function touch() {
    const d = current!;
    // The default follows a rename.
    const row = list.querySelector<HTMLElement>(`li[data-key="${d.key}"]`);
    if (row?.dataset.label === defaultServer && defaultServer !== d.server.name) defaultServer = d.server.name;
    d.dirty = true;
    renderList();
  }

  form.addEventListener("input", (e) => {
    if ((e.target as HTMLElement).closest(".deploy-mappings")) return;
    read(e.target);
    touch();
    shape();
  });
  form.addEventListener("change", (e) => (e.target === protocol || e.target === auth) && (read(e.target), touch(), shape()));

  const busy = (label: string) => {
    testResult.className = "ds-test";
    testResult.replaceChildren(h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), ` ${label}`);
  };
  async function test() {
    const d = current!;
    read();
    const why = serverProblem(d.server, drafts.map((x) => x.server));
    if (why && !/mapping/.test(why)) return (testResult.className = "ds-test failed"), testResult.replaceChildren(icon("error"), ` ${why}`);
    testButton.disabled = true;
    busy("Connecting…");
    try {
      const what = await o.test(d.server, d.previous, d.secret);
      testResult.className = "ds-test ok";
      testResult.replaceChildren(icon("check"), ` Connected: ${what}`);
    } catch (e) {
      testResult.className = "ds-test failed";
      testResult.replaceChildren(icon("error"), ` ${errorText(e)}`);
    } finally {
      testButton.disabled = false;
    }
  }
  async function detectRoot() {
    const d = current!;
    read();
    detect.disabled = true;
    busy("Finding the login folder…");
    try {
      rootPath.el.value = await o.home(d.server, d.previous, d.secret);
      rootPath.el.dispatchEvent(new Event("input", { bubbles: true }));
      testResult.className = "ds-test ok";
      testResult.replaceChildren(icon("check"), ` The login folder is ${rootPath.el.value}`);
    } catch (e) {
      testResult.className = "ds-test failed";
      testResult.replaceChildren(icon("error"), ` ${errorText(e)}`);
    } finally {
      detect.disabled = false;
    }
  }

  // ---- Saving ----

  const uploadOnSave = h(
    "select",
    { ariaLabel: "Upload changed files" },
    h("option", { value: "never" }, "Never"),
    h("option", { value: "explicit" }, `On explicit save (${shortcutText("Meta+S")})`),
    h("option", { value: "always" }, "On every save, auto-save too"),
  );
  uploadOnSave.value = o.uploadOnSave;
  const shareBox = h("input", { type: "checkbox", checked: o.shared });
  const saveButton = h("button", { type: "button", class: "primary" }, "Save");
  saveButton.onclick = () => {
    for (const d of drafts) {
      const why = serverProblem(d.server, drafts.map((x) => x.server));
      if (why) return nav.select(d.key), (problem.textContent = why);
    }
    const renamed: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const d of drafts) {
      if (d.previous !== undefined && d.previous !== d.server.name) renamed[d.previous] = d.server.name;
      if (d.secret !== undefined) secrets[d.server.name] = d.secret;
      d.server.mappings = d.server.mappings.map((m) => ({ local: m.local.trim().replace(/^\.\/?$/, "").replace(/\/+$/, ""), remote: m.remote.trim() }));
    }
    result = { servers: drafts.map((d) => d.server), removed, renamed, secrets, defaultServer, uploadOnSave: uploadOnSave.value as UploadOnSave, shared: shareBox.checked };
    dialog.close();
  };

  const dialog = h(
    "dialog",
    { id: "deploy-servers", class: "refactor-dialog", ariaLabel: "Deployment" },
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, "Deployment"),
      h("div", { class: "ds-body" }, h("div", { class: "ds-side" }, list, h("div", { class: "ds-list-actions" }, addButton, copyButton, removeButton, h("span", { class: "spacer" }), defaultButton)), form, empty),
      problem,
      h(
        "div",
        { class: "deploy-options" },
        h("label", { class: "ds-share", title: "Uploads each saved file in a mapping to the default server (★)" }, "Upload saved files to the default server", uploadOnSave),
        h("label", { class: "ds-share", title: `${o.root}/tusk.json` }, shareBox, "Share servers in tusk.json"),
      ),
      h(
        "div",
        { class: "buttons" },
        h("span", { class: "dialog-hint" }, `Passwords and passphrases stay in ${passwordStore}.`),
        h("button", { type: "button", onclick: () => dialog.close() }, "Cancel"),
        saveButton,
      ),
    ),
  );
  dialog.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (e.key === "Enter" && t.tagName === "INPUT" && (t as HTMLInputElement).type !== "checkbox") e.preventDefault(), saveButton.click();
    e.stopPropagation();
  });
  renderList();
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.onclose = () => {
      dialog.remove();
      resolve(result);
    };
    dialog.showModal();
    if (current) nav.select(current.key), choose(current), list.focus();
    else load(), empty.querySelector("button")!.focus();
  });
}

/**
 * Asks whether to trust a server's SSH key: one Tusk hasn't seen (as `ssh` asks the first time), or one that
 * changed since, which may mean someone is in between. Resolves to true to trust it.
 */
export function trustHostKey(p: HostKeyProblem): Promise<boolean> {
  const changed = p.kind === "changed";
  const where = p.port === 22 ? p.host : `${p.host}:${p.port}`;
  let trusted = false;
  const trust = h("button", { type: "button", class: changed ? "danger" : "primary", onclick: () => ((trusted = true), dialog.close()) }, changed ? "Replace the Key and Connect" : "Trust and Connect");
  const cancel = h("button", { type: "button", class: changed ? "primary" : "", onclick: () => dialog.close() }, "Cancel");
  const dialog = h(
    "dialog",
    { class: "refactor-dialog deploy-hostkey", ariaLabel: changed ? "Server key changed" : "Unknown server" },
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, icon(changed ? "warning" : "shield"), changed ? `${where}'s key has changed` : `Do you trust ${where}?`),
      h(
        "p",
        {},
        changed
          ? "The key this server sent isn't the one it sent before. The server may have been reinstalled, or someone may be intercepting the connection. Ask the server's administrator before you replace the key."
          : "Tusk hasn't connected to this server before. Check that the fingerprint matches the server's, such as with the hosting provider's dashboard or ssh-keyscan, then trust it. Tusk adds it to ~/.ssh/known_hosts, as ssh does.",
      ),
      h("dl", { class: "deploy-fingerprint" }, h("dt", {}, "Key type"), h("dd", {}, p.algorithm), h("dt", {}, "Fingerprint"), h("dd", {}, p.fingerprint)),
      h("div", { class: "buttons" }, cancel, trust),
    ),
  );
  dialog.addEventListener("keydown", (e) => e.stopPropagation());
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.onclose = () => (dialog.remove(), resolve(trusted));
    dialog.showModal();
    // A changed key starts on Cancel, so Enter doesn't accept it.
    (changed ? cancel : trust).focus();
  });
}
