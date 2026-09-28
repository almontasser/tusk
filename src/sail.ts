// Containers: when a project runs PHP in Docker and the containers are up, tests, Artisan, and Tinker run
// inside them. Laravel Sail goes through vendor/bin/sail; other Docker Compose setups through
// `docker compose exec` in the service that mounts the project.
import { invoke } from "@tauri-apps/api/core";

const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];

/** Whether the project is set up for Sail: vendor/bin/sail exists and a compose file uses its images. */
export async function usesSail(root: string): Promise<boolean> {
  if (!(await invoke<boolean>("path_exists", { path: `${root}/vendor/bin/sail` }))) return false;
  for (const file of COMPOSE_FILES) {
    const text = await invoke<string>("read_file", { path: `${root}/${file}` }).catch(() => "");
    if (/laravel\/sail|sail-\d/.test(text)) return true;
  }
  return false;
}

const docker = (root: string, args: string[]) => invoke<string>("run_capture", { cwd: root, program: "docker", args: ["compose", ...args], input: null });

/** Whether Sail's containers are up, so commands can run in them. */
export async function sailRunning(root: string): Promise<boolean> {
  if (!(await usesSail(root))) return false;
  const out = await docker(root, ["ps", "--status", "running", "--quiet"]).catch(() => "");
  return out.trim() !== "";
}

/** A Compose service that mounts the project, where the project is inside it, and whether it looks like PHP. */
export type Service = { name: string; workdir: string; php: boolean };
type ComposeConfig = { services?: Record<string, { image?: string; volumes?: { type: string; source?: string; target: string }[] }> };

/**
 * The services that bind-mount the project folder, from `docker compose config`, which resolves the compose
 * files, `.env`, and relative paths. One named or built for PHP comes first.
 */
export function servicesMounting(root: string, config: ComposeConfig): Service[] {
  const found: Service[] = [];
  for (const [name, service] of Object.entries(config.services ?? {})) {
    const mount = service.volumes?.find((v) => v.type === "bind" && v.source && (root === v.source || root.startsWith(`${v.source}/`)));
    if (mount) found.push({ name, workdir: mount.target + root.slice(mount.source!.length), php: /php|app|laravel/i.test(`${name} ${service.image ?? ""}`) });
  }
  return found.sort((a, b) => Number(b.php) - Number(a.php));
}

/**
 * The open project's chosen service: set with Choose Docker Service, or "" to run on this Mac. main.ts keeps it in
 * the project state (`dockerService`); it comes in from there so this file loads without the app's modules in tests.
 */
let choice = { get: (): string | undefined => undefined, set: (_name: string) => {} };
export const setServiceChoice = (c: typeof choice) => (choice = c);
const composeConfigs = new Map<string, Promise<Service[]>>();

/** The Compose services that could run the project's commands. Empty without a compose file or Docker; that isn't kept, so a compose file added later is found. */
export function composeServices(root: string): Promise<Service[]> {
  if (!composeConfigs.has(root))
    composeConfigs.set(
      root,
      docker(root, ["config", "--format", "json"]).then(
        (out) => servicesMounting(root, JSON.parse(out)),
        () => (composeConfigs.delete(root), []),
      ),
    );
  return composeConfigs.get(root)!;
}

/** Reads the compose files again next time, such as before choosing a service. */
export const forgetComposeServices = (root: string) => composeConfigs.delete(root);

/**
 * The Compose service commands run in, or null for this Mac: your choice, or else a service named or built for
 * PHP. A service that only mounts the project, such as a Node container for Vite, isn't picked on its own.
 */
export async function composeService(root: string): Promise<Service | null> {
  const services = await composeServices(root);
  const chosen = choice.get();
  if (chosen === "") return null;
  return services.find((s) => s.name === chosen) ?? services.find((s) => s.php) ?? null;
}

export function chooseService(root: string, name: string) {
  composeConfigs.delete(root); // Read the compose files again, in case they changed.
  choice.set(name);
}

/** Where the project is in the container of the last run, so paths in reports map back to this Mac. */
export let containerRoot = "/var/www/html";

/** How to run PHP commands in the project's running container. */
export type Container = {
  /** "Sail", or the Compose service's name, for tab titles. */
  label: string;
  sail: boolean;
  /**
   * A command line that runs `command` (`php …` or `vendor/bin/…`, relative to the project) in the container,
   * with `env` set, in a terminal (`tty`) or captured.
   */
  exec(command: string[], env?: string[], tty?: boolean): string[];
};

/** The container that runs the project's commands, when it's up: Sail's, or the chosen Compose service's. Otherwise null. */
export async function runningContainer(root: string): Promise<Container | null> {
  if (await sailRunning(root)) {
    containerRoot = "/var/www/html";
    const sail = `${root}/vendor/bin/sail`;
    // Through Sail's own commands, which pick its app service and a terminal. `sail debug` is Artisan with Xdebug's trigger set.
    const exec = (command: string[], env: string[] = []) => {
      const [program, ...args] = command;
      if (program === "php" && args[0] === "artisan") return [sail, env.includes("XDEBUG_MODE=debug") ? "debug" : "artisan", ...args.slice(1)];
      if (program === "php") return [sail, "php", ...args];
      if (program.startsWith("vendor/bin/")) return [sail, "bin", program.slice("vendor/bin/".length), ...args];
      return [sail, ...command];
    };
    return { label: "Sail", sail: true, exec };
  }
  const service = await composeService(root);
  if (!service) return null;
  const up = await docker(root, ["ps", "--status", "running", "--services"]).catch(() => "");
  if (!up.split("\n").includes(service.name)) return null;
  containerRoot = service.workdir;
  return {
    label: service.name,
    sail: false,
    exec: (command, env = [], tty = true) => ["docker", "compose", "exec", ...(tty ? [] : ["-T"]), "-w", service.workdir, ...env.flatMap((e) => ["-e", e]), service.name, ...command],
  };
}
