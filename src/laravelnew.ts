// New Laravel Project: Laravel's own installer (laravel/installer), which Tusk keeps in its tools folder and installs
// with its bundled Composer, so nothing is installed globally. A dialog chooses the installer's options (starter
// kit, authentication, tests, database, front-end packages), and optionally adds a Filament panel with a first
// user. Everything runs in a terminal tab, where the installer's own questions can be answered too; when it
// succeeds, the project opens.
import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir, homeDir } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { h, icon } from "./dom";
import { commitInput, segmented, toggleSwitch } from "./filamentpickers";
import { toolPath } from "./lsp";
import { shellQuote } from "./runconfig";
import { errorText } from "./status";
import { composerCommand } from "./toolpaths";
import { installScript, type Kit, type NewProject } from "./laravelnewdata";

type Host = { openTerminal(cwd: string, title: string, command: string[], onExit: (code: number | null) => void): void; openFolder(dir: string): void; status(text: string): void };
let host: Host;
export const initLaravelNew = (h_: Host) => (host = h_);

/** The installer in Tusk's tools folder, installed or updated with the bundled Composer; resolves to its script. */
async function installer(): Promise<{ laravel: string; composer: string; shim: string }> {
  const base = `${await appLocalDataDir()}/tools/laravel-installer`;
  const phar = await toolPath("composer/composer.phar");
  const composer = composerCommand(phar);
  const laravel = `${base}/installer/bin/laravel`;
  const shim = `${base}/bin`;
  const exists = await invoke<boolean>("path_exists", { path: laravel });
  const [program, ...first] = composer;
  if (!exists) {
    host.status("Installing Laravel's installer into Tusk's tools…");
    await invoke("run_capture", { cwd: "/", program: "/bin/mkdir", args: ["-p", base], input: null });
    await invoke("run_capture", { cwd: base, program, args: [...first, "create-project", "laravel/installer", "installer", "--no-interaction", "--prefer-dist", "--no-dev"], input: null });
  } else {
    // Starter kits change often; the installer keeps up with them, so keep it current.
    await invoke("run_capture", { cwd: `${base}/installer`, program, args: [...first, "update", "--no-interaction", "--no-dev"], input: null, anyStatus: true }).catch(() => {});
  }
  // The installer runs `composer`, which a Mac without Composer lacks: the shim runs the bundled one.
  await invoke("run_capture", { cwd: "/", program: "/bin/mkdir", args: ["-p", shim], input: null });
  await invoke("write_file", { path: `${shim}/composer`, contents: `#!/bin/sh\nexec ${composer.map(shellQuote).join(" ")} "$@"\n` });
  await invoke("run_capture", { cwd: "/", program: "/bin/chmod", args: ["+x", `${shim}/composer`], input: null });
  return { laravel, composer: composer.map(shellQuote).join(" "), shim };
}

const KITS: [Kit, string, string][] = [
  ["none", "None", "Laravel on its own, for an API or your own front end"],
  ["livewire", "Livewire", "Blade and Livewire, with Flux UI"],
  ["react", "React", "Inertia with React and TypeScript"],
  ["vue", "Vue", "Inertia with Vue and TypeScript"],
  ["svelte", "Svelte", "Inertia with Svelte and TypeScript"],
  ["custom", "Community kit", "A kit from Packagist, by its package name"],
];

