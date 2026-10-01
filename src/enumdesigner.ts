// The enum designer: an editor tab for a PHP enum's cases and Filament's label, color, icon, and description
// contracts, which selects, badges, and filters show. A new enum is written whole; an existing one is changed in
// place (src/enumgen.ts), keeping what the designer can't read. Changes are staged, with the file's code previewed.
import { invoke } from "@tauri-apps/api/core";
import type * as L from "vscode-languageserver-protocol";
import { h, icon, iconButton, redraw } from "./dom";
import { monaco } from "./editor";
import { type Attr, caseLabel, caseName, caseValue, CONTRACTS, type DesignedCase, enumEdits, enumFile, type EnumSpec, readEnum, type ReadEnum } from "./enumgen";
import * as fapp from "./filamentapp";
import { COLORS } from "./filamentcatalog";
import { host as designerHost } from "./filamentdesigner";
import { COLOR_SWATCH, commitInput, heroicon, pickHeroicon, segmented, toggleSwitch } from "./filamentpickers";
import { applyWorkspaceEdit } from "./lsp";
import { applyEdits, type Edit, mergeEdits, type Outline } from "./phpcode";
import { errorText, showError } from "./status";
import { closeView, showEditorView } from "./terminal";
import { renameTranslation, writeTranslation } from "./translationfiles";
import { isRtl, ownTranslation, type Translations } from "./translations";

const open = new Map<string, EnumDesigner>();

/** Opens the designer for an enum's file. */
export function openEnumDesigner(file: string) {
  let d = open.get(file);
  if (!d) open.set(file, (d = new EnumDesigner(file)));
  d.show();
}

/** Opens the designer for a new enum; `then` gets its class once it's created, as the options editor uses it. */
export function openNewEnum(o: { name?: string; options?: [value: string, label: string][]; then?: (cls: string) => void } = {}) {
  new EnumDesigner(null, o).show();
}

const LABELS: Record<Attr, string> = { label: "Labels", color: "Colors", icon: "Icons", description: "Descriptions" };

class EnumDesigner {
  file: string | null;
  el = h("div", { class: "md-designer ed-designer" });
  spec: EnumSpec | null = null;
  cases: DesignedCase[] = [];
  read: ReadEnum | null = null;
  text = "";
  outline: Outline | null = null;
  heroicons: string[] = [];
  iconsDir: string | null = null;
  error = "";
  busy = "";
  /** The app's translations, and the ones typed here, written on Apply: by locale, then key. */
  translations: Translations | null = null;
  pending = new Map<string, Map<string, string>>();
  preview: monaco.editor.IStandaloneCodeEditor | null = null;
  previewHost = h("div", { class: "md-preview-editor" });
  private o: { name?: string; options?: [value: string, label: string][]; then?: (cls: string) => void };

  constructor(file: string | null, o: { name?: string; options?: [value: string, label: string][]; then?: (cls: string) => void } = {}) {
    this.file = file;
    this.o = o;
  }

  get root() {
    return designerHost.root();
  }

  show() {
    const title = this.file ? `${this.file.split("/").pop()!.replace(/\.php$/, "")} · Enum` : "New Enum";
    showEditorView(title, this.el, "symbol-enum", () => {
      this.preview?.dispose();
      this.preview = null;
      if (this.file) open.delete(this.file);
    });
    if (!this.spec) void this.load();
  }

  async load() {
    redraw(this.el, h("div", { class: "fd-loading" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), "Reading the enum…"));
    try {
      const cat = (await fapp.hasFilament(this.root)) ? await fapp.catalog(this.root).catch(() => null) : null;
      this.heroicons = cat?.heroicons ?? [];
      this.iconsDir = cat?.heroiconsDir ?? null;
      this.translations = await fapp.translations(this.root).catch(() => null);
      this.pending.clear();
      if (this.file) {
        this.text = await invoke<string>("read_file", { path: this.file });
        this.outline = await fapp.outlineOf(this.text, this.file);
        this.read = readEnum(this.text, this.outline);
        if (!this.read) throw new Error("There's no enum in this file.");
        this.spec = structuredClone(this.read.spec);
        this.cases = this.spec.cases.map((c) => ({ ...c, original: c.name }));
      } else {
        const options = this.o.options ?? [];
        this.spec = { name: this.o.name ?? "", namespace: "App\\Enums", backing: "string", contracts: cat ? ["label", "color"] : [], translated: false, cases: [] };
        // Numeric keys, as a list of options has, make a number-backed enum.
        if (options.length && options.every(([v]) => /^\d+$/.test(v))) this.spec.backing = "int";
        this.cases = options.map(([v, label], i) => {
          const name = [v, label].map((x) => (/^\d/.test(x) ? "" : caseName(x))).find((x) => /^[A-Z]\w*$/.test(x)) ?? `Case${i + 1}`;
          return { name, value: v, label: label || caseLabel(name) };
        });
      }
      this.error = "";
    } catch (e) {
      this.error = errorText(e);
    }
    this.render();
  }

