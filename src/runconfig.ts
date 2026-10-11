// Run configurations, as PhpStorm has them: named, saved ways to run tests, Artisan, scripts, and servers. This
// module holds the types, the form each type shows, validation, and the command line each builds. It has no editor
// imports, so Node can test it. To add a type, add it to ConfigType and TYPES, and give it a case in `commandFor`.
import { escapeRegex } from "./phptests.ts";

export type ConfigType = "test" | "artisan" | "php" | "composer" | "npm" | "shell" | "server";
/** How a configuration runs: plainly, in the debugger, with code coverage, or with Xdebug's profiler. */
export type Mode = "run" | "debug" | "coverage" | "profile";

/** A step before launch: another configuration, by name, or a shell command line, such as `npm run build`. */
export type BeforeStep = { config: string } | { command: string };

export type RunConfig = {
  name: string;
  type: ConfigType;
  /** The folder to run in, relative to the project; empty for the project. */
  cwd?: string;
  env?: Record<string, string>;
  /** Run in the project's container (Sail, or the chosen Compose service) when it's up. */
  docker?: boolean;
  before?: BeforeStep[];
  /** Run again while it runs, in a second tab, instead of stopping it first. */
  multiple?: boolean;
  /** Tests: the runner. */
  runner?: "auto" | "artisan" | "pest" | "phpunit";
  /** Tests: what to run. */
  scope?: "all" | "directory" | "file" | "class" | "method" | "filter";
  /** Tests: the directory or file. PHP script: the script. Server: the document root. */
  path?: string;
  /** Tests: the class, the method (or Pest description), or a `--filter` pattern. */
  filter?: string;
  /** Tests: the PHPUnit configuration file, such as phpunit.xml. */
  configFile?: string;
  coverage?: boolean;
  /** The Artisan command, the Composer or npm script, or the shell command line. */
  command?: string;
  /** More arguments, as you'd type them in a shell. */
  args?: string;
  /** Server: `php artisan serve` or PHP's built-in server. */
  server?: "artisan" | "php";
  host?: string;
  port?: number;
  /** Server: serve at https://<domain>.test through Tusk's proxy, instead of at the host and port. */
  testDomain?: boolean;
  /** Server: the .test domain's label; empty for the project folder's name. */
  domain?: string;
};

export type Field = {
  key: keyof RunConfig;
  label: string;
  kind: "text" | "select" | "checkbox" | "number";
  options?: [value: string, label: string][];
  placeholder?: string;
  help?: string;
  /** Whether the field applies to the configuration as it is, such as a test file only for a file scope. */
  shown?: (c: RunConfig) => boolean;
  /** The field names a file or folder in the project, which the dialog checks exists. */
  path?: "file" | "dir";
};

export type TypeInfo = {
  label: string;
  /** A codicon name. */
  icon: string;
  /** Whether it runs PHP, so it can run in the debugger and in the container. */
  php: boolean;
  defaults: Partial<RunConfig>;
  fields: Field[];
};

const scopeIs = (...scopes: RunConfig["scope"][]) => (c: RunConfig) => scopes.includes(c.scope ?? "all");

