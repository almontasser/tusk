// Hidden and excluded files in the project tree, per project: the `treeHidden` and `treeExcluded` values, on this
// Mac or shared in tusk.json, with the defaults in treefilter.ts. Hidden entries show, dimmed, only while "Show
// hidden files" is on; excluded ones show dimmed, and local history skips both.
import { h } from "./dom";
import { onProjectValue, projectScope, projectValue, setProjectValue } from "./projectstate";
import { onSettings, registerSettings, updateSetting } from "./settings";
import { showError } from "./status";
import { DEFAULT_EXCLUDED, DEFAULT_HIDDEN, listed, parseList } from "./treefilter";

const tree = registerSettings("Project Tree", { showHiddenFiles: false }, [
  { key: "showHiddenFiles", label: "Show hidden files and folders", type: "checkbox", help: "Shows them dimmed. Tools > Hidden Files and Folders… sets what the project hides." },
]);

const list = (key: string, fallback: string[]) => {
  const v = projectValue<unknown>(key);
  return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : fallback;
};
const hiddenList = () => list("treeHidden", DEFAULT_HIDDEN);
const excludedList = () => list("treeExcluded", DEFAULT_EXCLUDED);

/** How the tree shows a path relative to the project: left out, dimmed as hidden, dimmed as excluded, or plainly. */
export function treeState(rel: string): "omit" | "hidden" | "excluded" | "" {
  if (listed(hiddenList(), rel)) return tree.showHiddenFiles ? "hidden" : "omit";
  return listed(excludedList(), rel) ? "excluded" : "";
}

/** Whether local history skips a path relative to the project: it's hidden or excluded. */
export const skippedPath = (rel: string) => listed(hiddenList(), rel) || listed(excludedList(), rel);

export const toggleHiddenFiles = () => updateSetting("showHiddenFiles", !tree.showHiddenFiles);

let redraw = () => {};
/** Sets how the tree redraws, and redraws it when the lists or the setting change. */
export function initTreeHidden(draw: () => void) {
  redraw = draw;
  let shown = tree.showHiddenFiles;
  onSettings(() => {
    if (shown !== tree.showHiddenFiles) (shown = tree.showHiddenFiles), redraw();
    document.getElementById("tree-hidden")?.classList.toggle("active", shown);
  });
  onProjectValue("treeHidden", redraw);
  onProjectValue("treeExcluded", redraw);
}

const shared = () => projectScope("treeHidden") === "shared" || projectScope("treeExcluded") === "shared";

async function save(hidden: string[], excluded: string[], share: boolean) {
  const scope = share ? "shared" : "local";
  await setProjectValue("treeHidden", hidden, scope);
  await setProjectValue("treeExcluded", excluded, scope);
  redraw();
}

/** Adds a path relative to the project to the hidden list, from the tree's context menu. */
export function hideInTree(rel: string) {
  save([...hiddenList(), rel], excludedList(), shared()).catch((e) => showError(`Can't hide ${rel}`, e));
}

/** Opens the dialog that edits both lists, one pattern per line. */
export function editTreeHidden() {
  document.getElementById("tree-hidden-dialog")?.remove();
  const dialog = h("dialog", { id: "tree-hidden-dialog", class: "list-dialog", ariaLabel: "Hidden Files and Folders" });
  const area = (label: string, items: string[], defaults: string[]) => {
    const text = h("textarea", { rows: 7, spellcheck: false, ariaLabel: label, className: "pattern-list" });
    text.value = items.join("\n");
    const reset = h("button", { type: "button", onclick: () => (text.value = defaults.join("\n")) }, "Restore Defaults");
    return { text, el: h("div", { class: "pattern-field" }, h("div", { class: "exclusions-tools" }, h("strong", {}, label), reset), text) };
  };
  const hidden = area("Hidden", hiddenList(), DEFAULT_HIDDEN);
  const excluded = area("Excluded (shown dimmed)", excludedList(), DEFAULT_EXCLUDED);
  const sharedBox = h("input", { type: "checkbox", checked: shared() });
  const saveButton = h("button", { type: "button", class: "primary" }, "Save");
  saveButton.onclick = () =>
    save(parseList(hidden.text.value), parseList(excluded.text.value), sharedBox.checked).then(
      () => dialog.close(),
      (e) => showError("Can't save the hidden files", e),
    );
  dialog.append(
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, "Hidden Files and Folders"),
      h(
        "p",
        { class: "muted" },
        "One pattern per line. A name, such as node_modules or *.log, matches at any depth; a path, such as public/build, matches from the project's folder. Hidden entries show only with Show Hidden Files; local history skips both lists.",
      ),
      hidden.el,
      excluded.el,
      h("div", { class: "buttons" }, h("label", { class: "shared" }, sharedBox, "Share with the project in tusk.json"), h("button", { type: "button", onclick: () => dialog.close() }, "Cancel"), saveButton),
    ),
  );
  document.body.append(dialog);
  dialog.onclose = () => dialog.remove();
  dialog.showModal();
  hidden.text.focus();
}
