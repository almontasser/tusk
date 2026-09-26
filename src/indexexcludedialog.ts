// The Index Exclusions dialog: the vendor folders Phpactor's index and Mago skip, with a scan that suggests
// more (folders whose PHP files declare nothing), and where the list is kept. See indexexclude.ts.
import { invoke } from "@tauri-apps/api/core";
import { h, icon, iconButton } from "./dom";
import { covers, DEFAULT_EXCLUDES } from "./indexexclude";

type Folder = { path: string; files: number; bytes: number };
type Options = {
  root: string;
  list: string[];
  shared: boolean;
  /** Before a project's first index: scans at once, and offers to keep the defaults instead. */
  firstIndex?: boolean;
};

const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);

/** Opens the dialog. Resolves with the list and where to keep it, or null when cancelled. */
export function editExclusions({ root, list: initial, shared: initialShared, firstIndex = false }: Options): Promise<{ list: string[]; shared: boolean } | null> {
  document.getElementById("index-exclusions")?.remove();
  let list = [...initial];
  let found: Folder[] | null = null;
  /** Suggestions left unchecked, by path. */
  const unchecked = new Set<string>();
  let resolved: { list: string[]; shared: boolean } | null = null;

  const dialog = h("dialog", { id: "index-exclusions" });
  const excludedRows = h("tbody");
  const suggestionRows = h("tbody");
  const suggestions = h("div", { class: "exclusions-table", hidden: true }, h("table", {}, h("thead", {}, h("tr", {}, h("th"), h("th", {}, "Folder"), h("th", {}, "Files"), h("th", {}, "Size"))), suggestionRows));
  const scanStatus = h("span", { class: "muted" });
  const scanButton = h("button", { type: "button", onclick: () => scan() }, icon("search"), "Scan vendor");
  // Focused first, so Enter adds a folder instead of pressing the first row's remove button.
  const addInput = h("input", { placeholder: "vendor/package/data or vendor/**/fixtures", spellcheck: false, ariaLabel: "Folder to skip", autofocus: true });
  const sharedBox = h("input", { type: "checkbox", checked: initialShared });
  const saveButton = h("button", { type: "button", class: "primary", textContent: firstIndex ? "Save and Index" : "Save and Reindex" });

  const pending = () => (found ?? []).filter((f) => !covers(list, f.path));
  const result = () => [...list, ...pending().filter((f) => !unchecked.has(f.path)).map((f) => f.path)];
  const render = () => {
    excludedRows.replaceChildren(
      ...list.map((p) =>
        h("tr", {}, h("td", { class: "path" }, p), h("td", { class: "row-actions" }, iconButton("close", "Stop skipping this folder", () => ((list = list.filter((x) => x !== p)), render())))),
      ),
    );
    const rows = pending();
    suggestionRows.replaceChildren(
      ...rows.map((f) => {
        const box = h("input", { type: "checkbox", checked: !unchecked.has(f.path), ariaLabel: `Skip ${f.path}` });
        box.onchange = () => (box.checked ? unchecked.delete(f.path) : unchecked.add(f.path), render());
        return h("tr", {}, h("td", {}, box), h("td", { class: "path" }, f.path), h("td", { class: "number" }, f.files.toLocaleString()), h("td", { class: "number" }, size(f.bytes)));
      }),
    );
    suggestions.hidden = !rows.length;
    if (found) scanStatus.textContent = rows.length ? `${rows.length} ${rows.length === 1 ? "folder declares" : "folders declare"} nothing. Checked ones are skipped when you save.` : "No other vendor folder of 100 KB or more declares nothing.";
    const changed = JSON.stringify(result()) !== JSON.stringify(initial) || sharedBox.checked !== initialShared;
    saveButton.disabled = !firstIndex && !changed;
  };

  async function scan() {
    scanButton.disabled = true;
    scanStatus.textContent = "Reading vendor…";
    found = await invoke<Folder[]>("symbol_free_folders", { root }).catch((e) => ((scanStatus.textContent = `Can't scan: ${e}`), null));
    scanButton.disabled = false;
    render();
  }

  const add = () => {
    const p = addInput.value.trim().replace(/^\/+|\/+$/g, "");
    if (p && !list.includes(p)) list.push(p);
    addInput.value = "";
    render();
  };
  addInput.onkeydown = (e) => e.key === "Enter" && (e.preventDefault(), e.stopPropagation(), add());
  sharedBox.onchange = render;

  dialog.append(
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, firstIndex ? "Before the First Index" : "Index Exclusions"),
      h(
        "p",
        { class: "muted" },
        "Phpactor's index and Mago skip these folders. Skip folders whose PHP files declare no classes or functions, such as data and translations: indexing gets faster, and nothing goes missing.",
      ),
      h("div", { class: "exclusions-table" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Skipped folders"), h("th"))), excludedRows)),
      h("div", { class: "exclusions-tools" }, addInput, h("button", { type: "button", onclick: add }, icon("add"), "Add"), h("button", { type: "button", onclick: () => ((list = [...DEFAULT_EXCLUDES]), render()) }, "Restore Defaults")),
      h("div", { class: "exclusions-tools" }, scanButton, scanStatus),
      suggestions,
      h(
        "div",
        { class: "buttons" },
        h("label", { class: "shared", title: `${root}/tusk.json` }, sharedBox, "Share with the project in tusk.json"),
        h("button", { type: "button", textContent: firstIndex ? "Keep Defaults" : "Cancel", onclick: () => dialog.close() }),
        saveButton,
      ),
    ),
  );
  saveButton.onclick = () => ((resolved = { list: result(), shared: sharedBox.checked }), dialog.close());
  render();
  document.body.append(dialog);

  return new Promise((resolve) => {
    dialog.onclose = () => {
      dialog.remove();
      resolve(resolved);
    };
    dialog.showModal();
    if (firstIndex) scan();
  });
}