  // ---- Rendering ----

  render() {
    if (this.error) {
      redraw(this.el, h("div", { class: "fd-error" }, icon("warning"), h("div", {}, h("strong", {}, "The enum designer can't read this enum"), h("p", {}, this.error), h("div", { class: "fd-error-actions" }, h("button", { type: "button", onclick: () => void this.load() }, icon("refresh"), "Try again")))));
      return;
    }
    const s = this.spec!;
    redraw(this.el, 
      h(
        "header",
        { class: "fd-header" },
        h("span", { class: "fd-header-icon" }, icon("symbol-enum")),
        h(
          "div",
          { class: "fd-header-titles" },
          h("h1", {}, this.file ? s.name : s.name ? `New enum: ${s.name}` : "New enum"),
          h("div", { class: "fd-header-chips" }, h("span", { class: "fd-chip-static" }, s.backing ? `${s.backing}-backed` : "Pure enum"), this.file ? h("button", { type: "button", class: "fd-chip-link", onclick: () => designerHost.openAt(this.file!, 1) }, icon("go-to-file"), "Open the code") : null),
        ),
      ),
      h("div", { class: "md-body" }, h("div", { class: "md-main" }, this.settingsCard(), this.casesCard(), this.translationsCard()), h("aside", { class: "md-preview" }, h("nav", { class: "fd-tabs-nav md-preview-tabs" }, h("button", { type: "button", class: "active" }, "Code")), this.previewHost)),
      this.footer(),
    );
    requestAnimationFrame(() => this.mountPreview());
  }

  /** For translated labels and descriptions: each case's text in each of the app's languages. */
  private translationsCard(): HTMLElement | null {
    const s = this.spec!;
    const t = this.translations;
    const attrs = (["label", "description"] as Attr[]).filter((a) => s.contracts.includes(a));
    if (!s.translated || !t || !attrs.length || !this.cases.length) return null;
    const locales = t.locales;
    const table = h("div", { class: "ed-cases", style: `--grid:minmax(120px, 1fr) ${locales.map(() => "minmax(120px, 1fr)").join(" ")}` });
    table.append(h("div", { class: "ed-row ed-head" }, h("span", {}, "Text"), ...locales.map((l) => h("span", {}, l))));
    for (const c of this.cases)
      for (const a of attrs) {
        const key = a === "label" ? (c.label || caseLabel(c.name)) : c.description;
        if (!key) continue;
        table.append(
          h(
            "div",
            { class: "ed-row" },
            h("span", { class: "ed-tr-key", title: `${c.name}'s ${a}` }, key),
            ...locales.map((l) => {
              const own = ownTranslation(t, l, key);
              const input = commitInput(this.pending.get(l)?.get(key) ?? own ?? "", (v) => {
                if (!this.pending.has(l)) this.pending.set(l, new Map());
                this.pending.get(l)!.set(key, v);
                this.updatePreview();
              }, { placeholder: "Not translated" }) as HTMLInputElement;
              if (isRtl(l)) input.dir = "rtl";
              return input;
            }),
          ),
        );
      }
    return h("section", { class: "fd-settings-section" }, h("h3", {}, icon("globe"), "Translations"), table, h("p", { class: "fd-note ed-note" }, "Written to the app's lang files when you apply, with the enum."));
  }

  /** Writes the translations: renamed texts take theirs along, then the ones typed here. */
  private async writeTranslations() {
    const t = this.translations;
    if (!t) return;
    const before = this.read?.spec;
    if (before?.translated && this.spec!.translated)
      for (const c of this.cases) {
        const old = before.cases.find((k) => k.name === c.original);
        if (!old) continue;
        if (old.label && c.label && old.label !== c.label) await renameTranslation(t, old.label, c.label);
        if (old.description && c.description && old.description !== c.description) await renameTranslation(t, old.description, c.description);
      }
    for (const [locale, values] of this.pending)
      for (const [key, value] of values) if (value !== (ownTranslation(t, locale, key) ?? "")) await writeTranslation(t, locale, key, value);
    this.pending.clear();
  }

