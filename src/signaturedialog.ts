// The Change Signature dialog, laid out as PhpStorm's: visibility, name, and return type, a table of parameters
// to edit, add, remove, and reorder, and the new signature as you type. ⌥↑ and ⌥↓ move the focused parameter,
// ⌘N adds one, ⏎ refactors, and Escape cancels.
import { h, icon, iconButton } from "./dom";
import { monaco } from "./editor";
import { signatureProblem, signatureText, signatureWarning, type Param, type Signature } from "./refactorparse";

type Kind = "method" | "function" | "constructor";
/** `heading` names the refactoring; `focus` is the row whose name gets the focus, such as a parameter just added. */
type Options = { title: string; kind: Kind; signature: Signature; heading?: string; focus?: number };
const VISIBILITY = ["public", "protected", "private"];

/** Opens the dialog. Resolves with the new signature and whether to preview first, or null when cancelled. */
export function editSignature({ title, kind, signature, heading = "Change Signature", focus }: Options): Promise<{ signature: Signature; preview: boolean } | null> {
  document.getElementById("signature")?.remove();
  // Parameters read from the declaration are existing ones; one it's given without text, such as Introduce
  // Parameter's, is new.
  const s: Signature = { ...signature, params: signature.params.map((p) => ({ ...p, from: p.from ?? (p.text ? p.name : undefined) })) };
  const visibility = VISIBILITY.find((v) => s.modifiers.split(/\s+/).includes(v)) ?? "";
  const otherModifiers = () => s.modifiers.split(/\s+/).filter((m) => m && !VISIBILITY.includes(m));

  const dialog = h("dialog", { id: "signature" });
  const nameInput = h("input", { value: s.name, disabled: kind === "constructor", spellcheck: false, ariaLabel: "Name" });
  const returnInput = h("input", { value: s.returnType, spellcheck: false, placeholder: "none", ariaLabel: "Return type", disabled: kind === "constructor" });
  const visibilitySelect = h("select", { ariaLabel: "Visibility", disabled: kind === "function" });
  for (const v of kind === "function" ? [""] : VISIBILITY) visibilitySelect.append(new Option(v || "—", v, false, v === visibility));
  const rows = h("tbody");
  const preview = h("code", { class: "signature-preview" });
  // The signature colored as the editor colors PHP. Colorizing is asynchronous, so only the latest one shows.
  let colorized = 0;
  const showSignature = async (text: string) => {
    const current = ++colorized;
    preview.textContent = text;
    const html = await monaco.editor.colorize(`<?php ${text}`, "php", {}).catch(() => null);
    if (current !== colorized || !html) return;
    const box = document.createElement("div");
    box.innerHTML = html;
    // Drop the `<?php ` that only switched the colorizer into PHP.
    let skip = 6;
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && skip > 0; node = walker.nextNode()) {
      const cut = Math.min(skip, node.textContent!.length);
      node.textContent = node.textContent!.slice(cut);
      skip -= cut;
    }
    box.querySelectorAll("br").forEach((br) => br.remove());
    preview.replaceChildren(...box.childNodes);
  };
  const problem = h("p", { class: "signature-problem", role: "alert" });
  const previewButton = h("button", { type: "button", textContent: "Preview" });
  const refactorButton = h("button", { type: "button", class: "primary", textContent: "Refactor" });
  let focusedRow = -1;

  const update = () => {
    s.name = nameInput.value.trim();
    s.returnType = returnInput.value.trim();
    s.modifiers = [visibilitySelect.value, ...otherModifiers()].filter(Boolean).join(" ");
    showSignature(signatureText(s));
    const why = signatureProblem(s, signature, kind);
    problem.textContent = why ?? signatureWarning(s) ?? "";
    problem.classList.toggle("warning", !why);
    previewButton.disabled = refactorButton.disabled = !!why;
  };

  const cell = (p: Param, key: "type" | "name" | "defaultValue" | "callValue", placeholder: string, disabled = false) => {
    const input = h("input", { value: (p[key] as string | undefined) ?? "", placeholder, spellcheck: false, disabled, ariaLabel: placeholder });
    input.oninput = () => {
      const value = input.value.trim();
      if (key === "name") p.name = value.replace(/^\$/, "");
      else if (key === "type") p.type = value;
      else p[key] = value || undefined;
      update();
    };
    // The name's `$` sits in the cell, so it reads as a variable without being typed.
    return h("td", { class: key === "name" ? "name-cell" : "" }, key === "name" ? h("span", { class: "sigil" }, "$") : null, input);
  };

  const render = (focus?: { row: number; column: number }) => {
    rows.replaceChildren(
      ...s.params.map((p, i) => {
        const move = (by: number) => {
          [s.params[i], s.params[i + by]] = [s.params[i + by], s.params[i]];
          render({ row: i + by, column: 1 });
          update();
        };
        const up = iconButton("arrow-up", "Move Up (⌥↑)", () => move(-1));
        const down = iconButton("arrow-down", "Move Down (⌥↓)", () => move(1));
        const remove = iconButton("trash", "Remove", () => {
          s.params.splice(i, 1);
          render({ row: Math.min(i, s.params.length - 1), column: 1 });
          update();
        });
        up.disabled = i === 0;
        down.disabled = i === s.params.length - 1;
        const tr = h(
          "tr",
          { class: p.from ? "" : "added" },
          cell(p, "type", "Type"),
          cell(p, "name", "Name"),
          cell(p, "defaultValue", "Default value"),
          p.from ? h("td", { class: "not-applicable", title: "Existing calls already pass this parameter" }, "—") : cell(p, "callValue", "Value in calls"),
          h("td", { class: "row-actions" }, up, down, remove),
        );
        tr.addEventListener("focusin", () => {
          focusedRow = i;
          rows.querySelectorAll("tr.focused").forEach((r) => r.classList.remove("focused"));
          tr.classList.add("focused");
        });
        tr.onkeydown = (e) => {
          if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            const by = e.key === "ArrowUp" ? -1 : 1;
            if (i + by >= 0 && i + by < s.params.length) move(by);
            e.preventDefault();
          }
        };
        return tr;
      }),
    );
    if (focus && focus.row >= 0) rows.children[focus.row]?.querySelectorAll("input")[focus.column]?.focus();
  };

  const add = () => {
    const at = focusedRow >= 0 ? focusedRow + 1 : s.params.length;
    s.params.splice(at, 0, { text: "", type: "", name: "", byRef: false, variadic: false });
    render({ row: at, column: 1 });
    update();
  };

  dialog.append(
    h(
      "form",
      { method: "dialog" },
      h("h2", {}, `${heading} `, h("span", { class: "muted" }, title)),
      h(
        "div",
        { class: "signature-head" },
        h("label", {}, "Visibility", visibilitySelect),
        h("label", { class: "grow" }, "Name", nameInput),
        h("label", {}, "Return type", returnInput),
      ),
      h(
        "div",
        { class: "signature-params" },
        h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Type"), h("th", {}, "Name"), h("th", {}, "Default value"), h("th", {}, "Value in existing calls"), h("th"))), rows),
      ),
      h("div", { class: "signature-tools" }, h("button", { type: "button", onclick: add }, icon("add"), "Add Parameter"), h("span", { class: "muted" }, "⌘N adds a parameter · ⌥↑ ⌥↓ move the focused one")),
      preview,
      problem,
      h("div", { class: "buttons" }, h("button", { type: "button", textContent: "Cancel", onclick: () => dialog.close() }), previewButton, refactorButton),
    ),
  );
  for (const input of [nameInput, returnInput]) input.oninput = update;
  visibilitySelect.onchange = update;
  render();
  update();
  document.body.append(dialog);

  return new Promise((resolve) => {
    let result: { signature: Signature; preview: boolean } | null = null;
    const finish = (preview: boolean) => {
      update();
      if (refactorButton.disabled) return;
      result = { signature: { ...s, params: s.params.map((p) => ({ ...p })) }, preview };
      dialog.close();
    };
    previewButton.onclick = () => finish(true);
    refactorButton.onclick = () => finish(false);
    dialog.onkeydown = (e) => {
      if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) (e.preventDefault(), finish(false));
      else if (e.metaKey && e.key.toLowerCase() === "n") (e.preventDefault(), add());
    };
    dialog.onclose = () => {
      dialog.remove();
      resolve(result);
    };
    dialog.showModal();
    const start = focus !== undefined ? rows.children[focus]?.querySelectorAll("input")[1] : s.params.length ? rows.querySelector("input") : nameInput;
    start?.focus();
    if (focus !== undefined) start?.select();
  });
}
