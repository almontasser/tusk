// New Laravel Element…: every `make:*` command the project's Artisan has (Laravel's, Filament's, Livewire's, and any
// package's), each with a form built from the arguments and options Artisan describes in `list --format=json`. So a
// package's generator works without Tusk knowing it. The model and Filament resource generators point to their
// designers, which do more.
import { h, icon } from "./dom";
import * as fapp from "./filamentapp";
import { commitInput } from "./filamentpickers";
import { pick, rank, type Item } from "./palette";
import { shellQuote } from "./runconfig";
import { COMMON, commandLine, type Command, generatorLabel, type Values } from "./laravelnewdata";
import { errorText, showError } from "./status";

type Host = { root(): string; openAt(path: string, line: number): void; status(text: string): void };
let host: Host;
export const initLaravelElements = (h_: Host) => (host = h_);

let cache: { root: string; commands: Command[] } | undefined;

/** The project's Artisan commands, from `artisan list --format=json`, without hidden ones. */
export async function artisanCommands(root: string): Promise<Command[]> {
  if (cache?.root === root) return cache.commands;
  const out = await fapp.artisan(root, ["list", "--format=json"]);
  const json = JSON.parse(out.slice(out.indexOf("{"))) as { commands: Command[] };
  const commands = json.commands.filter((c) => !c.hidden);
  cache = { root, commands };
  return commands;
}

/** The project's generators. */
const generators = async (root: string) => (await artisanCommands(root)).filter((c) => c.name.startsWith("make:"));

/** Forgets the generators, as after `composer require` adds a package's. */
export const forgetGenerators = () => (cache = undefined);

/** Lists the project's generators; choosing one opens its form. */
export async function newLaravelElement() {
  const root = host.root();
  let commands: Command[];
  try {
    commands = await generators(root);
  } catch (e) {
    return showError("Can't list Artisan's generators", e);
  }
  const special: Record<string, () => void> = {
    "make:model": () => void import("./modeldesigner").then((m) => m.openNewModel()),
    "make:enum": () => void import("./enumdesigner").then((m) => m.openNewEnum()),
    "make:filament-resource": () => void import("./filamentwizard").then((m) => m.openResourceWizard({ onCreated() {} })),
  };
  const items: Item[] = commands.map((c) => ({
    label: generatorLabel(c.name),
    detail: `${c.name} · ${c.description}`,
    icon: `codicon-${special[c.name] ? "wand" : c.name.includes("filament") ? "symbol-structure" : c.name.includes("livewire") ? "zap" : "new-file"}`,
    run: () => (special[c.name] ? special[c.name]() : openForm(c)),
  }));
  // The model and resource generators have designers; their plain forms stay a click away.
  for (const name of Object.keys(special)) {
    const c = commands.find((x) => x.name === name);
    if (c) items.push({ label: `${generatorLabel(name)} (Artisan form)`, detail: `${name} · ${c.description}`, icon: "codicon-new-file", run: () => openForm(c) });
  }
  pick("New Laravel element: pick a generator", (query) => (query.trim() ? rank(query, items) : items));
}

