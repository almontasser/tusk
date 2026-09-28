// The Run/Debug Configurations dialog: configurations on the left, grouped by type, and the selected one's form on
// the right. The form comes from each type's fields in runconfig.ts, plus the fields every type has, so a new type
// needs no code here.
import { invoke } from "@tauri-apps/api/core";
import { h, icon, iconButton } from "./dom";
import { showMenu } from "./files";
import { listNav } from "./listnav";
import { type ConfigType, type Field, type Mode, newConfig, type Project, type RunConfig, summary, TYPES, uniqueName, validate } from "./runconfig";
import type { Entry } from "./runner";

type Options = {
  entries: Entry[];
  selected?: string;
  /** Starts by adding a configuration of this type. */
  add?: ConfigType;
  root: string;
  project: Project;
  /** Saves the configurations, for OK and Apply. */
  save(entries: Entry[], selected: string): Promise<void>;
};

/** Opens the dialog. Resolves when it closes: with the mode to run the selected configuration in when you chose Run or Debug. */
export function openConfigurationsDialog({ entries: initial, selected, add, root, project, save }: Options): Promise<Mode | null> {
  document.getElementById("run-configurations")?.remove();
  let ids = 0;
  type Item = Entry & { id: string };
  let items: Item[] = structuredClone(initial).map((e) => ({ ...e, id: String(++ids) }));
  let current: Item | undefined = items.find((i) => i.config.name === selected) ?? items[0];
  let saved = JSON.stringify(initial);
  let result: Mode | null = null;

  const dialog = h("dialog", { id: "run-configurations", class: "refactor-dialog", ariaLabel: "Run/Debug Configurations" });
  const list = h("div", { class: "rc-list", role: "listbox", ariaLabel: "Run configurations" });
  const form = h("div", { class: "rc-form" });
  const problems = h("ul", { class: "dialog-problems", role: "alert" });
  const applyButton = h("button", { type: "button", textContent: "Apply", onclick: () => void apply() });
  const okButton = h("button", { type: "button", class: "primary", textContent: "OK", onclick: () => void apply().then((ok) => ok && dialog.close()) });
  const runButton = h("button", { type: "button", onclick: () => void runNow("run") }, icon("play"), "Run");
  const debugButton = h("button", { type: "button", onclick: () => void runNow("debug") }, icon("debug-alt-small"), "Debug");
  const removeButton = iconButton("remove", "Remove (⌫)", () => remove());
  const copyButton = iconButton("copy", "Duplicate (⌘D)", () => duplicate());
  const keepButton = iconButton("save", "Save Temporary Configuration", () => current && ((current.where = "local"), renderList(), renderForm()));

  const nav = listNav(list, {
    onSelect: (row) => {
      current = items.find((i) => i.id === row.dataset.key);
      renderForm();
    },
  });
  list.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" || e.key === "Delete") e.preventDefault(), remove();
    if (e.key === "d" && e.metaKey) e.preventDefault(), duplicate();
  });

  const others = () => items.filter((i) => i !== current).map((i) => i.config);
  const errorsOf = (i: Item) => validate(i.config, items.map((o) => o.config));

  function renderList() {
    const groups = (Object.keys(TYPES) as ConfigType[]).map((type) => [type, items.filter((i) => i.config.type === type)] as const).filter(([, list]) => list.length);
    list.replaceChildren(
      ...(groups.length
        ? groups.flatMap(([type, members]) => [
            h("div", { class: "rc-group", role: "presentation" }, icon(TYPES[type].icon), TYPES[type].label),
            ...members.map((i) =>
              h(
                "div",
                { class: `rc-item${i.where === "temporary" ? " temporary" : ""}${errorsOf(i).length ? " invalid" : ""}`, role: "option", data: { key: i.id }, title: i.where === "temporary" ? "Temporary: save it to keep it" : i.where === "shared" ? "Shared in tusk.json" : "On this Mac" },
                icon(TYPES[i.config.type].icon),
                h("span", { class: "rc-name" }, i.config.name || "(no name)"),
                i.where === "shared" ? h("span", { class: "codicon codicon-organization rc-where", ariaLabel: "shared" }) : null,
                errorsOf(i).length ? h("span", { class: "codicon codicon-warning rc-where", ariaLabel: "has problems" }) : null,
              ),
            ),
          ])
        : [h("p", { class: "rc-empty" }, "No configurations. Click + to add one.")]),
    );
    if (current) nav.select(current.id, { scroll: false });
    removeButton.disabled = copyButton.disabled = !current;
    keepButton.hidden = current?.where !== "temporary";
    const changed = JSON.stringify(items.map(({ config, where }) => ({ config, where }))) !== saved;
    applyButton.disabled = !changed;
  }

  /** A labeled control for one field. */
  function control(field: Field, c: RunConfig, fallback?: unknown) {
    const value = c[field.key] ?? fallback;
    const set = (v: unknown, redraw = false) => {
      (c as Record<string, unknown>)[field.key] = v === "" ? undefined : v;
      update(redraw);
    };
    if (field.kind === "checkbox") {
      const box = h("input", { type: "checkbox", checked: !!value, onchange: () => set(box.checked, true) });
      return h("label", { class: "rc-check" }, box, field.label);
    }
    let input: HTMLInputElement | HTMLSelectElement;
    if (field.kind === "select") {
      input = h("select", {}, ...(field.options ?? []).map(([v, label]) => h("option", { value: v, selected: v === (value ?? field.options![0][0]) }, label)));
      input.onchange = () => set(input.value, true);
    } else {
      input = h("input", { type: field.kind === "number" ? "number" : "text", value: value === undefined ? "" : String(value), placeholder: field.placeholder ?? "", spellcheck: false });
      input.oninput = () => set(field.kind === "number" ? (input.value === "" ? undefined : Number(input.value)) : input.value);
    }
    const note = field.path ? h("span", { class: "rc-note" }) : null;
    if (note) {
      const check = () => checkPath(c[field.key] as string | undefined, field.path!, note);
      input.addEventListener("input", check);
      check();
    }
    return h("label", { class: "field grow" }, field.label, input, field.help ? h("span", { class: "rc-help" }, field.help) : null, note);
  }

  /** Says, under a path field, when the file or folder isn't in the project. */
  async function checkPath(path: string | undefined, kind: "file" | "dir", note: HTMLElement) {
    const want = path?.trim();
    note.textContent = "";
    if (!want) return;
    const full = want.startsWith("/") ? want : `${root}/${want}`;
    const found = await invoke<boolean>("path_exists", { path: full }).catch(() => false);
    if ((path ?? "").trim() === want) note.textContent = found ? "" : `No such ${kind === "dir" ? "folder" : "file"} in the project.`;
  }

  /** The environment variables: a key and value per row. */
  function envEditor(c: RunConfig) {
    const rows = Object.entries(c.env ?? {});
    const body = h("div", { class: "rc-env" });
    const write = () => {
      c.env = Object.fromEntries(rows.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));
      update();
    };
    const draw = (): void =>
      body.replaceChildren(
        ...rows.map((row, i) => {
          const key = h("input", { value: row[0], placeholder: "NAME", ariaLabel: "Variable name", spellcheck: false, oninput: () => ((row[0] = key.value), write()) });
          const value = h("input", { value: row[1], placeholder: "value", ariaLabel: `Value of ${row[0] || "the variable"}`, spellcheck: false, oninput: () => ((row[1] = value.value), write()) });
          return h("div", { class: "rc-env-row" }, key, h("span", {}, "="), value, iconButton("close", "Remove variable", () => (rows.splice(i, 1), write(), draw())));
        }),
        h("button", { type: "button", class: "rc-add", onclick: () => (rows.push(["", ""]), draw(), body.querySelector<HTMLInputElement>(".rc-env-row:last-of-type input")?.focus()) }, icon("add"), "Add variable"),
      );
    draw();
    return h("div", { class: "field grow" }, h("span", {}, "Environment variables"), body);
  }

  /** Before launch: other configurations or shell commands to run first, in order. */
  function beforeEditor(c: RunConfig) {
    const steps = c.before ?? [];
    const body = h("div", { class: "rc-before" });
    const write = () => ((c.before = steps.length ? steps : undefined), update());
    const draw = (): void =>
      body.replaceChildren(
        ...steps.map((step, i) => {
          const remove = iconButton("close", "Remove step", () => (steps.splice(i, 1), write(), draw()));
          if ("config" in step) {
            const select = h("select", { ariaLabel: "Configuration to run first" }, ...others().map((o) => h("option", { value: o.name, selected: o.name === step.config }, o.name)));
            if (!others().some((o) => o.name === step.config)) select.prepend(h("option", { value: step.config, selected: true }, `${step.config} (missing)`));
            select.onchange = () => ((step.config = select.value), write());
            return h("div", { class: "rc-env-row" }, icon("run"), select, remove);
          }
          const input = h("input", { value: step.command, placeholder: "npm run build", ariaLabel: "Command to run first", spellcheck: false, oninput: () => ((step.command = input.value), write()) });
          return h("div", { class: "rc-env-row" }, icon("terminal"), input, remove);
        }),
        h(
          "button",
          {
            type: "button",
            class: "rc-add",
            onclick: (e: MouseEvent) =>
              showMenu(e.clientX, e.clientY, [
                ...(others().length ? [{ label: "Run Another Configuration", run: () => (steps.push({ config: others()[0].name }), write(), draw()) }] : []),
                { label: "Run a Shell Command", run: () => (steps.push({ command: "" }), write(), draw(), body.querySelector<HTMLInputElement>(".rc-env-row:last-of-type input")?.focus()) },
              ]),
          },
          icon("add"),
          "Add step",
        ),
      );
    draw();
    return h("div", { class: "field grow" }, h("span", {}, "Before launch"), body);
  }

  const preview = h("code", { class: "rc-preview" });

  function renderForm() {
    renderList();
    if (!current) {
      form.replaceChildren(h("p", { class: "rc-empty" }, "Add a configuration with +, or run a test from the gutter to get a temporary one."));
      update();
      return;
    }
    const item = current;
    const c = item.config;
    const info = TYPES[c.type];
    const name = h("input", { value: c.name, spellcheck: false, ariaLabel: "Name" });
    name.oninput = () => {
      const old = c.name;
      c.name = name.value;
      // Other configurations' before-launch steps follow the rename.
      for (const i of items) for (const step of i.config.before ?? []) if ("config" in step && step.config === old) step.config = c.name;
      update();
    };
    const share = h("input", { type: "checkbox", checked: item.where === "shared", disabled: item.where === "temporary" });
    share.onchange = () => ((item.where = share.checked ? "shared" : "local"), update());
    form.replaceChildren(
      h("div", { class: "dialog-fields" }, h("label", { class: "field grow" }, "Name", name)),
      h(
        "div",
        { class: "dialog-options" },
        h("label", { title: `${root}/tusk.json` }, share, "Store in tusk.json (share)"),
        item.where === "temporary" ? h("span", { class: "option-note" }, "Temporary: save it to keep it.") : null,
      ),
      h("h3", {}, icon(info.icon), info.label),
      h("div", { class: "dialog-fields" }, ...info.fields.filter((f) => f.kind !== "checkbox" && (!f.shown || f.shown(c))).map((f) => control(f, c))),
      h("div", { class: "dialog-options" }, ...info.fields.filter((f) => f.kind === "checkbox" && (!f.shown || f.shown(c))).map((f) => control(f, c))),
      h("h3", {}, "Environment"),
      h(
        "div",
        { class: "dialog-fields" },
        control({ key: "cwd", label: "Working directory", kind: "text", placeholder: "The project folder", path: "dir" }, c),
      ),
      envEditor(c),
      h(
        "div",
        { class: "dialog-options" },
        info.php ? control({ key: "docker", label: "Run in Docker when it's up (Sail, or the Compose service you chose)", kind: "checkbox" }, c, info.defaults.docker) : null,
        control({ key: "multiple", label: "Allow multiple instances", kind: "checkbox" }, c),
      ),
      beforeEditor(c),
      h("div", { class: "rc-command" }, h("span", {}, "Runs"), preview),
    );
    update();
  }

  /** Redraws what depends on the values: the list, the problems, the command, and the buttons. `redraw` rebuilds the form too. */
  function update(redraw = false) {
    if (redraw) return renderForm();
    renderList();
    const errors = current ? errorsOf(current) : [];
    problems.replaceChildren(...errors.map((e) => h("li", { class: "error" }, icon("error"), e)));
    preview.textContent = current ? summary(current.config, project) : "";
    runButton.disabled = debugButton.disabled = !current || errors.length > 0;
    if (current && !TYPES[current.config.type].php) debugButton.disabled = true;
  }

  function addConfig(type: ConfigType) {
    const item: Item = { config: newConfig(type, items.map((i) => i.config.name)), where: "local", id: String(++ids) };
    items.push(item);
    current = item;
    renderForm();
    const name = form.querySelector<HTMLInputElement>("input");
    name?.focus();
    name?.select();
  }

  function duplicate() {
    if (!current) return;
    const copy: Item = { config: { ...structuredClone(current.config), name: uniqueName(current.config.name, items.map((i) => i.config.name)) }, where: current.where === "temporary" ? "local" : current.where, id: String(++ids) };
    items.splice(items.indexOf(current) + 1, 0, copy);
    current = copy;
    renderForm();
  }

  function remove() {
    if (!current) return;
    const at = items.indexOf(current);
    items = items.filter((i) => i !== current);
    current = items[Math.min(at, items.length - 1)];
    renderForm();
    list.focus();
  }

  /** Saves, unless a configuration has problems: then it selects that one and says so. */
  async function apply() {
    const bad = items.find((i) => errorsOf(i).length);
    if (bad) {
      current = bad;
      renderForm();
      return false;
    }
    const entries = items.map(({ config, where }) => ({ config, where }));
    await save(entries, current?.config.name ?? "");
    saved = JSON.stringify(entries);
    renderList();
    return true;
  }

  async function runNow(mode: Mode) {
    if (!(await apply())) return;
    result = mode;
    dialog.close();
  }

  const addButton = iconButton("add", "Add New Configuration", () => {
    const r = addButton.getBoundingClientRect();
    showMenu(r.left, r.bottom + 2, (Object.keys(TYPES) as ConfigType[]).map((t) => ({ label: TYPES[t].label, run: () => addConfig(t) })));
  });

  dialog.append(
    h(
      "form",
      { method: "dialog", onsubmit: (e: Event) => e.preventDefault() },
      h("h2", {}, "Run/Debug Configurations"),
      h(
        "div",
        { class: "rc-body" },
        h("div", { class: "rc-side" }, h("div", { class: "rc-tools" }, addButton, removeButton, copyButton, keepButton), list),
        h("div", { class: "rc-main" }, form, problems),
      ),
      h("div", { class: "buttons" }, runButton, debugButton, h("span", { class: "dialog-hint" }), h("button", { type: "button", textContent: "Cancel", onclick: () => dialog.close() }), applyButton, okButton),
    ),
  );
  document.body.append(dialog);
  if (add) addConfig(add);
  else renderForm();

  return new Promise((resolve) => {
    dialog.onclose = () => {
      dialog.remove();
      resolve(result);
    };
    dialog.showModal();
    if (!add) list.focus();
  });
}
