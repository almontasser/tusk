// Laravel Sail: when a project's compose file uses Sail and its containers are running, tests and
// Artisan run inside the container through vendor/bin/sail.
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

/** Whether Sail's containers are up, so commands can run in them. */
export async function sailRunning(root: string): Promise<boolean> {
  if (!(await usesSail(root))) return false;
  const out = await invoke<string>("run_capture", { cwd: root, program: "docker", args: ["compose", "ps", "--status", "running", "--quiet"], input: null }).catch(() => "");
  return out.trim() !== "";
}