export const TYPES: Record<ConfigType, TypeInfo> = {
  test: {
    label: "PHPUnit / Pest",
    icon: "beaker",
    php: true,
    defaults: { runner: "auto", scope: "all", docker: true },
    fields: [
      { key: "runner", label: "Test runner", kind: "select", options: [["auto", "Detect (artisan test, then Pest, then PHPUnit)"], ["artisan", "php artisan test"], ["pest", "Pest"], ["phpunit", "PHPUnit"]] },
      { key: "scope", label: "Test scope", kind: "select", options: [["all", "All tests"], ["directory", "Directory"], ["file", "File"], ["class", "Class"], ["method", "Method or Pest test"], ["filter", "Filter pattern"]] },
      { key: "path", label: "Directory", kind: "text", placeholder: "tests/Feature", shown: scopeIs("directory"), path: "dir" },
      { key: "path", label: "File", kind: "text", placeholder: "tests/Feature/PostTest.php", shown: scopeIs("file", "method"), path: "file" },
      { key: "filter", label: "Class", kind: "text", placeholder: "Tests\\Feature\\PostTest", shown: scopeIs("class") },
      { key: "filter", label: "Method", kind: "text", placeholder: "test_index or it lists posts", shown: scopeIs("method") },
      { key: "filter", label: "Filter", kind: "text", placeholder: "PostTest::test_.*", help: "A --filter pattern, as PHPUnit and Pest read it.", shown: scopeIs("filter") },
      { key: "configFile", label: "Configuration file", kind: "text", placeholder: "phpunit.xml (default)", path: "file" },
      { key: "args", label: "Test runner options", kind: "text", placeholder: "--stop-on-failure --group slow" },
      { key: "coverage", label: "Collect code coverage", kind: "checkbox" },
    ],
  },
  artisan: {
    label: "Artisan command",
    icon: "symbol-event",
    php: true,
    defaults: { docker: true },
    fields: [
      { key: "command", label: "Command", kind: "text", placeholder: "migrate:fresh --seed" },
      { key: "args", label: "Arguments", kind: "text", placeholder: "--force" },
    ],
  },
  php: {
    label: "PHP script",
    icon: "file-code",
    php: true,
    defaults: { docker: true },
    fields: [
      { key: "path", label: "Script", kind: "text", placeholder: "scripts/import.php", path: "file" },
      { key: "args", label: "Arguments", kind: "text" },
    ],
  },
  composer: {
    label: "Composer script",
    icon: "package",
    php: true,
    defaults: { docker: false },
    fields: [
      { key: "command", label: "Script", kind: "text", placeholder: "test", help: "A script from composer.json." },
      { key: "args", label: "Arguments", kind: "text" },
    ],
  },
  npm: {
    label: "npm script",
    icon: "json",
    php: false,
    defaults: {},
    fields: [
      { key: "command", label: "Script", kind: "text", placeholder: "dev", help: "A script from package.json." },
      { key: "args", label: "Arguments", kind: "text" },
    ],
  },
  shell: {
    label: "Shell command",
    icon: "terminal",
    php: false,
    defaults: {},
    fields: [{ key: "command", label: "Command line", kind: "text", placeholder: "npm run build && php artisan optimize", help: "Runs with /bin/sh, so quoting and pipes work." }],
  },
  server: {
    label: "PHP web server",
    icon: "globe",
    php: true,
    defaults: { server: "artisan", host: "127.0.0.1", port: 8000, docker: false, testDomain: false },
    fields: [
      { key: "server", label: "Server", kind: "select", options: [["artisan", "php artisan serve"], ["php", "PHP's built-in server (php -S)"]] },
      { key: "host", label: "Host", kind: "text", placeholder: "127.0.0.1", shown: (c) => !c.testDomain },
      { key: "port", label: "Port", kind: "number", placeholder: "8000", shown: (c) => !c.testDomain },
      { key: "domain", label: "Domain", kind: "text", placeholder: "the project folder's name", help: "Served at https://‹domain›.test.", shown: (c) => !!c.testDomain },
      { key: "path", label: "Document root", kind: "text", placeholder: "public", shown: (c) => c.server === "php", path: "dir" },
      { key: "args", label: "Arguments", kind: "text" },
      {
        key: "testDomain",
        label: "Serve at https://‹domain›.test",
        kind: "checkbox",
        help: "Tusk sets up a local certificate and DNS the first time, and your system asks for your password once.",
      },
    ],
  },
};

/** A new configuration of a type, with a name not in `taken`. */
export function newConfig(type: ConfigType, taken: string[]): RunConfig {
  return { name: uniqueName(`Unnamed ${TYPES[type].label}`, taken), type, ...structuredClone(TYPES[type].defaults) };
}

/** `name`, or `name (2)`, `name (3)`, …, whichever isn't taken. */
export function uniqueName(name: string, taken: string[]): string {
  const base = name.replace(/ \(\d+\)$/, "");
  if (!taken.includes(name)) return name;
  for (let n = 2; ; n++) if (!taken.includes(`${base} (${n})`)) return `${base} (${n})`;
}

/** Splits arguments as a shell would: on spaces, with single and double quotes and backslashes. */
export function shellWords(line = ""): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = "";
      else if (ch === "\\" && quote === '"' && /["\\$`]/.test(line[i + 1] ?? "")) word += line[++i];
      else word += ch;
    } else if (ch === "'" || ch === '"') (quote = ch), (word ??= "");
    else if (ch === "\\" && i + 1 < line.length) word = (word ?? "") + line[++i];
    else if (/\s/.test(ch)) word !== null && (words.push(word), (word = null));
    else word = (word ?? "") + ch;
  }
  if (word !== null) words.push(word);
  return words;
}

/** Quotes a word for `/bin/sh` when it needs it. */
export const shellQuote = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);


/**
 * The `--filter` for one test by name: a PHPUnit method, or a Pest description with any describe() blocks in front,
 * with an optional data set, so `test_a` doesn't also run `test_a_twice`.
 */
export const methodFilter = (name: string) => `::(?:.* → )?${escapeRegex(name)}( with data set .*)?$`;

/** What exists in the project, for the commands that depend on it. */
export type Project = { artisan: boolean; pest: boolean };

/** The test runner's command, before any container. */
export function testRunner(runner: RunConfig["runner"], project: Project): string[] {
  const chosen = runner && runner !== "auto" ? runner : project.artisan ? "artisan" : project.pest ? "pest" : "phpunit";
  return chosen === "artisan" ? ["php", "artisan", "test"] : [`vendor/bin/${chosen}`];
}