/** The form for one generator, in a dialog. */
export function openForm(c: Command) {
  document.querySelector(".ne-dialog")?.remove();
  const values: Values = { args: {}, flags: new Set(), options: {} };
  const dialog = h("dialog", { class: "rw-dialog ne-dialog", ariaLabel: c.name });
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  const preview = h("code", { class: "ne-preview" });
  const run = h("button", { type: "button", class: "primary" }, icon("play"), "Create");
  const problem = h("p", { class: "rw-warn ne-problem" });
  const args = Object.values(c.definition.arguments);
  const options = Object.values(c.definition.options).filter((o) => !COMMON.has(o.name));
  const update = () => {
    preview.textContent = `php artisan ${commandLine(c, values).map(shellQuote).join(" ")}`;
    const missing = args.filter((a) => a.is_required && !(values.args[a.name] ?? "").trim());
    run.disabled = !!missing.length;
    run.title = missing.length ? `Fill in ${missing.map((a) => a.name).join(", ")}` : "";
  };
  const text = (value: string, set: (v: string) => void, placeholder = "") => {
    const input = commitInput(value, (v) => (set(v), update()), { placeholder, className: "fd-mono" }) as HTMLInputElement;
    input.addEventListener("input", () => (set(input.value), update()));
    return input;
  };
  const argFields = args.map((a) =>
    h(
      "label",
      { class: "rw-field" },
      h("span", { class: "rw-field-label" }, humanizeArg(a.name), a.is_required ? h("sup", { class: "fd-required" }, "*") : null),
      text("", (v) => (values.args[a.name] = v), a.is_array ? "one two three" : a.name === "name" ? "PostPublished" : ""),
      h("span", { class: "fd-note" }, a.description),
    ),
  );
  const flags = options.filter((o) => !o.accept_value);
  const valued = options.filter((o) => o.accept_value);
  const flagFields = flags.map((o) => {
    const box = h("input", { type: "checkbox" });
    box.onchange = () => (box.checked ? values.flags.add(o.name) : values.flags.delete(o.name), update());
    return h("label", { class: "ne-flag", title: o.description }, box, h("span", {}, h("span", { class: "ne-flag-name" }, o.name.replace(/^--/, "")), h("span", { class: "fd-note" }, o.description)));
  });
  const valueFields = valued.map((o) => h("label", { class: "rw-field" }, h("span", { class: "rw-field-label" }, o.name.replace(/^--/, "")), text(o.default && typeof o.default === "string" ? "" : "", (v) => (values.options[o.name] = v), typeof o.default === "string" && o.default ? o.default : o.is_multiple ? "a, b" : ""), h("span", { class: "fd-note" }, o.description)));
  run.onclick = async () => {
    run.disabled = true;
    problem.textContent = "";
    const line = commandLine(c, values);
    try {
      const out = await fapp.artisan(host.root(), line.slice(0).concat([]));
      const files = await fapp.createdFiles(host.root(), out);
      // Generators report some failures, such as a class that exists, with an error line and a success status.
      const plain = out.replace(/\x1b\[[\d;]*m/g, "");
      const error = /^\s*ERROR\s+(.+)$/m.exec(plain);
      if (!files.length && error) throw new Error(error[1].trim());
      dialog.close();
      fapp.forget(["app", "models", "enums"]);
      host.status(files.length ? `Created ${files.map((f) => f.split("/").pop()).join(", ")}.` : out.replace(/\x1b\[[\d;]*m/g, "").trim().split("\n")[0] || "Done.");
      for (const f of files.slice(0, 5).reverse()) host.openAt(f, 1);
    } catch (e) {
      problem.textContent = errorText(e).replace(/\x1b\[[\d;]*m/g, "");
      run.disabled = false;
    }
  };
  dialog.append(
    h(
      "div",
      { class: "nl-shell" },
      h(
        "div",
        { class: "rw-body" },
        h(
          "div",
          { class: "rw-step-view" },
          h("div", { class: "rw-heading" }, h("h2", {}, generatorLabel(c.name)), h("p", { class: "fd-note" }, c.description)),
          argFields.length ? h("div", { class: "rw-grid" }, ...argFields) : null,
          flagFields.length ? h("div", {}, h("h3", { class: "rw-subheading" }, "Options"), h("div", { class: "ne-flags" }, ...flagFields)) : null,
          valueFields.length ? h("div", { class: "rw-grid" }, ...valueFields) : null,
          !argFields.length && !flagFields.length && !valueFields.length ? h("p", { class: "fd-note" }, "This generator takes no input. Create runs it as it is.") : null,
          problem,
        ),
      ),
      h("footer", { class: "rw-foot" }, preview, h("span", { class: "fd-spacer" }), h("button", { type: "button", onclick: () => dialog.close() }, "Cancel"), run),
    ),
  );
  dialog.showModal();
  update();
  requestAnimationFrame(() => dialog.querySelector<HTMLInputElement>(".rw-field input")?.focus());
  dialog.addEventListener("keydown", (e) => e.key === "Enter" && (e.metaKey || !(e.target as HTMLElement).closest("textarea")) && !run.disabled && (e.target as HTMLElement).tagName === "INPUT" && (e.preventDefault(), run.click()));
}

const humanizeArg = (name: string) => (name.charAt(0).toUpperCase() + name.slice(1)).replace(/([a-z])([A-Z])/g, "$1 $2");