  private row(label: string, editor: HTMLElement, help?: string) {
    return h("div", { class: "fd-row", title: help ?? "" }, h("span", { class: "fd-row-label" }, label), h("div", { class: "fd-row-editor" }, editor), h("span", { class: "fd-row-spacer" }));
  }

  private settingsCard() {
    const s = this.spec!;
    const rows: HTMLElement[] = [];
    if (!this.file) {
      const name = commitInput(s.name, (v) => ((s.name = caseName(v)), this.render()), { placeholder: "OrderStatus", className: "fd-mono" });
      name.addEventListener("input", () => ((s.name = caseName((name as HTMLInputElement).value)), this.updatePreview()));
      rows.push(this.row("Name", name, "A class name, such as OrderStatus."));
      rows.push(this.row("Namespace", commitInput(s.namespace, (v) => ((s.namespace = v.trim().replace(/^\\|\\$/g, "")), this.updatePreview()), { className: "fd-mono" })));
      rows.push(this.row("Values", segmented<"string" | "int" | "none">([["string", "Strings"], ["int", "Numbers"], ["none", "None"]], s.backing ?? "none", (v) => ((s.backing = v === "none" ? null : v), this.render())), "What the database stores for each case."));
    }
    const features = h(
      "div",
      { class: "fd-checks wrap" },
      ...CONTRACTS.map((c) => {
        const box = h("input", { type: "checkbox", checked: s.contracts.includes(c.attr), disabled: c.attr === "icon" && !this.heroicons.length });
        box.onchange = () => ((s.contracts = CONTRACTS.filter((x) => (x.attr === c.attr ? box.checked : s.contracts.includes(x.attr))).map((x) => x.attr)), this.render());
        return h("label", { title: `${c.contract}: ${c.method}()` }, box, LABELS[c.attr]);
      }),
    );
    rows.push(this.row("Filament shows", features, "Selects, badges, and filters show the labels, colors, and icons of an enum's cases."));
    if (s.contracts.includes("label") || s.contracts.includes("description")) rows.push(this.row("Translated", toggleSwitch(s.translated, (on) => ((s.translated = on), this.render())), "Labels and descriptions go through __(), so lang files can translate them."));
    return h("section", { class: "fd-settings-section" }, h("h3", {}, icon("symbol-enum"), "Enum"), h("div", { class: "fd-rows md-rows" }, ...rows));
  }

  private casesCard() {
    const s = this.spec!;
    const attrs = CONTRACTS.filter((c) => s.contracts.includes(c.attr)).map((c) => c.attr);
    const readable = (a: Attr) => !this.read || this.read.readable[a] || !this.read.present[a];
    const grid = `14px minmax(110px, 1fr) ${s.backing ? "minmax(90px, 0.9fr) " : ""}${attrs.map((a) => (a === "color" ? "150px" : a === "icon" ? "140px" : "minmax(110px, 1fr)")).join(" ")} 24px`;
    const table = h("div", { class: "ed-cases", style: `--grid:${grid}` });
    table.append(
      h(
        "div",
        { class: "ed-row ed-head" },
        h("span", {}),
        h("span", {}, "Case"),
        s.backing ? h("span", {}, "Value") : null,
        ...attrs.map((a) => h("span", { title: readable(a) ? "" : "Written as code the designer keeps" }, LABELS[a].replace(/s$/, ""), readable(a) ? null : icon("lock"))),
        h("span", {}),
      ),
    );
    this.cases.forEach((c, i) => table.append(this.caseRow(c, i, attrs, readable)));
    const quick = commitInput("", (v) => {
      for (const value of v.split(",").map((x) => x.trim()).filter(Boolean)) {
        const name = caseName(value);
        if (this.cases.some((k) => k.name === name)) continue;
        this.cases.push({ name, value: s.backing === "int" ? String(this.cases.length + 1) : caseValue(name), label: caseLabel(name) });
      }
      this.render();
    }, { placeholder: "Add several: draft, published, archived", className: "ed-quick" });
    return h(
      "section",
      { class: "fd-settings-section" },
      h("h3", {}, icon("list-ordered"), "Cases", h("span", { class: "fd-spacer" }), h("button", { type: "button", class: "md-add", onclick: () => this.addCase() }, icon("add"), "Add case")),
      table,
      h("div", { class: "ed-quick-row" }, quick),
      this.read && CONTRACTS.some((c) => this.read!.present[c.attr] && !this.read!.readable[c.attr]) ? h("p", { class: "fd-note ed-note" }, icon("lock"), " Columns with a lock are written as code the designer keeps, such as getIcon() here. Renamed cases are renamed there too.") : null,
    );
  }

