// Publishes the language tools the app downloads (see tools_ensure in src-tauri/src/tools.rs), so tools
// update without an app release. It fetches each chip's tools with fetch-tools.sh, packs each tool whose files
// changed since the last publish, and uploads them with a tools.json listing every package, signed with the
// updater's key from Bitwarden (bwnote), to the `tools` GitHub release.
// Usage: node scripts/publish-tools.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Package = { name: string; arch: string; id: string; url: string; sha256: string; size: number };

const REPO = "almontasser/tusk";
const TAG = "tools";
const base = `https://github.com/${REPO}/releases/download/${TAG}`;
const root = new URL("..", import.meta.url).pathname;
const stage = join(root, "src-tauri/target/tools-stage");
const out = join(root, "src-tauri/target/tools-publish");
/** Each tool's folder, and whether it's built per chip. */
const TOOLS: [string, boolean][] = [
  ["composer", false], ["php-debug", false],
  ["mago", true], ["typos-lsp", true], ["node", true], ["llama", true],
];
const ARCHS = ["aarch64", "x86_64"];

const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });

/** A hash of a folder's paths, contents, executable bits, and symlinks, which changes only when the tool does. */
function contentId(dir: string) {
  const hash = createHash("sha256");
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = join(rel, name);
      const stat = lstatSync(join(dir, path));
      if (stat.isSymbolicLink()) hash.update(`L ${path} ${readlinkSync(join(dir, path))}\n`);
      else if (stat.isDirectory()) walk(path);
      else hash.update(`F ${path} ${stat.mode & 0o111 ? "x" : "-"}\n`).update(readFileSync(join(dir, path)));
    }
  };
  walk("");
  return hash.digest("hex").slice(0, 16);
}

// The key first, so a locked vault stops the script before any work. bwnote's unlock message can come first.
const key = execFileSync("zsh", ["-ic", "bwnote tusk-signing-key"], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trim().split("\n").at(-1) ?? "";
if (!/^[A-Za-z0-9+/]{100,}=*$/.test(key)) throw new Error("Couldn't read tusk-signing-key with bwnote.");

for (const arch of ARCHS) run("sh", ["scripts/fetch-tools.sh", `${arch}-apple-darwin`], { TOOLS_DEST: join(stage, arch) });

const published = await fetch(`${base}/tools.json`).then((r) => (r.ok ? r.json() : { packages: [] }), () => ({ packages: [] }));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const packages: Package[] = [];
const uploads: string[] = [];
for (const [name, native] of TOOLS) {
  for (const arch of native ? ARCHS : ["any"]) {
    const dir = join(stage, native ? arch : ARCHS[0], name);
    const id = contentId(dir);
    const same = (published.packages as Package[]).find((p) => p.name === name && p.arch === arch && p.id === id);
    if (same) {
      packages.push(same);
      continue;
    }
    const file = join(out, `${name}-${arch}-${id}.tar.gz`);
    // COPYFILE_DISABLE keeps macOS's ._ metadata files out of the archive.
    run("tar", ["-czf", file, "-C", dir, "."], { COPYFILE_DISABLE: "1" });
    const data = readFileSync(file);
    packages.push({ name, arch, id, url: `${base}/${file.split("/").at(-1)}`, sha256: createHash("sha256").update(data).digest("hex"), size: data.length });
    uploads.push(file);
    console.log(`Packed ${name} (${arch}), ${(data.length / 2 ** 20).toFixed(1)} MB`);
  }
}
/** Deletes the packages tools.json no longer lists. A copy that read the old list moments before retries next time. */
function deleteUnlisted() {
  const listed = new Set(packages.map((p) => p.url.split("/").at(-1)));
  const assets = execFileSync("gh", ["release", "view", TAG, "-R", REPO, "--json", "assets", "-q", ".assets[].name"], { encoding: "utf8" }).split("\n");
  for (const name of assets.filter((a) => a.endsWith(".tar.gz") && !listed.has(a))) {
    run("gh", ["release", "delete-asset", TAG, name, "-R", REPO, "-y"]);
  }
}

if (!uploads.length && published.packages.length) {
  console.log("Every tool is already published.");
  deleteUnlisted();
  process.exit(0);
}

const manifest = join(out, "tools.json");
writeFileSync(manifest, JSON.stringify({ packages }, null, 2) + "\n");
run("pnpm", ["tauri", "signer", "sign", manifest], { TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" });

// A prerelease, so the app's updater, which reads the latest release, never picks it.
try {
  execFileSync("gh", ["release", "view", TAG, "-R", REPO], { stdio: "ignore" });
} catch {
  run("gh", ["release", "create", TAG, "-R", REPO, "--prerelease", "--title", "Language tools", "--notes", "The language tools Tusk downloads. Published by scripts/publish-tools.ts."]);
}
// Packages first, so tools.json never lists a file that isn't there yet.
if (uploads.length) run("gh", ["release", "upload", TAG, "-R", REPO, ...uploads]);
run("gh", ["release", "upload", TAG, "-R", REPO, "--clobber", manifest, `${manifest}.sig`]);
deleteUnlisted();
