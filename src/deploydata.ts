// Deployment's data: servers as tusk.json keeps them, where a project file goes on a server and back, and the
// texts the UI shows. No DOM or Tauri here, so the tests can run it (deploydata.test.ts).

export type Protocol = "sftp" | "ftp" | "ftps" | "ftps-implicit";
export type Auth = "password" | "key" | "agent";

/** A project folder (relative to the project, "" for all of it) and where it goes on the server: a path relative
 * to the server's root path, or an absolute one. */
export type Mapping = { local: string; remote: string };

/** A server, as `deploymentServers` keeps it in tusk.json or on this computer. Never a password: those are in the
 * system's password store, by project and server name. */
export type DeployServer = {
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  user: string;
  /** SFTP's login: a password, a key file (or ~/.ssh's usual keys), or the SSH agent. */
  auth: Auth;
  keyFile: string;
  /** FTP's passive mode, which works through firewalls; active mode has the server connect back. */
  passive: boolean;
  /** FTPS without checking the certificate, for a self-signed one. */
  insecureTls: boolean;
  /** The folder on the server that mappings are relative to, such as /var/www/app. "" is the login folder. */
  rootPath: string;
  /** The site's address, such as https://staging.example.com, for opening a deployed file in the browser. */
  webUrl: string;
  mappings: Mapping[];
  /** Paths that are never uploaded or downloaded, relative to a mapping's folder (deploy.rs's `Excludes`). */
  excludes: string[];
  /** Whether deleting a project file deletes it from the server too, when saved files upload to this server. */
  deleteRemote: boolean;
};

/** A `Host` alias from ~/.ssh/config, as sshconfig.rs resolves it. */
export type SshAlias = {
  alias: string;
  hostName: string | null;
  port: number | null;
  user: string | null;
  identityFiles: string[];
  identitiesOnly: boolean;
  proxyJump: string[];
  proxyCommand?: string | null;
  hostKeyAlias?: string | null;
  /** A `Match exec` block would have applied; Tusk doesn't run its command. */
  matchExecSkipped?: boolean;
};

/** What an alias connects to, in words: `forge@203.0.113.5:2222 · through bastion · key ~/.ssh/staging`. */
export function describeAlias(a: SshAlias, home = ""): string {
  const tilde = (p: string) => (home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
  const where = `${a.user ? `${a.user}@` : ""}${a.hostName ?? a.alias}${a.port && a.port !== 22 ? `:${a.port}` : ""}`;
  const through = a.proxyJump.length ? `through ${a.proxyJump.join(", ")}` : a.proxyCommand ? `through ${a.proxyCommand}` : "";
  return [where, through, a.identityFiles.length ? `key ${a.identityFiles.map(tilde).join(", ")}` : "", a.hostKeyAlias ? `host key as ${a.hostKeyAlias}` : ""].filter(Boolean).join(" · ");
}

/** When a saved file goes to the default server: never, on ⌘S (an explicit save), or on every save, auto-save too. */
export type UploadOnSave = "never" | "explicit" | "always";

export const PROTOCOLS: [Protocol, string][] = [
  ["sftp", "SFTP"],
  ["ftp", "FTP"],
  ["ftps", "FTPS (explicit TLS)"],
  ["ftps-implicit", "FTPS (implicit TLS)"],
];

export const DEFAULT_PORTS: Record<Protocol, number> = { sftp: 22, ftp: 21, ftps: 21, "ftps-implicit": 990 };

/** What a Laravel project shouldn't send to a server: tools' folders, secrets, and what the server writes itself. */
export const DEFAULT_EXCLUDES = [".git", ".idea", ".vscode", ".DS_Store", "node_modules", ".env", "storage", "bootstrap/cache"];
/** Offered with one click in the settings. */
export const SUGGESTED_EXCLUDES = ["vendor", "tests", "*.log", ".env.*", "tusk.json", "public/hot"];

export const newServer = (name: string): DeployServer => ({
  name,
  protocol: "sftp",
  host: "",
  port: 22,
  user: "",
  auth: "agent",
  keyFile: "",
  passive: true,
  insecureTls: false,
  rootPath: "",
  webUrl: "",
  mappings: [{ local: "", remote: "" }],
  excludes: [...DEFAULT_EXCLUDES],
  deleteRemote: false,
});

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);