/** Opens the New Laravel Project dialog. */
export async function newLaravelProject() {
  document.querySelector(".nl-dialog")?.remove();
  const home = (await homeDir().catch(() => "")).replace(/\/$/, "");
  const p: NewProject = {
    parent: localStorage.getItem("newProjectParent") ?? (home ? `${home}/Herd` : ""),
    name: "",
    kit: "livewire",
    using: "",
    auth: "laravel",
    classComponents: false,
    teams: false,
    tests: "pest",
    database: "sqlite",
    packages: "npm",
    boost: false,
    git: true,
    filament: true,
    panel: "admin",
    user: { name: "Admin", email: "admin@example.com", password: "password" },
  };
  if (!(await invoke<boolean>("path_exists", { path: p.parent }).catch(() => false))) p.parent = home ? `${home}/Sites` : "";
  if (!(await invoke<boolean>("path_exists", { path: p.parent }).catch(() => false))) p.parent = home;
  const dialog = h("dialog", { class: "rw-dialog nl-dialog", ariaLabel: "New Laravel project" });
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
  const field = (label: string, editor: HTMLElement, help?: string) => h("label", { class: "rw-field" }, h("span", { class: "rw-field-label" }, label), editor, help ? h("span", { class: "fd-note" }, help) : null);
  let problem = "";
  const render = () => {
    const where = h("div", { class: "fd-inline-editor" }, commitInput(p.parent, (v) => ((p.parent = v), render()), { className: "fd-mono" }), h("button", { type: "button", class: "nl-browse", onclick: async () => {
      const dir = await openDialog({ directory: true, defaultPath: p.parent || undefined }).catch(() => null);
      if (typeof dir === "string") (p.parent = dir), render();
    } }, icon("folder-opened"), "Choose…"));
    const isValid = () => /^[a-z0-9][a-z0-9_-]*$/i.test(p.name) && !!p.parent && (p.kit !== "custom" || /^[\w.-]+\/[\w.-]+$/.test(p.using));
    const create = h("button", { type: "button", class: "primary", disabled: !isValid() }, icon("rocket"), "Create project");
    const name = commitInput(p.name, (v) => ((p.name = v.trim()), render()), { placeholder: "my-app", className: "fd-mono" });
    name.addEventListener("input", () => {
      p.name = (name as HTMLInputElement).value.trim();
      create.disabled = !isValid();
    });
    const kits = h(
      "div",
      { class: "nl-kits", role: "radiogroup" },
      ...KITS.map(([k, label, hint]) => h("button", { type: "button", class: `nl-kit${p.kit === k ? " selected" : ""}`, role: "radio", ariaChecked: String(p.kit === k), onclick: () => ((p.kit = k), render()) }, h("strong", {}, label), h("span", { class: "fd-note" }, hint))),
    );
    const starter = p.kit !== "none" && p.kit !== "custom";
    create.onclick = () => void start(p, dialog).catch((e) => ((problem = errorText(e)), render()));
    dialog.replaceChildren(
      h(
        "div",
        { class: "nl-shell" },
        h(
          "div",
          { class: "rw-body" },
          h(
            "div",
            { class: "rw-step-view" },
            h("div", { class: "rw-heading nl-heading" }, h("img", { src: "/icon.svg", alt: "", class: "nl-logo" }), h("div", {}, h("h2", {}, "New Laravel project"), h("p", { class: "fd-note" }, "Laravel's installer creates it, with the starter kit and options you choose. Nothing is installed globally."))),
            h("div", { class: "rw-grid" }, field("Name", name, p.name && p.parent ? `${p.parent}/${p.name}` : "Letters, digits, dashes, and underscores."), field("In folder", where)),
            h("h3", { class: "rw-subheading" }, "Starter kit"),
            kits,
            p.kit === "custom" ? field("Package", commitInput(p.using, (v) => ((p.using = v.trim()), render()), { placeholder: "vendor/starter-kit", className: "fd-mono" })) : null,
            starter
              ? h(
                  "div",
                  { class: "rw-grid" },
                  field("Authentication", segmented<NewProject["auth"]>([["laravel", "Laravel's"], ["workos", "WorkOS"], ["none", "None"]], p.auth, (v) => ((p.auth = v), render())), p.auth === "workos" ? "Sign-in through WorkOS AuthKit: social logins, passkeys, and SSO." : undefined),
                  field("Teams", toggleSwitch(p.teams, (on) => (p.teams = on)), "Users belong to teams they can switch between."),
                  p.kit === "livewire" ? field("Class components", toggleSwitch(p.classComponents, (on) => (p.classComponents = on)), "Livewire components as classes rather than single files.") : h("span"),
                )
              : null,
            h("h3", { class: "rw-subheading" }, "Options"),
            h(
              "div",
              { class: "rw-grid" },
              field("Database", segmented<NewProject["database"]>([["sqlite", "SQLite"], ["mysql", "MySQL"], ["mariadb", "MariaDB"], ["pgsql", "PostgreSQL"], ["sqlsrv", "SQL Server"]], p.database, (v) => ((p.database = v), render())), p.database === "sqlite" ? "A file in the project, ready at once." : "Set its connection in .env, then run the migrations."),
              field("Tests", segmented<NewProject["tests"]>([["pest", "Pest"], ["phpunit", "PHPUnit"]], p.tests, (v) => ((p.tests = v), render()))),
              field("Front-end packages", segmented<NewProject["packages"]>([["npm", "npm"], ["pnpm", "pnpm"], ["bun", "Bun"], ["yarn", "Yarn"], ["none", "Skip"]], p.packages, (v) => ((p.packages = v), render())), "Installs and builds them. Needs the tool on your PATH."),
              field("Git repository", toggleSwitch(p.git, (on) => (p.git = on))),
              field("Laravel Boost", toggleSwitch(p.boost, (on) => (p.boost = on)), "Guidelines and tools for AI coding assistants."),
            ),
            h("h3", { class: "rw-subheading" }, "Filament"),
            h(
              "div",
              { class: "rw-grid" },
              field("Admin panel", toggleSwitch(p.filament, (on) => ((p.filament = on), render())), "Installs Filament with a panel, ready for resources."),
              p.filament ? field("Panel ID", commitInput(p.panel, (v) => (p.panel = v.trim() || "admin"), { className: "fd-mono" }), "Its address: /admin for admin.") : h("span"),
            ),
            p.filament && p.database === "sqlite"
              ? h(
                  "div",
                  { class: "rw-grid rw-grid-3" },
                  field("First user's name", commitInput(p.user.name, (v) => (p.user.name = v))),
                  field("Email", commitInput(p.user.email, (v) => (p.user.email = v.trim()), { type: "email" })),
                  field("Password", commitInput(p.user.password, (v) => (p.user.password = v), { type: "password" }), "At least 8 characters. Change it after signing in."),
                )
              : p.filament
                ? h("p", { class: "fd-note" }, "Create the first user with php artisan make:filament-user once the database is set up.")
                : null,
            problem ? h("p", { class: "rw-warn" }, icon("warning"), problem) : null,
          ),
        ),
        h("footer", { class: "rw-foot" }, h("button", { type: "button", onclick: () => dialog.close() }, "Cancel"), h("span", { class: "fd-spacer" }), create),
      ),
    );
  };
  render();
  requestAnimationFrame(() => dialog.querySelector<HTMLInputElement>(".rw-field input")?.focus());
}

/** Checks the target, installs the installer, and runs everything in a terminal tab. */
async function start(p: NewProject, dialog: HTMLDialogElement) {
  const target = `${p.parent}/${p.name}`;
  if (await invoke<boolean>("path_exists", { path: target })) throw new Error(`${target} already exists.`);
  if (p.filament && p.user.password.length < 8) throw new Error("The first user's password needs at least 8 characters.");
  const button = dialog.querySelector<HTMLButtonElement>(".rw-foot .primary");
  if (button) (button.disabled = true), (button.textContent = "Preparing the installer…");
  const tools = await installer();
  try {
    localStorage.setItem("newProjectParent", p.parent);
  } catch {}
  dialog.close();
  host.openTerminal(p.parent, `New project: ${p.name}`, ["/bin/sh", "-c", installScript(p, tools)], (code) => {
    if (code === 0) host.openFolder(target);
    else host.status(`Creating ${p.name} stopped. The terminal shows why.`);
  });
}
