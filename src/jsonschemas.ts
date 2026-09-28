// Checks common JSON config files against schemas bundled with the app (src/schemas, from schemastore.org and
// getcomposer.org, and Tusk's own tusk.json), and a file against a local schema it names in `$schema`. Nothing is downloaded.
import { invoke } from "@tauri-apps/api/core";
import * as monaco from "monaco-editor";
import { localSchemaPath } from "./links";

type Schema = { uri: string; fileMatch?: string[]; schema?: unknown };

/**
 * Each schema's URI is its `$id` or published URL, so a file whose `$schema` names that URL, and a schema whose
 * `$ref` does (package.json's to prettierrc and quikrun), gets the bundled copy.
 */
const BUNDLED: [string, string[], () => Promise<{ default: unknown }>][] = [
  ["https://getcomposer.org/schema.json", ["composer.json"], () => import("./schemas/composer.json")],
  ["https://json.schemastore.org/package.json", ["package.json"], () => import("./schemas/package.json")],
  ["https://json.schemastore.org/tsconfig", ["tsconfig.json", "tsconfig.*.json"], () => import("./schemas/tsconfig.json")],
  ["https://json.schemastore.org/jsconfig.json", ["jsconfig.json"], () => import("./schemas/jsconfig.json")],
  ["https://json.schemastore.org/eslintrc.json", [".eslintrc.json"], () => import("./schemas/eslintrc.json")],
  ["https://www.schemastore.org/prettierrc.json", [".prettierrc.json"], () => import("./schemas/prettierrc.json")],
  ["https://json.schemastore.org/babelrc.json", [".babelrc.json", "babel.config.json"], () => import("./schemas/babelrc.json")],
  ["https://www.schemastore.org/quikrun.json", [], () => import("./schemas/quikrun.json")],
  // Tusk's own: the project settings a team shares (projectstate.ts).
  ["https://raw.githubusercontent.com/almontasser/tusk/main/src/schemas/tusk.json", ["tusk.json"], () => import("./schemas/tusk.json")],
];

let bundled: Promise<Schema[]> | undefined;
/** Local schemas that files name, by the schema file's URI. */
const local = new Map<string, unknown>();

async function apply() {
  const schemas = [...(await bundled!), ...[...local].map(([uri, schema]) => ({ uri, schema }))];
  monaco.json.jsonDefaults.setDiagnosticsOptions({ ...monaco.json.jsonDefaults.diagnosticsOptions, validate: true, enableSchemaRequest: false, schemas });
}

/** Reads the local schema a JSON model names, the first time it's named. The schemas load with the first JSON file. */
function check(model: monaco.editor.ITextModel) {
  if (model.getLanguageId() !== "json" || model.uri.scheme !== "file") return;
  if (!bundled) (bundled = Promise.all(BUNDLED.map(async ([uri, fileMatch, load]) => ({ uri, fileMatch, schema: (await load()).default })))), apply();
  const path = model.uri.path;
  const file = localSchemaPath(model.getValue(), path.slice(0, path.lastIndexOf("/")));
  const uri = file && monaco.Uri.file(file).toString();
  if (!uri || local.has(uri)) return;
  local.set(uri, undefined);
  invoke<string>("read_file", { path: file })
    .then(JSON.parse)
    .then((schema) => (local.set(uri, schema), apply()), () => local.delete(uri));
}

/** Starts checking JSON files against their schemas. */
export function initJsonSchemas() {
  monaco.editor.getModels().forEach(check);
  monaco.editor.onDidCreateModel((model) => {
    check(model);
    let timer: ReturnType<typeof setTimeout> | undefined;
    model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (model.isDisposed()) return;
        check(model);
        // An open local schema applies its edits as you make them.
        const uri = model.uri.toString();
        if (local.get(uri) !== undefined) {
          try {
            local.set(uri, JSON.parse(model.getValue()));
            apply();
          } catch {
            // Half-typed JSON: keep the last schema that parsed.
          }
        }
      }, 500);
    });
  });
}
