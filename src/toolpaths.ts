// Settings > Tools: the paths of PHP, Composer, Node, git, gh, and Docker, the project's own PHP interpreter, the
// terminal's shell, and whether Tusk checks for updates by itself. The backend (toolpaths.rs) puts a shim for each
// set path first on the PATH of every program the app starts, so call sites keep running "php" or "git" by name and
// a change applies to the next program without a restart. A missing tool comes back as an error that names the
// setting, and as a `tool-missing` event this module shows with Open Settings.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isWindows, open } from "./platform.ts";
import { toast } from "./dom";
import { pick } from "./palette";
import { onProjectValue, projectValue, setProjectValue, shareItem } from "./projectstate";
import { onSettings, openSettings, registerSettings } from "./settings";
import { errorText, showError } from "./status";
import { FIND_INTERPRETERS, type Interpreter, parseInterpreters, versionLine } from "./toolpathsdata";

type Tool = "php" | "composer" | "node" | "git" | "gh" | "docker";
const LABELS: Record<Tool, string> = { php: "PHP", composer: "Composer", node: "Node.js", git: "Git", gh: "GitHub CLI (gh)", docker: "Docker" };

const capture = (program: string, args: string[]) => invoke<string>("run_capture", { cwd: "/", program, args, input: null });

/** What a path field finds: the set program's version, or the one on PATH, or why neither works. */
async function describe(tool: Tool | "shell", value: string): Promise<string> {
  const version = (path: string) =>
    capture(path, ["--version"]).then(versionLine, (e) => {
      throw new Error(`Can't run ${path}: ${errorText(e)}`);
    });
  if (value) return `Works: ${await version(value)}`;
  if (tool === "shell") return "Uses your login shell ($SHELL).";
  if (tool === "composer") {
    const phar = await invoke<string>("tool_path", { name: "composer/composer.phar" });
    return `Uses the bundled ${await capture("php", [phar, "--version", "--no-ansi"]).then(versionLine, () => "Composer, which needs PHP")}.`;
  }
  const found = await invoke<string | null>("tool_which", { name: tool });
  if (!found) throw new Error(`${LABELS[tool]} isn't on your PATH. Install it, or set its path.`);
  return `Detected: ${found} (${await version(found)})`;
}

let found: Promise<Interpreter[]> | null = null;
/** The PHP interpreters on this Mac, looked up once per session; `again` looks again. */
export function interpreters(again = false) {
  if (again || !found) found = capture("/bin/sh", ["-c", FIND_INTERPRETERS]).then(parseInterpreters);
  return found;
}

const path = <K extends string>(key: K, tool: Tool, help: string, extra: object = {}) => ({
  key,
  label: LABELS[tool],
  type: "path" as const,
  placeholder: "Auto-detect",
  help,
  describe: (v: string) => describe(tool, v),
  ...extra,
});

export const tools = registerSettings(
  "Tools",
  { toolPhp: "", toolComposer: "", toolNode: "", toolGit: "", toolGh: "", toolDocker: "", checkForUpdates: true },
  [
    path("toolPhp", "php", "Runs Artisan, tests, Composer, and the PHP server's helpers. Leave it empty to use the php on your PATH. A project can choose its own: Tools > Choose PHP Interpreter…", {
      suggest: async () => (await interpreters()).map((i): [string, string] => [i.path, `PHP ${i.version}`]),
    }),
    path("toolComposer", "composer", "A composer program. Leave it empty to use the bundled composer.phar with the PHP above."),
    path("toolNode", "node", "Runs Prettier, blade-formatter, the JavaScript language servers, and the debugger."),
    path("toolGit", "git", "Runs every Git command."),
    path("toolGh", "gh", "Runs pull requests."),
    path("toolDocker", "docker", "Runs Docker Compose services, such as Sail's."),
    { key: "checkForUpdates", label: "Check for app and tool updates automatically", type: "checkbox", help: "At launch and every six hours. Turn it off on an offline or locked-down computer; Tusk > Check for Updates… still works. Tools that are missing still download." },
  ],
);

const shell = registerSettings("Terminal", { terminalShell: "", terminalShellArgs: isWindows ? "-NoLogo" : "-l" }, [
  { key: "terminalShell", label: "Shell", type: "path", placeholder: isWindows ? "PowerShell" : "Your login shell ($SHELL)", describe: (v) => describe("shell", v), help: "Applies to new terminal tabs." },
  { key: "terminalShellArgs", label: "Shell arguments", type: "text", placeholder: "None", help: "Separated by spaces. -l starts a login shell, which reads your profile." },
]);