  addCase() {
    const n = this.cases.length + 1;
    const name = `Case${n}`;
    this.cases.push({ name, value: this.spec!.backing === "int" ? String(n) : caseValue(name), label: caseLabel(name) });
    this.render();
    const inputs = this.el.querySelectorAll<HTMLInputElement>(".ed-name");
    inputs[inputs.length - 1]?.select();
  }

  private caseRow(c: DesignedCase, i: number, attrs: Attr[], readable: (a: Attr) => boolean) {
    const s = this.spec!;
    const name = h("input", { class: "ed-name fd-mono", value: c.name, spellcheck: false });
    name.oninput = () => {
      const autoValue = !c.original && c.value === caseValue(c.name);
      const autoLabel = c.label === caseLabel(c.name);
      c.name = caseName(name.value);
      if (autoValue && s.backing === "string") c.value = caseValue(c.name);
      if (autoLabel) c.label = caseLabel(c.name);
      this.updatePreview();
    };
    name.onchange = () => this.render();
    name.onkeydown = (e) => e.key === "Enter" && (e.preventDefault(), this.addCase());
    const cells: HTMLElement[] = [];
    for (const a of attrs) {
      if (!readable(a)) {
        cells.push(h("span", { class: "fd-faint ed-locked" }, "In code"));
        continue;
      }
      if (a === "color") {
        const select = h("select", {}, h("option", { value: "", textContent: "None" }), ...COLORS.map((col) => h("option", { value: col, textContent: col, selected: c.color === col })));
        if (c.color && !COLORS.includes(c.color)) select.append(h("option", { value: c.color, textContent: c.color, selected: true }));
        select.onchange = () => ((c.color = select.value || undefined), this.render());
        cells.push(h("div", { class: "ed-color" }, h("span", { class: "fd-color", style: `--swatch:${COLOR_SWATCH[c.color ?? ""] ?? "transparent"}` }), select));
      } else if (a === "icon") {
        const btn = h("button", { type: "button", class: "fd-icon-button" }, heroicon(this.iconsDir, c.icon ?? null), h("span", {}, c.icon ? c.icon.replace(/^Outlined/, "") : "None"));
        btn.onclick = async () => {
          const picked = await pickHeroicon(btn, { dir: this.iconsDir, cases: this.heroicons, current: c.icon ?? null });
          if (picked === null) return;
          c.icon = picked || undefined;
          this.render();
        };
        cells.push(btn);
      } else cells.push(commitInput(c[a] ?? "", (v) => ((c[a] = v || undefined), this.render()), { placeholder: a === "label" ? caseLabel(c.name) : "" }));
    }
    const row = h(
      "div",
      { class: `ed-row${c.original ? "" : " new"}${c.original && c.original !== c.name ? " renamed" : ""}`, draggable: true, title: c.original && c.original !== c.name ? `Renamed from ${c.original}` : "" },
      h("span", { class: "md-grip codicon codicon-gripper" }),
      name,
      s.backing ? commitInput(c.value, (v) => ((c.value = v), this.updatePreview()), { className: "fd-mono", type: s.backing === "int" ? "number" : "text" }) : null,
      ...cells,
      iconButton("trash", "Remove the case", () => (this.cases.splice(i, 1), this.render())),
    );
    row.ondragstart = (e) => e.dataTransfer!.setData("text/plain", String(i));
    row.ondragover = (e) => e.preventDefault();
    row.ondrop = (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer!.getData("text/plain"));
      if (Number.isNaN(from) || from === i) return;
      const [moved] = this.cases.splice(from, 1);
      this.cases.splice(i, 0, moved);
      this.render();
    };
    return row;
  }

  private footer() {
    const apply = h("button", { type: "button", class: "primary md-apply", onclick: () => void this.apply() }, icon(this.file ? "check" : "add"), this.file ? "Apply changes" : "Create enum");
    return h("footer", { class: "md-footer" }, h("span", { class: "md-problems" }), h("span", { class: "fd-spacer" }), this.busy ? h("span", { class: "md-busy" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), this.busy) : null, apply);
  }

  private mountPreview() {
    if (!this.previewHost.isConnected) return;
    this.preview ??= monaco.editor.create(this.previewHost, { language: "php", readOnly: true, minimap: { enabled: false }, lineNumbers: "off", scrollBeyondLastLine: false, fontSize: 12, automaticLayout: true, renderLineHighlight: "none", folding: false, padding: { top: 10 } });
    this.updatePreview();
  }

  private problems(): string[] {
    const s = this.spec!;
    const out: string[] = [];
    if (!/^[A-Z]\w*$/.test(s.name)) out.push("Give the enum a class name, such as OrderStatus.");
    if (!this.cases.length) out.push("Add at least one case.");
    const names = this.cases.map((c) => c.name);
    const dupName = names.find((n, i) => names.indexOf(n) !== i);
    if (dupName) out.push(`Two cases are named ${dupName}.`);
    if (s.backing) {
      const values = this.cases.map((c) => c.value);
      const dupValue = values.find((v, i) => values.indexOf(v) !== i);
      if (dupValue !== undefined) out.push(`Two cases have the value ${dupValue}.`);
      if (values.some((v) => v === "")) out.push("Every case needs a value.");
    }
    return out;
  }

  /** Methods written as code that new cases would be missing from, which throw for them unless they have a default. */
  private uncovered(): { method: string; line: number; cases: string[] }[] {
    if (!this.read) return [];
    const added = this.cases.filter((c) => !c.original).map((c) => c.name);
    if (!added.length) return [];
    return CONTRACTS.flatMap((c) => {
      const m = this.read!.cls.methods.find((x) => x.name === c.method);
      if (!m || this.read!.readable[c.attr] || !this.spec!.contracts.includes(c.attr) || /\bdefault\s*=>/.test(this.text.slice(m.span[0], m.span[1]))) return [];
      return [{ method: c.method, line: this.text.slice(0, m.span[0]).split("\n").length, cases: added }];
    });
  }

  /** The file's code after Apply, and the edits for an existing enum. */
  private result(): { code: string; edits: Edit[] | null } {
    const s = this.spec!;
    const heroicon = this.heroicons.length > 0;
    if (!this.file) return { code: enumFile({ ...s, cases: this.cases }, { heroicon }), edits: null };
    const edits = mergeEdits(enumEdits(this.text, this.outline!, this.read!, { cases: this.cases, contracts: s.contracts, translated: s.translated }, { heroicon }));
    return { code: applyEdits(this.text, edits), edits };
  }

  private updatePreview() {
    if (!this.spec || !this.preview) return;
    let code: string;
    try {
      code = this.result().code;
    } catch (e) {
      code = `<?php\n\n// ${errorText(e)}\n`;
    }
    if (this.preview.getValue() !== code) this.preview.setValue(code);
    const problems = this.problems();
    const apply = this.el.querySelector<HTMLButtonElement>(".md-apply");
    if (apply) (apply.disabled = !!problems.length || !!this.busy), (apply.title = problems.join("\n"));
    const note = this.el.querySelector(".md-problems");
    const gap = this.uncovered()[0];
    if (note) note.textContent = problems[0] ?? (gap ? `${gap.method}() is code the designer keeps: add ${gap.cases.join(", ")} to it after applying, or it throws for ${gap.cases.length > 1 ? "them" : "it"}.` : "");
  }

  async apply() {
    if (this.problems().length) return;
    const s = this.spec!;
    try {
      const { code, edits } = this.result();
      const gap = this.uncovered()[0];
      if (!this.file) {
        const path = `${this.root}/${s.namespace.replace(/^App\\?/, "app/").replace(/\\/g, "/").replace(/\/$/, "")}/${s.name}.php`.replace("//", "/");
        if (await invoke<boolean>("path_exists", { path })) throw new Error(`${path.slice(this.root.length + 1)} already exists.`);
        await invoke("create_file", { path, contents: code });
        await this.writeTranslations();
        fapp.forget(["enums"]);
        designerHost.status(`Created ${s.name}.`);
        closeView(this.el);
        designerHost.openAt(path, 1);
        this.o.then?.(`${s.namespace}\\${s.name}`);
        return;
      }
      const model = await designerHost.ensureModel(this.file);
      if (model.getValue() !== this.text) throw new Error("The file changed since the designer read it. Reopen it to see the changes.");
      const pos = (o: number) => {
        const p = model.getPositionAt(o);
        return { line: p.lineNumber - 1, character: p.column - 1 };
      };
      await applyWorkspaceEdit({ changes: { [model.uri.toString()]: (edits ?? []).map((e): L.TextEdit => ({ range: { start: pos(e.start), end: pos(e.end) }, newText: e.text })) } });
      await this.writeTranslations();
      fapp.forget(["enums"]);
      designerHost.status(`Applied the changes to ${s.name}.`);
      await this.load();
      // The code that needs the new cases, opened where they go.
      if (gap) designerHost.openAt(this.file, gap.line);
    } catch (e) {
      showError("Can't write the enum", e);
    }
  }
}
