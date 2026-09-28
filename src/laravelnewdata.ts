// New Laravel Project's choices, and the installer's arguments and the script they make; and the command lines of
// Artisan's generators from their forms. No editor imports, so Node tests it.
import { shellQuote } from "./runconfig.ts";

export type Kit = "none" | "react" | "vue" | "svelte" | "livewire" | "custom";
export type NewProject = {
  parent: string;
  name: string;
  kit: Kit;
  using: string;
  auth: "laravel" | "workos" | "none";
  classComponents: boolean;
  teams: boolean;
  tests: "pest" | "phpunit";
  database: "sqlite" | "mysql" | "mariadb" | "pgsql" | "sqlsrv";
  packages: "npm" | "pnpm" | "bun" | "yarn" | "none";
  boost: boolean;
  git: boolean;
  filament: boolean;
  panel: string;
  user: { name: string; email: string; password: string };
};

/** The installer's arguments for the choices, as `laravel new` takes them. No-interaction, so it asks nothing. */
export function installerArgs(p: NewProject): string[] {
  const args = ["new", p.name];
  if (p.kit === "custom") args.push(`--using=${p.using}`);
  else if (p.kit !== "none") args.push(`--${p.kit}`);
  if (p.kit !== "none" && p.kit !== "custom") {
    if (p.auth === "workos") args.push("--workos");
    if (p.auth === "none") args.push("--no-authentication");
    if (p.teams && p.auth !== "none") args.push("--teams");
    if (p.kit === "livewire" && p.classComponents) args.push("--livewire-class-components");
  }
  args.push(`--${p.tests}`, `--database=${p.database}`);
  args.push(p.packages === "none" ? "--no-node" : `--${p.packages}`);
  args.push(p.boost ? "--boost" : "--no-boost");
  if (p.git) args.push("--git");
  args.push("--no-interaction");
  return args;
}

/** The shell script the terminal runs: the installer, then Filament and its first user when asked. */
export function installScript(p: NewProject, o: { laravel: string; composer: string; shim: string }): string {
  const q = shellQuote;
  const lines = [`export PATH=${q(o.shim)}:"$PATH"`, "set -e", `cd ${q(p.parent)}`, `php ${q(o.laravel)} ${installerArgs(p).map(q).join(" ")}`];
  if (p.filament) {
    lines.push(`cd ${q(p.name)}`, `${o.composer} require filament/filament --no-interaction`, "php artisan filament:install --panels --no-interaction");
    if (p.panel && p.panel !== "admin") lines.push(`php artisan make:filament-panel ${q(p.panel)} --no-interaction`);
    // SQLite is ready after the installer's migrations; other databases need their server first.
    if (p.database === "sqlite") {
      lines.push("php artisan migrate --force --no-interaction");
      if (p.user.email) lines.push(`php artisan make:filament-user --name=${q(p.user.name || "Admin")} --email=${q(p.user.email)} --password=${q(p.user.password)} --panel=${q(p.panel || "admin")} --no-interaction`);
    }
  }
  lines.push(`echo; echo "✓ ${p.name} is ready."`);
  return lines.join("\n");
}


// ---- Generators ----

export type Arg = { name: string; is_required: boolean; is_array: boolean; description: string; default: unknown };
export type Opt = { name: string; shortcut: string; accept_value: boolean; is_value_required: boolean; is_multiple: boolean; description: string; default: unknown };
export type Command = { name: string; description: string; hidden?: boolean; definition: { arguments: Record<string, Arg>; options: Record<string, Opt> } };

/** Options every command has, which the form leaves out. */
export const COMMON = new Set(["--help", "--quiet", "--verbose", "--version", "--ansi", "--no-ansi", "--no-interaction", "--env", "--silent"]);

export type Values = { args: Record<string, string>; flags: Set<string>; options: Record<string, string> };

/** Artisan's arguments for a command's form values: arguments in order, then options. */
export function commandLine(c: Command, v: Values): string[] {
  const out = [c.name];
  for (const a of Object.values(c.definition.arguments)) {
    const value = (v.args[a.name] ?? "").trim();
    if (!value) continue;
    if (a.is_array) out.push(...value.split(/\s+/));
    else out.push(value);
  }
  for (const o of Object.values(c.definition.options)) {
    if (COMMON.has(o.name)) continue;
    if (!o.accept_value) {
      if (v.flags.has(o.name)) out.push(o.name);
      continue;
    }
    const value = (v.options[o.name] ?? "").trim();
    if (!value) continue;
    if (o.is_multiple) for (const part of value.split(",").map((x) => x.trim()).filter(Boolean)) out.push(`${o.name}=${part}`);
    else out.push(`${o.name}=${value}`);
  }
  return out;
}

/** A readable name for a generator: `make:filament-resource` → "Filament resource". */
export const generatorLabel = (name: string) => {
  const words = name.replace(/^make:/, "").replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};


// ---- Errors ----

/**
 * The message in a failed command's output, for a toast: Laravel's `ERROR` line, an exception's message under its
 * class name, a PHP fatal error, or the first line that says something. Boxes, stack frames, and paths go.
 */
export function commandError(output: string): string {
  const lines = output
    .replace(/\x1b\[[\d;]*m/g, "")
    .split("\n")
    .map((l) => l.replace(/[│┃║╭╮╰╯─━═┌┐└┘]/g, "").trim())
    .filter(Boolean);
  const pick = (s: string) => (s.length > 240 ? `${s.slice(0, 240)}…` : s);
  const error = lines.find((l) => /^ERROR\s+/.test(l));
  if (error) return pick(error.replace(/^ERROR\s+/, ""));
  const fatal = lines.find((l) => /^(PHP )?(Fatal error|Parse error|Warning): /.test(l));
  if (fatal) return pick(fatal.replace(/^PHP /, "").replace(/ in \/\S+ on line \d+$/, ""));
  // Laravel renders an exception as its class on one line and its message on the next.
  const cls = lines.findIndex((l) => /^[A-Z][\w\\]*\\\w*(Exception|Error)\b/.test(l) && !l.includes(" "));
  if (cls >= 0 && lines[cls + 1]) return pick(`${lines[cls].split("\\").pop()}: ${lines[cls + 1]}`);
  const first = lines.find((l) => !/^(at |#\d+ |\d+▕|➜|Stack trace|Exception trace|INFO\s)/.test(l) && !/^\/\S+:\d+$/.test(l));
  return pick(first ?? "The command failed without saying why.");
}
