// Downloads the JSON schemas the editor bundles (src/schemas, used by src/jsonschemas.ts), minified. A `$ref` to a
// schema that isn't bundled becomes `{}`, which accepts anything, since the editor never downloads schemas.
// Usage: node scripts/fetch-schemas.ts
import { writeFileSync } from "node:fs";

const SCHEMAS: Record<string, string> = {
  composer: "https://getcomposer.org/schema.json",
  package: "https://json.schemastore.org/package.json",
  tsconfig: "https://json.schemastore.org/tsconfig.json",
  jsconfig: "https://json.schemastore.org/jsconfig.json",
  eslintrc: "https://json.schemastore.org/eslintrc.json",
  prettierrc: "https://www.schemastore.org/prettierrc.json",
  babelrc: "https://json.schemastore.org/babelrc.json",
  quikrun: "https://www.schemastore.org/quikrun.json",
};
const bundled = new Set(Object.keys(SCHEMAS).map((name) => `${name}.json`));
const dir = new URL("../src/schemas/", import.meta.url);

/** Replaces each `$ref` to another file with `{}`, unless that file is bundled. */
function dropForeignRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(dropForeignRefs);
  if (!node || typeof node !== "object") return node;
  const ref = (node as { $ref?: unknown }).$ref;
  if (typeof ref === "string" && !ref.startsWith("#") && !bundled.has(ref.replace(/#.*/, "").split("/").pop()!)) return {};
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, dropForeignRefs(v)]));
}

for (const [name, url] of Object.entries(SCHEMAS)) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  writeFileSync(new URL(`${name}.json`, dir), JSON.stringify(dropForeignRefs(await res.json())) + "\n");
  console.log(`Saved ${name}.json`);
}
