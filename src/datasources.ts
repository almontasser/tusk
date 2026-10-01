// The Data Sources dialog: the project's database connections in a list, and the selected one's settings in a form,
// as PhpStorm's has them. Nothing is saved until you click Save; database.ts writes what changed.
import { open, isAbsolute, mod } from "./platform.ts";
import { type Connection, connectionFromUrl, connectionUrl, describe, destinationOf, parseDestination } from "./dbconfig";
import { h, icon } from "./dom";
import { listNav } from "./listnav";
import { errorText } from "./status";

/** An SSH tunnel: a destination `ssh` accepts, such as forge@203.0.113.5, and a key file, or "" for the agent. */
export type Ssh = { destination: string; identityFile: string };

/** A connection as the dialog lists it. `name` is "" for .env's. */
export type Source = {
  name: string;
  origin: "env" | "saved" | "config" | "redis";
  connection: Connection;
  ssh: Ssh;
  readOnly: boolean;
  /** For .env's: its values without the override, and whether an override is set. */
  original?: Connection;
  overridden?: boolean;
};

/** A changed connection. For .env's, `connection` is the override, or null to use .env's values again. */
export type SourceEdit = {
  name: string;
  origin: Source["origin"];
  previous?: string;
  connection: Connection | null;
  ssh: Ssh;
  readOnly: boolean;
  /** The password you typed, or undefined to keep the one in the Keychain under `keychain`'s name. */
  password?: string;
  keychain?: string;
};

type Options = {
  root: string;
  sources: Source[];
  /** The connection to show first, by name. */
  selected: string;
  /** A section to scroll to, such as the SSH tunnel. */
  section?: "ssh";
  /** Connects, and returns the server's version; throws its error. */
  test(connection: Connection, ssh: Ssh): Promise<string>;
  friendlyError(message: string): string;
  /** A saved connection's password from the Keychain, read only when Test Connection needs it. */
  password(name: string): Promise<string>;
  /** Whether saved connections are shared in tusk.json. */
  shared: boolean;
};

/** `keychain` names the saved connection whose password the draft uses until you type one. */
type Draft = Source & { key: string; previous?: string; dirty: boolean; typedPassword: boolean; keychain?: string };

const DRIVERS: [string, string][] = [
  ["mysql", "MySQL"],
  ["mariadb", "MariaDB"],
  ["pgsql", "PostgreSQL"],
  ["sqlite", "SQLite"],
  ["redis", "Redis"],
];
const DEFAULT_PORTS: Record<string, number> = { mysql: 3306, mariadb: 3306, pgsql: 5432, redis: 6379 };
const SSL_MODES: [string, string][] = [
  ["", "Default"],
  ["disable", "disable: no TLS"],
  ["prefer", "prefer: TLS when the server has it"],
  ["require", "require: TLS, without checking the certificate"],
  ["verify-ca", "verify-ca: TLS, checking the certificate"],
  ["verify-full", "verify-full: TLS, checking the certificate and host name"],
];