/** A .test domain's label: lowercase letters, digits, and hyphens, as the backend accepts. */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Whether a configuration serves at a .test domain. */
export const servesTestDomain = (c: RunConfig) => c.type === "server" && !!c.testDomain;

/** The .test domain's label: the configuration's domain, or else the project folder's name made into a label. */
export function domainFor(c: RunConfig, root: string): string {
  if (c.domain?.trim()) return c.domain.trim().toLowerCase();
  const folder = root.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const trim = (s: string) => s.replace(/^-+|-+$/g, "");
  return trim(trim(folder.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, 63)) || "app";
}

/** A .test server's document root, relative to its folder: Laravel's `public`, or the configured one. */
export const docrootFor = (c: RunConfig) => (c.server === "php" ? c.path || "public" : "public");

/** Where a .test server listens, and its router script, from `local_domain_start` and `routerScript`. */
export type Served = { port: number; router: string };

/**
 * The command line a configuration runs, relative to the project, before the container, the environment, and
 * the test reports are added. `vendor/bin/…` stays relative for the container to resolve. A .test server runs PHP's
 * built-in server on `served`'s port with its router, for Laravel too, as `artisan serve` itself does.
 */
export function commandFor(c: RunConfig, project: Project, served?: Served): string[] {
  const args = shellWords(c.args);
  switch (c.type) {
    case "test": {
      const scope = c.scope ?? "all";
      const target = ["directory", "file", "method"].includes(scope) && c.path ? [c.path] : [];
      const filter =
        scope === "class" ? escapeRegex(c.filter ?? "") : scope === "method" ? methodFilter(c.filter ?? "") : scope === "filter" ? (c.filter ?? "") : "";
      return [...testRunner(c.runner, project), ...(c.configFile ? ["--configuration", c.configFile] : []), ...target, ...(filter ? ["--filter", filter] : []), ...args];
    }
    case "artisan":
      return ["php", "artisan", ...shellWords(c.command), ...args];
    case "php":
      return ["php", c.path ?? "", ...args];
    case "composer":
      return ["composer", "run-script", c.command ?? "", ...(args.length ? ["--", ...args] : [])];
    case "npm":
      return ["npm", "run", c.command ?? "", ...(args.length ? ["--", ...args] : [])];
    case "shell":
      return ["/bin/sh", "-c", c.command ?? ""];
    case "server": {
      if (c.testDomain) return ["php", "-S", `127.0.0.1:${served?.port ?? "…"}`, "-t", docrootFor(c), ...(served ? [served.router] : []), ...args];
      const host = c.host || "127.0.0.1";
      const port = String(c.port || 8000);
      return c.server === "php" ? ["php", "-S", `${host}:${port}`, "-t", c.path || "public", ...args] : ["php", "artisan", "serve", "--host", host, "--port", port, ...args];
    }
  }
}

/** A one-line summary, such as the command it runs, for lists. A .test server's port is chosen when it runs, so it reads `…`. */
export function summary(c: RunConfig, project: Project = { artisan: true, pest: false }, root = "") {
  if (c.type === "shell") return c.command ?? "";
  const line = commandFor(c, project).map((w) => (w.endsWith(":…") ? w : shellQuote(w))).join(" ");
  return servesTestDomain(c) ? `${line} (https://${domainFor(c, root)}.test)` : line;
}

/** PHP's single-quoted string for `s`. */
const phpString = (s: string) => `'${s.replace(/[\\']/g, "\\$&")}'`;

/**
 * The router script for a .test server. Tusk's proxy adds no X-Forwarded headers, so the router marks each request
 * as HTTPS on the URL's port. With `laravel`, it runs Laravel's server.php from the document root, as `artisan serve`
 * does; without, `return false` serves the request as PHP's server does without a router, keeping the changes to
 * `$_SERVER`. Values are written into the script, since passing environment variables differs on Windows.
 */
export function routerScript(url: string, laravel?: { docroot: string; serverPhp: string }): string {
  const port = new URL(url).port || "443";
  return [
    "<?php",
    "// Written by Tusk for a .test run configuration: its proxy serves HTTPS, so requests are marked as secure.",
    "$_SERVER['HTTPS'] = 'on';",
    "$_SERVER['REQUEST_SCHEME'] = 'https';",
    `$_SERVER['SERVER_PORT'] = ${phpString(port)};`,
    ...(laravel ? [`chdir(${phpString(laravel.docroot)});`, `return require ${phpString(laravel.serverPhp)};`] : ["return false;"]),
    "",
  ].join("\n");
}

/** Commands that keep running until stopped: dev servers, watchers, queue workers, and containers. */
export const LONG_RUNNING =
  /\b(?:artisan\s+(?:serve|queue:work|queue:listen|horizon|reverb:start|schedule:work|pail|octane:start)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|watch|serve|start)|vite(?!\s+build)(?:\s|$)|sail\s+up|(?:docker[-\s]compose)\s+up)\b/;