/** The command that runs Composer: the set program, or PHP with the bundled composer.phar. */
export const composerCommand = (phar: string) => (tools.toolComposer ? ["composer"] : ["php", phar]);

let host = { restartServers: () => {} };
export const initToolPaths = (h: typeof host) => (host = h);

let sent: { paths: Record<Tool, string> } | null = null;
/** Whether a project's servers have started, with the paths `sent` then. */
let serversStarted = false;

/**
 * Sends the paths to the backend when they change: after a settings change, when a project opens (`opening`, whose
 * servers start anyway), and when tusk.json changes the project's PHP. The language servers started with the old
 * PHP or Node, so a change offers to restart them.
 */
export async function configureTools(opening = false) {
  const project = projectValue<string>("phpInterpreter");
  const paths: Record<Tool, string> = {
    php: (typeof project === "string" && project) || tools.toolPhp,
    composer: tools.toolComposer,
    node: tools.toolNode,
    git: tools.toolGit,
    gh: tools.toolGh,
    docker: tools.toolDocker,
  };
  const config = { paths, shell: shell.terminalShell, shellArgs: shell.terminalShellArgs };
  const before = sent;
  if (JSON.stringify(before) === JSON.stringify(config)) return;
  sent = config;
  try {
    await invoke("tools_configure", { config });
  } catch (e) {
    sent = before;
    return showError("Can't apply Settings > Tools", e);
  }
  // Only servers that started with the old paths need a restart: at launch, the saved settings load after the defaults went out.
  serversStarted ||= opening;
  if (!opening && serversStarted && before && (before.paths.php !== paths.php || before.paths.node !== paths.node))
    toast(`${before.paths.php !== paths.php ? "PHP" : "Node.js"} changed. Restart the language servers to use it there too.`, {
      kind: "info",
      action: { label: "Restart Language Servers", run: () => host.restartServers() },
    });
}
onSettings(() => void configureTools());
onProjectValue("phpInterpreter", () => void configureTools());

/** Where to get the tools the app can't do without for some features, by the name errors give them. */
const DOWNLOADS: Record<string, [label: string, url: string]> = {
  "Node.js": ["Get Node.js", "https://nodejs.org/en/download"],
  "GitHub CLI (gh)": ["Get the GitHub CLI", "https://cli.github.com"],
};

listen<string>("tool-missing", (e) => {
  const download = Object.entries(DOWNLOADS).find(([name]) => e.payload.startsWith(`${name} wasn't found.`))?.[1];
  toast(e.payload, {
    action: [
      ...(download ? [{ label: download[0], run: () => invoke("open_url", { url: download[1] }) }] : []),
      { label: "Open Settings", run: () => openSettings("Tools") },
    ],
  });
});

async function setProjectPhp(path: string | undefined) {
  try {
    await setProjectValue("phpInterpreter", path || undefined);
    await configureTools();
    toast(path ? `This project uses ${path}.` : "This project uses the PHP from Settings > Tools.", { kind: "info", timeout: 4000 });
  } catch (e) {
    showError("Can't set the project's PHP interpreter", e);
  }
}

/** Picks the project's PHP interpreter from those on this Mac, a file, or the one in Settings > Tools. */
export function choosePhpInterpreter() {
  const current = projectValue<string>("phpInterpreter") ?? "";
  pick("PHP interpreter for this project", async () => {
    const list = await interpreters(true);
    if (current && !list.some((i) => i.path === current)) list.unshift({ path: current, version: "set for this project" });
    return [
      { label: `${current ? "" : "✓ "}Use the default from Settings > Tools`, detail: tools.toolPhp || "The php on your PATH", icon: "codicon-settings-gear", run: () => setProjectPhp(undefined) },
      ...list.map((i) => ({ label: `${i.path === current ? "✓ " : ""}PHP ${i.version}`, detail: i.path, icon: "codicon-symbol-method", run: () => setProjectPhp(i.path) })),
      {
        label: "Choose a file…",
        icon: "codicon-folder-opened",
        run: async () => {
          const path = await open({ title: "PHP interpreter" });
          if (typeof path === "string") await setProjectPhp(path);
        },
      },
      ...(current ? [shareItem("phpInterpreter", "PHP interpreter")] : []),
    ];
  });
}
