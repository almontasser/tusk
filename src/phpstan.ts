// PHPStan's settings for the open project, and its state. Tusk's server runs PHPStan (tusk-lsp/src/phpstan.rs);
// this module gives it the settings (the `phpstan` option, sent again whenever they change) and shows what it's
// doing: a spinner in the status bar while it runs, and its state in the Problems panel.
import { invoke } from "@tauri-apps/api/core";
import { configureTusk, spellingRoot, tuskNotifications, tuskOptions } from "./lsp";
import { setPhpStanState } from "./problems";
import { registerProjectSettings } from "./settings";
import { status } from "./status";

/** Config files in the project's root, for the Configuration file choice; read each time the server starts. */
let configs: string[] = [];

const LEVELS: [string, string][] = [["", "From the configuration file"], ...Array.from({ length: 11 }, (_, i): [string, string] => [String(i), `Level ${i}`]), ["max", "Max"]];

type PhpStanSettings = { enabled: string; config: string; level: string; memoryLimit: string; timeout: number; run: string };
const DEFAULTS: PhpStanSettings = { enabled: "auto", config: "", level: "", memoryLimit: "2G", timeout: 180, run: "save" };

export const phpstanSettings: () => PhpStanSettings = registerProjectSettings(
  "PHPStan",
  "phpstan",
  DEFAULTS,
  [
    {
      key: "enabled",
      label: "Run PHPStan",
      type: "select",
      options: [
        ["auto", "When the project has vendor/bin/phpstan"],
        ["on", "Always (say so when it isn't installed)"],
        ["off", "Never"],
      ],
    },
    {
      key: "run",
      label: "Check files",
      type: "select",
      options: [
        ["save", "When a file opens and each time it's saved"],
        ["demand", "Only when you run PHPStan on the project"],
      ],
      help: "Code > Run PHPStan on Project checks every file, and lists the problems in the Problems panel.",
    },
    {
      key: "config",
      label: "Configuration file",
      type: "select",
      options: (): [string, string, string][] => {
        const current = phpstanSettings().config;
        const found = current && !configs.includes(current) ? [...configs, current] : configs;
        return [["", "Find it (phpstan.neon or .neon.dist)", ""], ...found.map((f): [string, string, string] => [f, f, ""])];
      },
    },
    { key: "level", label: "Rule level", type: "select", options: LEVELS, help: "Overrides the configuration file's level. Higher levels report more." },
    { key: "memoryLimit", label: "Memory limit", type: "text", placeholder: "2G", help: "PHP's memory_limit for PHPStan, such as 1G, 4G, or -1 for no limit." },
    { key: "timeout", label: "Timeout (seconds)", type: "number", min: 10, max: 3600, help: "A run that takes longer is stopped. Larastan's first run on a cold cache is the slowest." },
  ],
  () => configureTusk(),
);

tuskOptions.phpstan = phpstanSettings;

let failure = "";
tuskNotifications["tusk/phpstan"] = ({ state, message }: { state: "off" | "missing" | "idle" | "running" | "failed"; message: string }) => {
  if (state === "running") status(message, "phpstan:progress");
  else status("", "phpstan:progress");
  // A failure toasts once, not on every save that fails the same way; the Problems panel keeps showing it.
  if (state === "failed" && message !== failure) status(message, "phpstan", "error");
  failure = state === "failed" ? message : "";
  setPhpStanState(state, message);
  if (state !== "running") void readConfigs();
};

async function readConfigs() {
  const root = spellingRoot();
  if (!root) return;
  const entries = await invoke<{ name: string; is_dir: boolean }[]>("read_dir", { path: root }).catch(() => []);
  configs = entries.filter((e) => !e.is_dir && /\.neon(\.dist)?$/.test(e.name)).map((e) => e.name).sort();
}
