// The Formatters dialog: the formatter and format-on-save choice for each language in the project, kept as the
// project's `formatters` value, on this Mac or shared in tusk.json.
import { h } from "./dom";
import { FORMAT_GROUPS, FORMATTER_NAMES, type FormatterChoices, type FormatterId } from "./formatdata";
import { formattersChanged, formatterTools } from "./format";
import { projectScope, projectValue, setProjectValue } from "./projectstate";
import { settings } from "./settings";
import { showError } from "./status";

/** What a formatter option says about whether it can run in this project. */
function note(id: FormatterId, group: string) {
  const t = formatterTools();
  if (id === "auto") return group === "php" ? "Auto: Prettier's PHP plugin, else Pint, else Mago" : group === "blade" ? "Auto: Prettier's Blade plugin, else blade-formatter" : `Auto: ${t.node ? (t.bundled ? "bundled Prettier" : "the project's Prettier") : "built-in, since Node.js is missing"}`;
  if (id === "pint" && !t.pint) return `${FORMATTER_NAMES[id]} (not installed)`;
  if (id === "php-cs-fixer" && !t.phpCsFixer) return `${FORMATTER_NAMES[id]} (not installed)`;
  if (id === "prettier") return !t.node ? "Prettier (needs Node.js)" : t.bundled ? (group === "php" || group === "blade" ? "Prettier (not installed)" : "Prettier (bundled)") : "Prettier (the project's)";
  if (id === "builtin") return "Built-in (Monaco's)";
  if (id === "mago") return "Mago (bundled)";
  if (id === "blade-formatter") return t.node ? "blade-formatter (bundled)" : "blade-formatter (needs Node.js)";
  return FORMATTER_NAMES[id];
}

/** Opens the dialog. Saving writes the choices to the project, where they apply at once. */
export function openFormatters() {
  document.getElementById("formatters")?.remove();
  const initial: FormatterChoices = projectValue<FormatterChoices>("formatters") ?? {};
  const dialog = h("dialog", { id: "formatters", class: "list-dialog", ariaLabel: "Formatters" });
  const sharedBox = h("input", { type: "checkbox", checked: projectScope("formatters") === "shared" });
  const rows = FORMAT_GROUPS.map((g) => {
    const use = h("select", { ariaLabel: `Formatter for ${g.label}` });
    for (const id of g.formatters) use.append(new Option(note(id, g.id), id));
    use.value = initial[g.id]?.use ?? "auto";
    const onSave = h("select", { ariaLabel: `Format ${g.label} on save` });
    onSave.append(new Option(`Default (${settings.formatOnSave ? "on" : "off"})`, ""), new Option("On", "on"), new Option("Off", "off"));
    const saved = initial[g.id]?.onSave;
    onSave.value = saved === undefined ? "" : saved ? "on" : "off";
    return { g, use, onSave, tr: h("tr", {}, h("td", {}, g.label), h("td", {}, use), h("td", {}, onSave)) };
  });
  const result = (): FormatterChoices =>
    Object.fromEntries(
      rows.flatMap(({ g, use, onSave }) => {
        const entry: FormatterChoices[string] = {};
        if (use.value !== "auto") entry.use = use.value as FormatterId;
        if (onSave.value) entry.onSave = onSave.value === "on";
        return Object.keys(entry).length ? [[g.id, entry]] : [];
      }),
    );
  const save = h("button", { type: "button", class: "primary" }, "Save");
  save.onclick = async () => {
    const choices = result();
    try {
      await setProjectValue("formatters", Object.keys(choices).length ? choices : undefined, sharedBox.checked ? "shared" : "local");
      formattersChanged();
      dialog.close();
    } catch (e) {
      showError("Can't save the formatters", e);
    }
  };
  dialog.append(
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, "Formatters"),
      h("p", { class: "muted" }, "How Reformat Code (⌥⌘L) and format on save format each language in this project. Default follows Settings > Editor > Format files when saving."),
      h("div", { class: "exclusions-table" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Language"), h("th", {}, "Formatter"), h("th", {}, "On save"))), h("tbody", {}, ...rows.map((r) => r.tr)))),
      h(
        "div",
        { class: "buttons" },
        h("label", { class: "shared" }, sharedBox, "Share with the project in tusk.json"),
        h("button", { type: "button", onclick: () => dialog.close() }, "Cancel"),
        save,
      ),
    ),
  );
  document.body.append(dialog);
  dialog.onclose = () => dialog.remove();
  dialog.showModal();
  rows[0].use.focus();
}
