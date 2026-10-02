// "New page": asks what a custom page does (edit one record in a form, or list records in a table), writes it in the
// panel's pages folder with fields or columns for the model's columns (src/pagegen.ts), and opens it in the designer.
import { invoke } from "@tauri-apps/api/core";
import { h, icon } from "./dom";
import * as fapp from "./filamentapp";
import { humanize } from "./filamentcatalog";
import { host, openDesigner } from "./filamentdesigner";
import { formField, inFormByDefault, inTableByDefault, renderGen, tableColumn } from "./filamentgen";
import { popover } from "./filamentpickers";
import { shortClass } from "./filamentschema";
import { PAGE_KINDS, type PageKind, pageFile } from "./pagegen";
import { showError } from "./status";

/** Columns a user's own form leaves out: secrets and what the app sets. */
const USER_HIDDEN = /^(password|remember_token|email_verified_at|two_factor_\w+|app_authentication_\w+)$/;

export async function newPage(anchor: HTMLElement | { x: number; y: number }, panel: fapp.PanelInfo, onCreated: () => void) {
  const root = host.root();
  const dir = panel.pageDirs[0];
  const ns = panel.pageNamespaces[0];
  if (!dir || !ns) return host.status("The panel doesn't discover pages in a folder. Add ->discoverPages() to its provider.");
  const [models, options] = await Promise.all([fapp.models(root).catch(() => ({})), fapp.panelOptions(root).catch(() => null)]);
  const userModel = options?.user?.class ?? null;
  let kind: PageKind = "form";
  let record: "user" | "single" = "single";
  const name = h("input", { placeholder: "CompanySettings", spellcheck: false });
  const title = h("input", { placeholder: "Company settings", spellcheck: false });
  name.oninput = () => (title.placeholder = humanize(name.value.trim() || "CompanySettings"));
  const model = h("select", {}, ...Object.keys(models).map((m) => h("option", { value: m, textContent: shortClass(m) })));
  const whose = h("select", {}, h("option", { value: "single", textContent: "Its one record, made when first saved" }), ...(userModel ? [h("option", { value: "user", textContent: "The signed-in user's record" })] : []));
  whose.onchange = () => {
    record = whose.value as "user" | "single";
    if (record === "user" && userModel) model.value = userModel;
    model.disabled = record === "user";
  };
  const whoseRow = h("label", { class: "np-row" }, h("span", { class: "fd-note" }, "Edits"), whose);
  const kinds = h("div", { class: "db-kinds np-kinds" });
  const drawKinds = () => {
    kinds.replaceChildren(...PAGE_KINDS.map(([k, label, hint]) => h("button", { type: "button", class: `db-kind${k === kind ? " selected" : ""}`, title: hint, onclick: () => ((kind = k), drawKinds()) }, icon(k === "form" ? "note" : "table"), label)));
    whoseRow.hidden = kind !== "form";
  };
  drawKinds();
  const problem = h("p", { class: "fd-ask-problem" });
  const create = async () => {
    const n = name.value.trim().replace(/\.php$/, "");
    if (!/^[A-Z][A-Za-z0-9]*$/.test(n)) return void (problem.textContent = "A class name, such as CompanySettings.");
    if (!model.value) return void (problem.textContent = "Pick a model.");
    const path = `${root}/${dir}/${n}.php`;
    if (await invoke<boolean>("path_exists", { path })) return void (problem.textContent = `${n}.php already exists.`);
    try {
      const facts = await fapp.modelFacts(root, model.value);
      const name_ = (fqn: string) => `{{${fqn}}}`;
      const components =
        kind === "table"
          ? facts.columns.filter((c) => inTableByDefault(c, facts) && c.name !== "id").slice(0, 6).map((c) => renderGen(tableColumn(c, facts), name_))
          : facts.columns.filter((c) => inFormByDefault(c, facts) && !(record === "user" && USER_HIDDEN.test(c.name))).map((c) => renderGen(formField(c, facts), name_));
      const t = title.value.trim() || humanize(n);
      await invoke("create_file", { path, contents: pageFile({ kind, namespace: ns, name: n, title: t, icon: kind === "form" ? "OutlinedCog6Tooth" : "OutlinedTableCells", model: model.value, record, components }) });
      p.close();
      fapp.forget(["app"]);
      host.status(`Created ${n}.`);
      onCreated();
      void openDesigner(path);
    } catch (e) {
      showError("Can't create the page", e);
    }
  };
  name.onkeydown = (e) => void (e.key === "Enter" && void create());
  const p = popover(
    anchor,
    h(
      "div",
      { class: "fd-ask db-new" },
      h("label", { class: "fd-ask-title" }, `New page in ${panel.id}`),
      kinds,
      h("label", { class: "fd-note" }, "Class name"),
      name,
      h("label", { class: "fd-note" }, "Title"),
      title,
      h("label", { class: "fd-note" }, "Model"),
      model,
      whoseRow,
      problem,
      h("div", { class: "fd-ask-buttons" }, h("button", { type: "button", textContent: "Cancel", onclick: () => p.close() }), h("button", { type: "button", class: "primary", textContent: "Create", onclick: () => void create() })),
    ),
  );
  requestAnimationFrame(() => name.focus());
}