/** Servers from a stored value, leaving out anything malformed, such as after a bad merge of tusk.json. */
export function readServers(value: unknown): DeployServer[] {
  if (!Array.isArray(value)) return [];
  const servers: DeployServer[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object" || typeof v.name !== "string" || !v.name || servers.some((s) => s.name === v.name)) continue;
    const protocol = PROTOCOLS.some(([p]) => p === v.protocol) ? (v.protocol as Protocol) : "sftp";
    const port = Number(v.port);
    servers.push({
      name: v.name,
      protocol,
      host: str(v.host),
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORTS[protocol],
      user: str(v.user),
      auth: (["password", "key", "agent"] as Auth[]).includes(v.auth) ? v.auth : "agent",
      keyFile: str(v.keyFile),
      passive: v.passive !== false,
      insecureTls: v.insecureTls === true,
      rootPath: str(v.rootPath),
      webUrl: str(v.webUrl),
      mappings: Array.isArray(v.mappings) ? v.mappings.filter((m: unknown) => m && typeof m === "object").map((m: Record<string, unknown>) => ({ local: str(m.local), remote: str(m.remote) })) : [{ local: "", remote: "" }],
      excludes: Array.isArray(v.excludes) ? v.excludes.filter((e: unknown): e is string => typeof e === "string") : [...DEFAULT_EXCLUDES],
      deleteRemote: v.deleteRemote === true,
    });
  }
  return servers;
}

/** A server as tusk.json keeps it: default values left out, so the file stays short. */
export function writeServer(s: DeployServer): Record<string, unknown> {
  const out: Record<string, unknown> = { name: s.name, protocol: s.protocol, host: s.host };
  if (s.port !== DEFAULT_PORTS[s.protocol]) out.port = s.port;
  if (s.user) out.user = s.user;
  if (s.protocol === "sftp") {
    out.auth = s.auth;
    if (s.auth === "key" && s.keyFile) out.keyFile = s.keyFile;
  } else {
    if (!s.passive) out.passive = false;
    if (s.protocol !== "ftp" && s.insecureTls) out.insecureTls = true;
  }
  if (s.rootPath) out.rootPath = s.rootPath;
  if (s.webUrl) out.webUrl = s.webUrl;
  out.mappings = s.mappings;
  out.excludes = s.excludes;
  if (s.deleteRemote) out.deleteRemote = true;
  return out;
}

/** Why a server can't be saved, or "". */
export function serverProblem(s: DeployServer, others: DeployServer[]): string {
  if (!s.name.trim()) return "Type a name.";
  if (others.some((o) => o !== s && o.name === s.name)) return `Another server is named ${s.name}.`;
  if (!s.host.trim()) return `Type ${s.name}'s host.`;
  if (/[\s/]/.test(s.host.trim()) || /^[a-z]+:\/\//i.test(s.host)) return `${s.name}'s host is a name or address only, such as example.com or 203.0.113.5.`;
  if (!s.mappings.length) return `Add a mapping to ${s.name}, so Tusk knows where the project goes.`;
  const locals = s.mappings.map((m) => trimSlashes(m.local));
  if (new Set(locals).size !== locals.length) return `${s.name} maps one project folder twice.`;
  if (locals.some((l) => l.startsWith("../") || l === ".." || l.startsWith("/"))) return `${s.name}'s mappings use folders inside the project, relative to it.`;
  return "";
}

const trimSlashes = (p: string) => p.trim().replace(/^\.(\/|$)/, "").replace(/\/+$/, "");

/** `/`-joined, without `.` segments, doubled slashes, or a trailing slash. Absolute when the first part is; ""
 * stays relative to the login folder. */
export function joinRemote(...parts: string[]): string {
  const absolute = parts[0]?.trim().startsWith("/") ?? false;
  const segments: string[] = [];
  for (const part of parts)
    for (const seg of part.trim().split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === ".." && segments.length && segments.at(-1) !== "..") segments.pop();
      else segments.push(seg);
    }
  return (absolute ? "/" : "") + segments.join("/");
}

/** Where a mapping's folder is on the server. */
export const mappingRemote = (s: DeployServer, m: Mapping) => (m.remote.trim().startsWith("/") ? joinRemote(m.remote) : joinRemote(s.rootPath, m.remote));

/** Where a mapping's folder is in the project, as an absolute path. */
export const mappingLocal = (root: string, m: Mapping) => (trimSlashes(m.local) ? `${root}/${trimSlashes(m.local)}` : root);

export type Placed = { mapping: Mapping; local: string; remote: string; localRoot: string; remoteRoot: string };

/** Where a project file or folder goes on a server, through the mapping with the deepest folder; null when no
 * mapping covers it. */
export function remoteFor(s: DeployServer, root: string, local: string): Placed | null {
  let best: Placed | null = null;
  for (const m of s.mappings) {
    const localRoot = mappingLocal(root, m);
    if (local !== localRoot && !local.startsWith(`${localRoot}/`)) continue;
    if (best && best.localRoot.length >= localRoot.length) continue;
    const remoteRoot = mappingRemote(s, m);
    best = { mapping: m, local, localRoot, remoteRoot, remote: joinRemote(remoteRoot, local.slice(localRoot.length)) };
  }
  return best;
}

