// Your own snippets (PhpStorm's live templates), in snippets.json in the app's config folder. The format is
// VS Code's: a name maps to a prefix, a body with $1 tab stops, and an optional description and scope.
import { invoke } from "@tauri-apps/api/core";
import { appConfigDir } from "@tauri-apps/api/path";
import { monaco } from "./editor";

type Snippet = { prefix: string | string[]; body: string | string[]; description?: string; scope?: string };

const EXAMPLE = `{
  "Laravel route": {
    "scope": "php",
    "prefix": "rget",
    "body": ["Route::get('/\${1:path}', [\${2:Controller}::class, '\${3:index}'])->name('\${4:name}');"],
    "description": "A GET route to a controller method"
  },
  "Dump and die": {
    "scope": "php,blade",
    "prefix": "dd",
    "body": "dd(\${1:\\\\$var});"
  }
}
`;

let file = "";
let saved: Record<string, Snippet> = {};

/** The snippets: from the open editor tab while you edit the file, so changes apply as you type. */
function snippets(): Record<string, Snippet> {
  const model = file && monaco.editor.getModel(monaco.Uri.file(file));
  if (model) {
    try {
      saved = JSON.parse(model.getValue());
    } catch {
      // Keep the last snippets that parsed.
    }
  }
  return saved;
}

/** Opens snippets.json, creating it with examples the first time. */
export async function editSnippets(openFile: (path: string) => unknown) {
  if (!(await invoke<boolean>("path_exists", { path: file }))) {
    await invoke("create_dir", { path: file.slice(0, file.lastIndexOf("/")) });
    await invoke("write_file", { path: file, contents: EXAMPLE });
  }
  openFile(file);
}

export async function initSnippets() {
  file = `${await appConfigDir()}/snippets.json`;
  try {
    saved = JSON.parse(await invoke<string>("read_file", { path: file }));
  } catch {
    // No snippets yet, or the file doesn't parse: Edit Snippets shows the error.
  }
  monaco.languages.registerCompletionItemProvider("*", {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const language = model.getLanguageId();
      const suggestions = Object.entries(snippets())
        .filter(([, s]) => !s.scope || s.scope.split(",").map((l) => l.trim()).includes(language))
        .flatMap(([name, s]) =>
          [s.prefix].flat().map((prefix) => ({
            label: { label: prefix, description: name },
            kind: monaco.languages.CompletionItemKind.Snippet,
            documentation: s.description,
            insertText: [s.body].flat().join("\n"),
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          })),
        );
      return { suggestions };
    },
  });
}
