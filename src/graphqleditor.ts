// GraphQL completion and hovers from the endpoint's schema, for the HTTP tab's Query editor and GRAPHQL requests in
// .http files. The schema comes from an introspection query sent like the request itself (same URL, headers, and
// variables), once per endpoint for the session. Monaco's own `graphql` language highlights the query.
import { monaco } from "./editor";
import { contextAt, INTROSPECTION_QUERY, schemaFrom, type Schema } from "./graphqlschema";
import { host, prepareRequest, probe } from "./httpclient";
import { type HttpRequest, parseHttp } from "./httpfile";

const schemas = new Map<string, Promise<Schema | null>>();

/**
 * The schema of the request's endpoint, fetched on first use and kept by URL until you refresh it. A failed fetch
 * is kept too, so typing doesn't send a request per keystroke.
 */
export async function schemaFor(path: string, r: HttpRequest, refresh = false): Promise<Schema | null> {
  const { env, prepared } = await prepareRequest(path, { ...r, method: "GRAPHQL", body: INTROSPECTION_QUERY });
  const url = prepared.url;
  if (refresh) schemas.delete(url);
  let schema = schemas.get(url);
  if (!schema) {
    schema = probe(prepared, path, env, {}, true)
      .then((t) => {
        if (t.error) throw new Error(t.error);
        const s = schemaFrom(JSON.parse(t.body || "null"));
        if (!s) throw new Error(`the response (${t.heads.at(-1)?.status ?? "no status"}) has no schema`);
        host.status(`Loaded the GraphQL schema from ${url}: ${s.types.size} types`);
        return s;
      })
      .catch((e) => (host.status(`Couldn't load the GraphQL schema from ${url}: ${e instanceof Error ? e.message : e}`), null));
    schemas.set(url, schema);
  }
  return schema;
}

/** Where each Query editor's schema comes from. */
const sources = new WeakMap<monaco.editor.ITextModel, () => Promise<Schema | null>>();
export const attachSchema = (model: monaco.editor.ITextModel, get: () => Promise<Schema | null>) => sources.set(model, get);

const Kind = monaco.languages.CompletionItemKind;

function suggestions(schema: Schema, text: string, offset: number, range: monaco.IRange): monaco.languages.CompletionItem[] {
  const c = contextAt(schema, text, offset);
  if (c?.kind === "fields")
    return [
      ...c.type.fields.map((f) => ({ label: f.name, kind: Kind.Field, detail: f.type, documentation: f.description, insertText: f.name, range })),
      { label: "__typename", kind: Kind.Field, detail: "String!", insertText: "__typename", range, sortText: "~" },
    ];
  if (c?.kind === "args") return c.field.args.map((a) => ({ label: a.name, kind: Kind.Property, detail: a.type + (a.defaultValue ? ` = ${a.defaultValue}` : ""), documentation: a.description, insertText: `${a.name}: `, range }));
  return [];
}

function hover(schema: Schema, text: string, word: monaco.editor.IWordAtPosition, offset: number): string | null {
  const c = contextAt(schema, text, offset);
  const item = c?.kind === "fields" ? c.type.fields.find((f) => f.name === word.word) : c?.kind === "args" ? c.field.args.find((a) => a.name === word.word) : undefined;
  return item ? `**${item.name}**: \`${item.type}\`${item.description ? `\n\n${item.description}` : ""}` : null;
}

/** The GRAPHQL request's query around `position` in an .http file: its text from the body's first line, and the offset in it. */
async function queryAt(model: monaco.editor.ITextModel, position: monaco.Position) {
  const r = parseHttp(model.getValue()).requests.find((q) => q.start <= position.lineNumber && position.lineNumber <= q.end);
  if (!r || r.method !== "GRAPHQL") return null;
  let first = r.line + 1;
  while (first <= r.end && model.getLineContent(first).trim()) first++;
  if (position.lineNumber <= first) return null;
  const start = model.getOffsetAt({ lineNumber: first, column: 1 });
  // ponytail: the variables JSON after the query reads as another selection set; skip it if it gets in the way.
  return { schema: await schemaFor(model.uri.fsPath, r), text: model.getValueInRange(new monaco.Range(first, 1, r.end, model.getLineMaxColumn(r.end))), offset: model.getOffsetAt(position) - start };
}

async function queryFor(model: monaco.editor.ITextModel, position: monaco.Position) {
  if (model.getLanguageId() === "http") return queryAt(model, position);
  const get = sources.get(model);
  return get ? { schema: await get(), text: model.getValue(), offset: model.getOffsetAt(position) } : null;
}

for (const language of ["graphql", "http"]) {
  monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters: ["{", "(", ","],
    provideCompletionItems: async (model, position) => {
      const q = await queryFor(model, position);
      if (!q?.schema) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      return { suggestions: suggestions(q.schema, q.text, q.offset, new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)) };
    },
  });
  monaco.languages.registerHoverProvider(language, {
    provideHover: async (model, position) => {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const start = new monaco.Position(position.lineNumber, word.startColumn);
      const q = await queryFor(model, start);
      const text = q?.schema && hover(q.schema, q.text, word, q.offset);
      return text ? { range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn), contents: [{ value: text }] } : null;
    },
  });
}