/** Where a server's file goes in the project, through the mapping with the deepest server folder; null when no
 * mapping covers it. Relative server paths are compared as relative paths, absolute ones as absolute. */
export function localFor(s: DeployServer, root: string, remote: string): Placed | null {
  remote = joinRemote(remote);
  let best: Placed | null = null;
  for (const m of s.mappings) {
    const remoteRoot = mappingRemote(s, m);
    const inside = remoteRoot === "" ? !remote.startsWith("/") : remote === remoteRoot || remote.startsWith(remoteRoot === "/" ? "/" : `${remoteRoot}/`);
    if (!inside || (best && best.remoteRoot.length >= remoteRoot.length)) continue;
    const rest = remote.slice(remoteRoot.length).replace(/^\//, "");
    const localRoot = mappingLocal(root, m);
    best = { mapping: m, remote, remoteRoot, localRoot, local: rest ? `${localRoot}/${rest}` : localRoot };
  }
  return best;
}

/** The web address of a deployed file, from the server's web URL and the file's path below the root path. */
export function webUrlFor(s: DeployServer, remote: string): string | null {
  if (!s.webUrl) return null;
  const root = joinRemote(s.rootPath);
  let rest = remote;
  if (root) {
    if (remote !== root && !remote.startsWith(root === "/" ? "/" : `${root}/`)) return null;
    rest = remote.slice(root.length);
  }
  // Laravel serves public/ at the site's root.
  rest = rest.replace(/^\/?public(\/|$)/, "/");
  return `${s.webUrl.replace(/\/+$/, "")}/${rest.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Why the server's key wasn't trusted, from deploy.rs's `host-key:{…}` error. `host` and `port` are what
 * known_hosts keeps it under: a HostKeyAlias (`alias`) with port 22, or the server's; `shown` names the server.
 */
export type HostKeyProblem = { kind: "unknown" | "changed"; host: string; port: number; shown?: string; alias?: string | null; algorithm: string; fingerprint: string; key: string; line: number | null };

/** The JSON after `tag` in an error, such as deploy.rs's `host-key:{…}`. */
function tagged(error: string, tag: string): Record<string, unknown> | null {
  const at = error.indexOf(tag);
  if (at < 0) return null;
  try {
    const p = JSON.parse(error.slice(at + tag.length));
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}

export function hostKeyProblem(error: string): HostKeyProblem | null {
  const p = tagged(error, "host-key:");
  return p && (p.kind === "unknown" || p.kind === "changed") && typeof p.key === "string" ? (p as HostKeyProblem) : null;
}

/** What a jump host asks for that Tusk doesn't have saved, or that it refused, from deploy.rs's `ssh-login:{…}`. */
export type LoginNeeded = { target: string; hop: string; host: string; port: number; user: string; account: string; kind: "password" | "passphrase"; key: string | null; wrong: boolean };

export function loginNeeded(error: string): LoginNeeded | null {
  const p = tagged(error, "ssh-login:");
  return p && (p.kind === "password" || p.kind === "passphrase") && typeof p.account === "string" ? (p as LoginNeeded) : null;
}

/** The folders between `stop` and each path, deepest first, each once: the ones deleting the paths may empty. */
export function foldersBetween(paths: string[], stop: string): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    if (path !== stop && !path.startsWith(stop === "/" ? "/" : `${stop}/`)) continue;
    for (let dir = path.slice(0, path.lastIndexOf("/")); dir.length > stop.length; dir = dir.slice(0, dir.lastIndexOf("/"))) folders.add(dir);
  }
  return [...folders].sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
}

/** A file as deploy.rs lists it: its path below a folder, size, and modification time in seconds. */
export type FileInfoLike = { path: string; size: number; mtime: number };

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

/** A time in seconds since 1970 as a short local date and time, or "" for none. */
export const formatTime = (secs: number, now = Date.now()) => {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) + ` ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
};

/** A list of paths for a confirmation: all of them up to `max`, then how many more. */
export function listSome(paths: string[], max = 12): { shown: string[]; more: number } {
  return paths.length <= max ? { shown: paths, more: 0 } : { shown: paths.slice(0, max - 1), more: paths.length - max + 1 };
}

/** Errors worth retrying on their own: the network's, not the server's refusals. */
export const transient = (error: string) => /timed out|didn't answer|reset|broken pipe|closed|disconnect|eof|connection (aborted|lost)|not connected|channel/i.test(error) && !/permission|refused the|denied|doesn't exist|550/i.test(error);