/** Opens the dialog. Resolves with the changes, removals, and the connection to select, or null when canceled. */
export function openDataSources(o: Options): Promise<{ edits: SourceEdit[]; removed: string[]; select?: string; shared: boolean } | null> {
  document.getElementById("data-sources")?.remove();
  let keys = 0;
  const drafts: Draft[] = o.sources.map((s) => ({ ...s, connection: { ...s.connection }, ssh: { ...s.ssh }, key: `s${keys++}`, previous: s.origin === "saved" ? s.name : undefined, keychain: s.origin === "saved" ? s.name : undefined, dirty: false, typedPassword: false }));
  const removed: string[] = [];
  let current = drafts.find((d) => d.name === o.selected) ?? drafts[0];
  let result: { edits: SourceEdit[]; removed: string[]; select?: string; shared: boolean } | null = null;

  // ---- The list ----

  const list = h("ul", { class: "ds-list", role: "listbox", ariaLabel: "Data sources" });
  const nav = listNav(list, { rows: "li[data-key]", onSelect: (row) => choose(drafts.find((d) => d.key === row.dataset.key)!) });
  const renderList = () =>
    list.replaceChildren(
      ...drafts.map((d) =>
        h(
          "li",
          { role: "option", data: { key: d.key, label: d.name || ".env" }, title: describe(d.connection, o.root) },
          icon(d.connection.driver === "redis" ? "layers" : "database"),
          h("span", { class: "ds-name" }, d.name || ".env"),
          h("span", { class: "ds-origin" }, d.origin === "env" ? (d.overridden ? "overridden" : ".env") : d.origin === "config" ? "config" : d.origin === "redis" ? ".env" : d.dirty && d.previous === undefined ? "new" : ""),
          d.dirty ? h("span", { class: "ds-dirty", title: "Changed" }, "•") : null,
        ),
      ),
    );
  const add = (from?: Draft) => {
    const base = from?.connection ?? { driver: "mysql", host: "127.0.0.1", port: 3306, database: "", username: "root", password: "", ssl_mode: "", ssl_ca: "" };
    let name = from ? `${from.name || "env"} copy` : "New connection";
    for (let i = 2; drafts.some((d) => d.name === name); i++) name = `${from ? `${from.name || "env"} copy` : "New connection"} ${i}`;
    const d: Draft = { name, origin: "saved", connection: { ...base }, ssh: { ...(from?.ssh ?? { destination: "", identityFile: "" }) }, readOnly: from?.readOnly ?? false, key: `s${keys++}`, dirty: true, typedPassword: !!from && !from.keychain, keychain: from?.keychain };
    drafts.push(d);
    renderList();
    nav.select(d.key);
    fields.name.focus();
    fields.name.select();
  };
  const remove = () => {
    if (current.origin !== "saved") return;
    if (current.previous !== undefined) removed.push(current.previous);
    const i = drafts.indexOf(current);
    drafts.splice(i, 1);
    renderList();
    nav.select(drafts[Math.min(i, drafts.length - 1)].key);
  };
  const addButton = h("button", { type: "button", class: "icon-button", title: "Add a data source", onclick: () => add() }, icon("add"));
  const copyButton = h("button", { type: "button", class: "icon-button", title: "Duplicate", onclick: () => add(current) }, icon("copy"));
  const removeButton = h("button", { type: "button", class: "icon-button", title: "Remove", onclick: remove }, icon("remove"));
  list.onkeydown = (e) => {
    if ((e.key === "Backspace" || e.key === "Delete") && mod(e)) e.preventDefault(), remove();
  };

  // ---- The form ----

  const input = (label: string, props: { placeholder?: string; type?: string; inputMode?: string; autocomplete?: AutoFill } = {}) => {
    const el = h("input", { spellcheck: false, ...props });
    return { el, row: h("label", { class: "field" }, label, el) };
  };
  const browse = (target: HTMLInputElement, title: string) =>
    h("button", {
      type: "button",
      class: "ds-browse",
      title,
      onclick: async () => {
        const path = await open({ multiple: false, directory: false, defaultPath: target.value || o.root }).catch(() => null);
        if (typeof path === "string") (target.value = path), target.dispatchEvent(new Event("input", { bubbles: true }));
      },
    }, "Browse…");
  const name = input("Name", { placeholder: "Such as staging" });
  const driver = h("select", { ariaLabel: "Driver" }, ...DRIVERS.map(([v, l]) => h("option", { value: v }, l)));
  const file = input("Database file", { placeholder: "database/database.sqlite" });
  const hostField = input("Host", { placeholder: "127.0.0.1" });
  const port = input("Port", { inputMode: "numeric" });
  const user = input("User");
  const pass = input("Password", { type: "password", autocomplete: "off" });
  const database = input("Database");
  const sslMode = h("select", { ariaLabel: "SSL mode" }, ...SSL_MODES.map(([v, l]) => h("option", { value: v }, l)));
  const ca = input("CA file", { placeholder: "A PEM file, such as the provider's bundle" });
  const useSsh = h("input", { type: "checkbox" });
  const sshHost = input("SSH host", { placeholder: "203.0.113.5, or a host from ~/.ssh/config" });
  const sshPort = input("Port", { placeholder: "22", inputMode: "numeric" });
  const sshUser = input("User", { placeholder: "forge" });
  const sshKey = input("Key file", { placeholder: "Empty: your SSH agent and ~/.ssh/config" });
  const readOnly = h("input", { type: "checkbox" });
  const url = input("URL", { placeholder: "mysql://user@host:3306/database" });
  const fields = { name: name.el };

  const note = h("div", { class: "ds-note" });
  const testResult = h("span", { class: "ds-test", role: "status" });
  const testButton = h("button", { type: "button", onclick: () => test() }, icon("plug"), "Test Connection");
  const problem = h("div", { class: "ds-problem", role: "alert" });
  const sshSection = h(
    "fieldset",
    { class: "ds-ssh" },
    h("legend", {}, h("label", {}, useSsh, "SSH tunnel")),
    h("div", { class: "ds-row" }, sshHost.row, sshPort.row),
    h("div", { class: "ds-row" }, sshUser.row, h("div", { class: "field-with-button" }, sshKey.row, browse(sshKey.el, "Choose a private key"))),
  );
  const serverRows = [h("div", { class: "ds-row" }, hostField.row, port.row), h("div", { class: "ds-row" }, user.row, pass.row), database.row, h("div", { class: "ds-row" }, h("label", { class: "field" }, "SSL mode", sslMode), h("div", { class: "field-with-button" }, ca.row, browse(ca.el, "Choose a certificate authority file")))];
  const fileRow = h("div", { class: "field-with-button" }, file.row, browse(file.el, "Choose a SQLite database"));
  const readOnlyRow = h("label", { class: "ds-check", title: "SQLite opens the file read-only, and MySQL and PostgreSQL start a read-only session. The grid and console refuse changes." }, readOnly, "Read-only: refuse changes to data");
  const form = h(
    "div",
    { class: "ds-form" },
    note,
    name.row,
    h("label", { class: "field" }, "Driver", driver),
    fileRow,
    ...serverRows,
    sshSection,
    readOnlyRow,
    url.row,
    h("div", { class: "ds-test-row" }, testButton, testResult),
  );

  /** Whether the connection's own values can change: a saved one, or .env's with an override. */
  const editable = (d: Draft) => d.origin === "saved" || (d.origin === "env" && !!d.overridden);

  function choose(d: Draft) {
    current = d;
    load();
  }

  /** Fills the form from the selected draft. */
  function load() {
    const d = current;
    const c = d.connection;
    name.el.value = d.name || ".env";
    driver.value = c.driver;
    file.el.value = c.driver === "sqlite" ? c.database.replace(`${o.root}/`, "") : "";
    hostField.el.value = c.host;
    port.el.value = c.port ? String(c.port) : "";
    user.el.value = c.username;
    pass.el.value = d.typedPassword ? c.password : "";
    pass.el.placeholder = d.keychain ? "Leave empty to keep the Keychain's password" : c.password ? (d.overridden ? "Saved in the Keychain" : "From the project") : "No password";
    database.el.value = c.database;
    sslMode.value = c.ssl_mode;
    ca.el.value = c.ssl_ca;
    const parts = parseDestination(d.ssh.destination);
    useSsh.checked = !!d.ssh.destination;
    sshHost.el.value = d.ssh.destination ? parts.host : "";
    sshPort.el.value = parts.port;
    sshUser.el.value = parts.user;
    sshKey.el.value = d.ssh.identityFile;
    readOnly.checked = d.readOnly;
    testResult.textContent = "";
    testResult.className = "ds-test";
    problem.textContent = "";
    // What the connection comes from, and what you can do about it.
    const act = (label: string, run: () => void) => h("button", { type: "button", onclick: run }, label);
    note.replaceChildren(
      ...(d.origin === "env"
        ? d.overridden
          ? ["Overrides the project's .env on this Mac. ", act("Use .env's Values", () => override(false))]
          : ["From the project's .env, as Laravel reads it. ", act("Override on This Mac", () => override(true))]
        : d.origin === "config"
          ? ["From config/database.php. ", act("Copy to a New Data Source", () => add(d))]
          : d.origin === "redis"
            ? ["From .env's REDIS_ variables. ", act("Copy to a New Data Source", () => add(d))]
            : []),
    );
    note.hidden = !note.childNodes.length;
    const locked = !editable(d);
    for (const el of [driver, file.el, hostField.el, port.el, user.el, pass.el, database.el, sslMode, ca.el, url.el]) el.disabled = locked;
    for (const b of form.querySelectorAll<HTMLButtonElement>(".field-with-button > .ds-browse")) b.disabled = locked && !sshSection.contains(b);
    name.el.disabled = d.origin !== "saved";
    removeButton.disabled = d.origin !== "saved";
    shape();
    syncUrl();
  }

  function override(on: boolean) {
    current.overridden = on;
    current.connection = { ...(on ? current.connection : current.original!) };
    current.typedPassword = false;
    touch();
    load();
  }

  /** Shows the fields the driver has. */
  function shape() {
    const d = driver.value;
    const sqlite = d === "sqlite";
    fileRow.hidden = !sqlite;
    for (const r of serverRows) r.hidden = sqlite;
    sshSection.hidden = sqlite;
    readOnlyRow.hidden = d === "redis";
    (database.row.firstChild as Text).textContent = d === "redis" ? "Database number" : "Database";
    for (const el of [sshHost.el, sshPort.el, sshUser.el, sshKey.el]) el.disabled = !useSsh.checked;
  }

  /** Reads the form into the selected draft. */
  function read() {
    const d = current;
    if (d.origin === "saved") d.name = name.el.value.trim();
    if (editable(d)) {
      const c = d.connection;
      const was = c.driver;
      c.driver = driver.value;
      if (was !== c.driver && (!port.el.value || Number(port.el.value) === DEFAULT_PORTS[was])) port.el.value = DEFAULT_PORTS[c.driver] ? String(DEFAULT_PORTS[c.driver]) : "";
      c.host = hostField.el.value.trim();
      c.port = Number(port.el.value) || DEFAULT_PORTS[c.driver] || 0;
      c.username = user.el.value;
      if (d.typedPassword) c.password = pass.el.value;
      const f = file.el.value.trim();
      c.database = c.driver === "sqlite" ? (f && !isAbsolute(f) ? `${o.root}/${f}` : f) : database.el.value.trim();
      c.ssl_mode = sslMode.value;
      c.ssl_ca = ca.el.value.trim();
    }
    d.ssh = { destination: useSsh.checked ? destinationOf(sshUser.el.value, sshHost.el.value, sshPort.el.value) : "", identityFile: useSsh.checked ? sshKey.el.value.trim() : "" };
    d.readOnly = readOnly.checked;
  }
  function touch() {
    current.dirty = true;
    const row = list.querySelector<HTMLElement>(`li[data-key="${current.key}"]`);
    if (row && !row.querySelector(".ds-dirty")) row.append(h("span", { class: "ds-dirty", title: "Changed" }, "•"));
    if (row) (row.querySelector(".ds-name")!.textContent = current.name || ".env"), (row.title = describe(current.connection, o.root));
  }
  const syncUrl = () => {
    url.el.value = connectionUrl(current.connection, o.root);
    url.el.removeAttribute("aria-invalid");
  };

  form.addEventListener("input", (e) => {
    const target = e.target as HTMLElement;
    if (target === url.el) {
      // A URL fills in the fields; its password, when it has one, becomes the password.
      const c = connectionFromUrl(url.el.value, o.root);
      if (!c) return url.el.setAttribute("aria-invalid", "true");
      url.el.removeAttribute("aria-invalid");
      current.connection = { ...c, password: c.password || current.connection.password };
      if (c.password) current.typedPassword = true;
      touch();
      const value = url.el.value;
      load();
      url.el.value = value;
      return;
    }
    if (target === pass.el) current.typedPassword = true;
    read();
    touch();
    shape();
    if (target !== url.el) syncUrl();
  });
  form.addEventListener("change", (e) => e.target === driver && (read(), touch(), shape(), syncUrl()));

  async function test() {
    read();
    testButton.disabled = true;
    testResult.className = "ds-test";
    testResult.replaceChildren(h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), " Connecting…");
    const started = performance.now();
    try {
      const password = current.keychain !== undefined && !current.typedPassword ? await o.password(current.keychain) : current.connection.password;
      const version = await o.test({ ...current.connection, password, read_only: current.readOnly }, current.ssh);
      testResult.className = "ds-test ok";
      testResult.replaceChildren(icon("check"), ` Connected: ${version} · ${Math.round(performance.now() - started)} ms`);
    } catch (e) {
      testResult.className = "ds-test failed";
      testResult.replaceChildren(icon("error"), ` ${o.friendlyError(errorText(e))}`);
    } finally {
      testButton.disabled = false;
    }
  }

  // ---- Saving ----

  /** Why the drafts can't be saved, selecting the one with the problem, or "". */
  function check() {
    const names = new Set<string>();
    for (const d of drafts) {
      const why =
        d.origin !== "saved"
          ? ""
          : !d.name
            ? "Type a name."
            : names.has(d.name) || drafts.some((x) => x !== d && x.origin !== "saved" && x.name === d.name)
              ? `Another data source is named ${d.name}.`
              : d.connection.driver === "sqlite"
                ? d.connection.database
                  ? ""
                  : "Choose the database file."
                : d.connection.host
                  ? ""
                  : "Type the host.";
      names.add(d.name);
      if (why) return nav.select(d.key), why;
    }
    return "";
  }
  const saveButton = h("button", { type: "button", class: "primary" }, "Save");
  const shareBox = h("input", { type: "checkbox", checked: o.shared });
  saveButton.onclick = () => {
    const why = check();
    if (why) return (problem.textContent = why);
    const edits = drafts
      .filter((d) => d.dirty)
      .map((d): SourceEdit => ({
        name: d.name,
        origin: d.origin,
        previous: d.previous,
        connection: d.origin === "env" && !d.overridden ? null : d.connection,
        ssh: d.ssh,
        readOnly: d.readOnly,
        password: d.keychain !== undefined && !d.typedPassword ? undefined : d.connection.password,
        keychain: d.keychain,
      }));
    // A new connection you were editing is the one to use.
    result = { edits, removed, select: current.origin === "saved" && current.previous === undefined ? current.name : undefined, shared: shareBox.checked };
    dialog.close();
  };

  const dialog = h(
    "dialog",
    { id: "data-sources", class: "refactor-dialog", ariaLabel: "Data Sources" },
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, "Data Sources"),
      h("div", { class: "ds-body" }, h("div", { class: "ds-side" }, list, h("div", { class: "ds-list-actions" }, addButton, copyButton, removeButton)), form),
      problem,
      h(
        "div",
        { class: "buttons" },
        h("label", { class: "ds-share", title: `${o.root}/tusk.json` }, shareBox, "Share saved connections in tusk.json"),
        h("span", { class: "dialog-hint" }, "Passwords stay in your Mac's Keychain."),
        h("button", { type: "button", onclick: () => dialog.close() }, "Cancel"),
        saveButton,
      ),
    ),
  );
  // Enter in a field saves, as in other dialogs; Escape cancels.
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "checkbox") e.preventDefault(), saveButton.click();
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
    nav.select(current.key);
    choose(current);
    if (o.section === "ssh" && !sshSection.hidden) (useSsh.checked ? sshHost.el : useSsh).focus(), sshSection.scrollIntoView({ block: "nearest" });
    else list.focus();
  });
}
