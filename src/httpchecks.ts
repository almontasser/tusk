// Less typing in the HTTP tab: checks you set up without code, which become client.test() calls in the response
// handler, and saving a value from a JSON response as a variable for later requests.
import type { monaco } from "./editor";
import { globals, host, setGlobals } from "./httpclient";
import { type Check, type CheckKind, CHECKS, CHECKS_END, CHECKS_START, jsonPathAt, jsonQuery, nameForPath, readChecks, writeChecks } from "./httpfile";
import { currentRequest, h, iconButton, renderReqTab, update } from "./httpview";
import { pick } from "./palette";

/**
 * The Checks section of the Scripts tab, which reads and writes the checks in the response handler's editor, so
 * its edits go to the file the same way as typing does. Null `editor` means the handler is a file.
 */
export function checksSection(editor: monaco.editor.IStandaloneCodeEditor | null) {
  const el = h("div", { class: "http-script http-checks" });
  const bar = h("div", { class: "http-script-bar" }, h("span", { class: "http-script-title" }, "Checks"));
  if (!editor) return el.append(bar, h("p", { class: "http-hint" }, "The response handler is a file. Add checks to it in code.")), el;
  let checks: Check[] = [];
  const write = () => {
    const model = editor.getModel();
    if (model) editor.executeEdits("checks", [{ range: model.getFullModelRange(), text: writeChecks(model.getValue(), checks) }]);
  };
  const row = (c: Check, i: number) => {
    const kind = h("select", {}, ...Object.entries(CHECKS).map(([id, k]) => h("option", { value: id, textContent: k.label })));
    kind.value = c.kind;
    const k = CHECKS[c.kind];
    const target = h("input", { value: c.target, placeholder: k.target ?? "", spellcheck: false, class: k.target ? "" : "unused" });
    const expected = h("input", { value: c.expected, placeholder: k.expected ?? "", spellcheck: false, class: k.expected ? "" : "unused" });
    kind.onchange = () => {
      const next = CHECKS[kind.value as CheckKind];
      Object.assign(c, { kind: kind.value, target: next.target ? c.target || next.target : "", expected: next.expected ? c.expected || next.expected : "" });
      write();
      draw();
    };
    target.oninput = () => ((c.target = target.value), write());
    expected.oninput = () => ((c.expected = expected.value), write());
    return h("div", { class: "http-row http-check-row" }, kind, target, expected, iconButton("close", "Remove", () => (checks.splice(i, 1), write(), draw())));
  };
  const add = h("button", { class: "link http-add", textContent: "+ Add check", onclick: () => (checks.push({ kind: "status", target: "", expected: "200" }), write(), draw()) });
  const draw = () => {
    const read = readChecks(editor.getValue());
    checks = read.checks;
    if (!read.editable) return el.replaceChildren(bar, h("p", { class: "http-hint" }, `The code between ${CHECKS_START} and ${CHECKS_END} was changed by hand, so edit these checks in the code below.`));
    el.replaceChildren(bar, h("div", { class: "http-rows" }, ...checks.map(row), add));
  };
  // Typing in the handler's code shows here too, except while you edit a check.
  editor.onDidChangeModelContent(() => !el.contains(document.activeElement) && draw());
  draw();
  return el;
}

/** Adds Save as Variable… to the response body's context menu. `filter` is the JSON path filter the body shows. */
export function addSaveAsVariable(editor: monaco.editor.IStandaloneCodeEditor, body: unknown, filter: () => string) {
  editor.addAction({
    id: "phpEditor.httpSaveAsVariable",
    label: "Save as Variable…",
    contextMenuGroupId: "navigation",
    contextMenuOrder: 0,
    run: (ed) => {
      const model = ed.getModel();
      const position = ed.getPosition();
      if (!model || !position) return;
      const at = jsonPathAt(model.getValue(), model.getOffsetAt(position));
      if (!at) return host.status("Put the cursor on a value in the JSON to save it.");
      const f = filter();
      const filtered = f && f !== "$";
      if (filtered && /\*|\.\./.test(f)) return host.status("Clear the filter, or filter to one value, to save a value from it.");
      saveAsVariable(filtered ? f + at.slice(1) : at, body);
    },
  });
}

/** Asks for a name, then saves the value at `path` from each response to the request with client.global.set. */
function saveAsVariable(path: string, body: unknown) {
  const r = currentRequest();
  if (!r) return host.status("Open the request in the HTTP tab to save a value from its response.");
  const code = (name: string) => `client.global.set(${JSON.stringify(name)}, jsonPath(response.body, ${JSON.stringify(path)}));`;
  if (r.handler?.file) return host.status(`The response handler is a file, ${r.handler.file}. Add this to it: ${code("name")}`);
  const suggested = nameForPath(path);
  pick(
    `Save ${path} as a variable`,
    (q) => {
      const name = q.trim();
      const valid = /^[\w.-]+$/.test(name);
      return [{ label: valid ? `Save as {{${name}}}` : "Type a name: letters, digits, _, ., and -", detail: path, run: () => valid && save(name) }];
    },
    0,
    { value: suggested, select: [0, suggested.length] },
  );
  const save = (name: string) => {
    update((q) => (q.handler = { code: q.handler?.code?.trim() ? `${q.handler.code.trimEnd()}\n${code(name)}` : code(name) }));
    // Set it now from the response on screen, so the next request can use it before this one runs again.
    const value = jsonQuery(body, path)[0];
    if (value !== undefined) setGlobals({ ...globals(), [name]: typeof value === "string" ? value : JSON.stringify(value) });
    renderReqTab();
    host.status(`Saved ${name} from ${path}. Later requests use {{${name}}}.`);
  };
}
