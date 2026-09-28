// The widgets a resource page shows above its content, in the resource designer's Page actions tab. Filament needs a
// resource's widgets listed in its `getWidgets()` as well as in the page's `getHeaderWidgets()`, so adding one
// changes both; a page that shows all of its resource's widgets (`return OrderResource::getWidgets();`) changes the
// resource's list only.
import { editFiles, type FileBuild } from "./codeapply";
import { h, icon, iconButton } from "./dom";
import * as fapp from "./filamentapp";
import { humanize } from "./filamentcatalog";
import { shortClass } from "./filamentschema";
import { type ArrayNode, addMember, insertItem, methodNamed, moveItem, type OClass, type Outline, removeItem } from "./phpcode";

export type PageWidgetsHost = { root: string; file: string; actionsPage: string | null; facts: { class: string } | null; docs: Map<string, { text: string; outline: Outline }> };

type List = { kind: "array"; arr: ArrayNode } | { kind: "resource" } | { kind: "none" } | { kind: "code" };

/** What a method returns: an array of classes, the resource's `getWidgets()`, nothing, or other code. */
function listOf(cls: OClass | undefined, method: string): List {
  const m = cls && methodNamed(cls, method);
  if (!m) return { kind: "none" };
  const r = m.returns.length === 1 ? m.returns[0] : null;
  if (r?.kind === "array" && r.items.every((i) => i.value.kind === "classConst" || i.value.kind === "static")) return { kind: "array", arr: r };
  if (r?.kind === "static" && r.method === "getWidgets") return { kind: "resource" };
  return { kind: "code" };
}

const classesOf = (l: List) => (l.kind === "array" ? l.arr.items.map((i) => (i.value.kind === "classConst" ? i.value.class : null)) : []);
const firstClass = (o: Outline) => o.classes.find((c) => c.name);

export function renderPageWidgets(d: PageWidgetsHost): HTMLElement | null {
  const page = d.actionsPage ? d.docs.get(d.actionsPage) : undefined;
  const resource = d.docs.get(d.file);
  if (!page || !resource || !d.actionsPage) return null;
  const onPage = listOf(firstClass(page.outline), "getHeaderWidgets");
  const ofResource = listOf(firstClass(resource.outline), "getWidgets");
  const shown = onPage.kind === "resource" ? ofResource : onPage;
  const pagePath = d.actionsPage;
  if (shown.kind === "code") return h("div", { class: "pw-bar" }, icon("graph"), h("span", { class: "fd-note" }, "The page's widgets are written as code."));
  const widgets = classesOf(shown);
  const registered = classesOf(ofResource).filter((c): c is string => !!c);
  // Edits to the list the page shows: its own, or the resource's when it shows all of those.
  const shownFile = onPage.kind === "resource" ? d.file : pagePath;
  const shownMethod = onPage.kind === "resource" ? "getWidgets" : "getHeaderWidgets";
  const onShown = (f: (text: string, arr: ArrayNode) => ReturnType<FileBuild>): { path: string; build: FileBuild } => ({
    path: shownFile,
    build: (text, outline) => {
      const l = listOf(firstClass(outline), shownMethod);
      return l.kind === "array" ? f(text, l.arr) : null;
    },
  });

  const add = async (fqn: string) => {
    const files: { path: string; build: FileBuild }[] = [];
    // Registered with the resource, so Filament can show it.
    files.push({ path: d.file, build: (text, outline) => {
      const cls = firstClass(outline);
      const l = listOf(cls, "getWidgets");
      if (l.kind === "array") return classesOf(l).includes(fqn) ? null : [insertItem(text, l.arr, l.arr.items.length, `{{${fqn}}}::class`)];
      return l.kind === "none" && cls ? [addMember(text, cls, `public static function getWidgets(): array\n{\n    return [\n        {{${fqn}}}::class,\n    ];\n}`)] : null;
    } });
    if (onPage.kind !== "resource")
      files.push({ path: pagePath, build: (text, outline) => {
        const cls = firstClass(outline);
        const l = listOf(cls, "getHeaderWidgets");
        if (l.kind === "array") return [insertItem(text, l.arr, l.arr.items.length, `{{${fqn}}}::class`)];
        return l.kind === "none" && cls ? [addMember(text, cls, `protected function getHeaderWidgets(): array\n{\n    return [\n        {{${fqn}}}::class,\n    ];\n}`)] : null;
      } });
    await editFiles(files, `Added ${shortClass(fqn)} to the page`);
  };

  const chips = widgets.map((fqn, i) =>
    h(
      "span",
      { class: "pw-chip" },
      icon("graph"),
      h("button", { type: "button", class: "pw-name", title: fqn ?? "", onclick: () => fqn && void fapp.fileOfClass(d.root, fqn).then((f) => { if (f) void import("./widgetdesigner").then((m) => m.openWidget(f)); }) }, fqn ? humanize(shortClass(fqn)) : "Widget"),
      iconButton("arrow-left", "Move earlier", () => i > 0 && void editFiles([onShown((t, arr) => moveItem(t, arr, i, i - 1))], "Moved the widget")),
      iconButton("close", "Remove from the page", () => void editFiles([onShown((t, arr) => [removeItem(t, arr, i)])], "Removed the widget from the page")),
    ),
  );
  const others = registered.filter((c) => !widgets.includes(c));
  const pick = h("select", {}, h("option", { value: "", textContent: others.length ? "Add a widget…" : "Add…" }), ...others.map((c) => h("option", { value: c, textContent: humanize(shortClass(c)) })), h("option", { value: "*", textContent: "New widget…" }));
  pick.onchange = async () => {
    const v = pick.value;
    pick.value = "";
    if (v && v !== "*") return void add(v);
    if (v !== "*") return;
    // New widgets go in the resource's Widgets folder, next to its Pages folder.
    const dir = d.file.replace(/\/[^/]+$/, "/Widgets");
    const ns = firstClass(resource.outline)?.fqn.replace(/\\[^\\]+$/, "\\Widgets");
    if (!ns) return;
    const { askNewWidget } = await import("./dashboarddesigner");
    const made = await askNewWidget(pick, { dir, namespace: ns, model: d.facts?.class ?? null });
    if (made) {
      await add(made.fqn);
      void import("./widgetdesigner").then((m) => m.openWidget(made.path));
    }
  };
  return h("div", { class: "pw-bar" }, h("span", { class: "fd-note" }, "Widgets"), ...chips, pick, onPage.kind === "resource" ? h("span", { class: "fd-note", title: "The page returns its resource's getWidgets()" }, "(all of the resource's)") : null);
}