/** Whether a configuration runs until you stop it, such as a server, so its tab reopens with the project. */
export const longRunning = (c: RunConfig) => c.type === "server" || LONG_RUNNING.test(`${c.type === "npm" ? "npm run " : c.type === "artisan" ? "artisan " : ""}${c.command ?? ""}`);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What's wrong with a configuration, as messages for its form; empty when it can run. `all` holds every configuration, itself included. */
export function validate(c: RunConfig, all: RunConfig[]): string[] {
  const errors: string[] = [];
  const need = (value: unknown, what: string) => !String(value ?? "").trim() && errors.push(`Enter ${what}.`);
  need(c.name, "a name");
  if (all.filter((o) => o.name.trim() === c.name.trim()).length > 1) errors.push(`Another configuration is named “${c.name}”. Names must be unique.`);
  const scope = c.scope ?? "all";
  if (c.type === "test") {
    if (scope === "directory") need(c.path, "the test directory");
    if (scope === "file" || scope === "method") need(c.path, "the test file");
    if (scope === "class") need(c.filter, "the test class");
    if (scope === "method") need(c.filter, "the test method or Pest description");
    if (scope === "filter") need(c.filter, "a filter pattern");
  }
  if (c.type === "artisan") need(c.command, "the Artisan command");
  if (c.type === "php") need(c.path, "the script to run");
  if (c.type === "composer" || c.type === "npm") need(c.command, "the script's name");
  if (c.type === "shell") need(c.command, "the command line");
  if (c.type === "server" && c.testDomain) {
    if (c.domain?.trim() && !LABEL.test(c.domain.trim().toLowerCase()))
      errors.push(`“${c.domain}” can't be a .test domain. Use up to 63 lowercase letters, digits, and hyphens, not starting or ending with a hyphen.`);
    if (c.docker) errors.push("Turn off Docker to serve at a .test domain: Tusk's proxy reaches servers on this computer.");
  } else if (c.type === "server") {
    if (!Number.isInteger(c.port) || c.port! < 1 || c.port! > 65535) errors.push("Enter a port from 1 to 65535.");
    need(c.host, "the host");
  }
  for (const key of Object.keys(c.env ?? {})) if (!ENV_NAME.test(key)) errors.push(`“${key}” isn't a valid environment variable name: use letters, digits, and _, not starting with a digit.`);
  for (const step of c.before ?? []) {
    if ("command" in step) need(step.command, "the before-launch command");
    else if (step.config === c.name) errors.push("A configuration can't run itself before launch.");
    else if (!all.some((o) => o.name === step.config)) errors.push(`Before launch runs “${step.config}”, which doesn't exist.`);
  }
  const cycle = beforeCycle(c.name, all);
  if (cycle) errors.push(`Before launch runs in a circle: ${cycle.join(" → ")}.`);
  return errors;
}

/** A loop of before-launch configurations that starts from `name`, as the names along it, or null. */
function beforeCycle(name: string, all: RunConfig[]): string[] | null {
  const byName = new Map(all.map((c) => [c.name, c]));
  const walk = (at: string, path: string[]): string[] | null => {
    for (const step of byName.get(at)?.before ?? []) {
      if (!("config" in step) || step.config === at) continue;
      if (step.config === name) return [...path, name];
      if (!path.includes(step.config)) {
        const found = walk(step.config, [...path, step.config]);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(name, [name]);
}

/** How many temporary configurations stay, as in PhpStorm. */
export const MAX_TEMPORARY = 5;

/** The temporary configurations after running `c`: it comes first, replacing one of its name, and the oldest go past the limit. */
export const addTemporary = (list: RunConfig[], c: RunConfig) => [c, ...list.filter((o) => o.name !== c.name)].slice(0, MAX_TEMPORARY);

/** A configuration for plain JSON: without empty values, so tusk.json stays short. */
export function clean(c: RunConfig): RunConfig {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined || v === "" || v === false || (Array.isArray(v) && !v.length) || (v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length)) continue;
    out[k] = v;
  }
  // Docker's default depends on the type: keep only a choice that differs from it.
  const docker = TYPES[c.type]?.defaults.docker ?? false;
  if (c.docker === undefined || c.docker === docker || !TYPES[c.type]?.php) delete out.docker;
  else out.docker = c.docker;
  return out as RunConfig;
}

/** Reads configurations from project state, dropping entries that aren't objects with a name and a known type. */
export const readConfigs = (value: unknown): RunConfig[] =>
  Array.isArray(value) ? value.filter((c): c is RunConfig => !!c && typeof c === "object" && typeof c.name === "string" && c.type in TYPES) : [];
