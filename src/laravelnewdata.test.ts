/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { installerArgs, installScript, type NewProject } from "./laravelnewdata.ts";

const base: NewProject = {
  parent: "/Users/me/Herd",
  name: "shop",
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

test("installerArgs turns the choices into laravel new's flags", () => {
  assert.deepEqual(installerArgs(base), ["new", "shop", "--livewire", "--pest", "--database=sqlite", "--npm", "--no-boost", "--git", "--no-interaction"]);
  assert.deepEqual(installerArgs({ ...base, kit: "react", auth: "workos", teams: true, tests: "phpunit", database: "pgsql", packages: "none", boost: true, git: false }), ["new", "shop", "--react", "--workos", "--teams", "--phpunit", "--database=pgsql", "--no-node", "--boost", "--no-interaction"]);
  assert.deepEqual(installerArgs({ ...base, kit: "custom", using: "acme/kit" }).slice(0, 3), ["new", "shop", "--using=acme/kit"]);
  assert.ok(installerArgs({ ...base, kit: "vue", auth: "none" }).includes("--no-authentication"));
  assert.ok(!installerArgs({ ...base, kit: "none", auth: "none" }).includes("--no-authentication"));
});

test("installScript adds Filament and its first user on SQLite", () => {
  const script = installScript(base, { laravel: "/tools/laravel", composer: "php /tools/composer.phar", shim: "/tools/bin" });
  assert.match(script, /^export PATH=\/tools\/bin:"\$PATH"\nset -e\ncd \/Users\/me\/Herd\nphp \/tools\/laravel new shop --livewire/);
  assert.match(script, /cd shop\nphp \/tools\/composer\.phar require filament\/filament --no-interaction\nphp artisan filament:install --panels --no-interaction\nphp artisan migrate --force --no-interaction\nphp artisan make:filament-user --name=Admin --email=admin@example\.com --password=password --panel=admin --no-interaction/);
  const mysql = installScript({ ...base, database: "mysql", panel: "backoffice" }, { laravel: "l", composer: "c", shim: "s" });
  assert.match(mysql, /make:filament-panel backoffice/);
  assert.doesNotMatch(mysql, /make:filament-user/);
  assert.doesNotMatch(installScript({ ...base, filament: false }, { laravel: "l", composer: "c", shim: "s" }), /filament/);
});

test("commandLine writes a generator's arguments and options", async () => {
  const { commandLine, generatorLabel } = await import("./laravelnewdata.ts");
  const c = {
    name: "make:event",
    description: "",
    definition: {
      arguments: { name: { name: "name", is_required: true, is_array: false, description: "", default: null } },
      options: {
        "--force": { name: "--force", shortcut: "", accept_value: false, is_value_required: false, is_multiple: false, description: "", default: false },
        "--queue": { name: "--queue", shortcut: "", accept_value: true, is_value_required: true, is_multiple: false, description: "", default: null },
        "--tag": { name: "--tag", shortcut: "", accept_value: true, is_value_required: true, is_multiple: true, description: "", default: [] },
        "--help": { name: "--help", shortcut: "h", accept_value: false, is_value_required: false, is_multiple: false, description: "", default: false },
      },
    },
  };
  assert.deepEqual(commandLine(c, { args: { name: " OrderShipped " }, flags: new Set(["--force", "--help"]), options: { "--queue": "high", "--tag": "a, b" } }), ["make:event", "OrderShipped", "--force", "--queue=high", "--tag=a", "--tag=b"]);
  assert.equal(generatorLabel("make:filament-relation-manager"), "Filament relation manager");
});

test("commandError keeps the message of a failed command's output", async () => {
  const { commandError } = await import("./laravelnewdata.ts");
  assert.equal(commandError("\n   \x1b[41;1m ERROR \x1b[49;22m Enum already exists.  \n\n"), "Enum already exists.");
  assert.equal(
    commandError("\n   Illuminate\\Database\\QueryException \n\n  SQLSTATE[08006] [7] connection to server failed: Connection refused\n\n  at vendor/laravel/framework/src/Illuminate/Database/Connection.php:825\n    821▕ \n      +37 vendor frames \n"),
    "QueryException: SQLSTATE[08006] [7] connection to server failed: Connection refused",
  );
  assert.equal(commandError("PHP Parse error:  syntax error, unexpected token \"}\" in /app/Models/Post.php on line 12\n"), "Parse error:  syntax error, unexpected token \"}\"");
  assert.equal(commandError(""), "The command failed without saying why.");
});
