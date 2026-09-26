// Reads a GraphQL schema from an introspection result and finds what the cursor is in: a selection set of some
// type, or a field's arguments. Free of editor imports so Node can test it.

/** The standard introspection query, trimmed to what completion and hovers use. */
export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind name description
      fields(includeDeprecated: true) { name description type { ...TypeRef } args { name description defaultValue type { ...TypeRef } } }
      inputFields { name description defaultValue type { ...TypeRef } }
      enumValues(includeDeprecated: true) { name description }
    }
  }
}
fragment TypeRef on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }`;

type TypeRef = { kind: string; name: string | null; ofType?: TypeRef | null };
export type Arg = { name: string; description: string; type: string; defaultValue: string | null };
export type Field = { name: string; description: string; type: string; typeName: string; args: Arg[] };
export type GqlType = { name: string; kind: string; description: string; fields: Field[] };
export type Schema = { query?: string; mutation?: string; subscription?: string; types: Map<string, GqlType> };

/** A type reference as GraphQL writes it, such as `[User!]!`. */
const typeString = (t: TypeRef): string => (t.kind === "NON_NULL" ? `${typeString(t.ofType!)}!` : t.kind === "LIST" ? `[${typeString(t.ofType!)}]` : (t.name ?? "?"));
/** The named type inside NON_NULL and LIST wrappers. */
const namedType = (t: TypeRef): string => (t.ofType ? namedType(t.ofType) : (t.name ?? ""));

type RawField = { name: string; description?: string | null; type: TypeRef; args?: { name: string; description?: string | null; defaultValue?: string | null; type: TypeRef }[] };
type Raw = { data?: { __schema?: Raw["__schema"] }; __schema?: { queryType?: { name: string } | null; mutationType?: { name: string } | null; subscriptionType?: { name: string } | null; types: { kind: string; name: string; description?: string | null; fields?: RawField[] | null; inputFields?: RawField[] | null }[] } };

/** The schema in an introspection response, with or without its `data` wrapper. Null when it has none. */
export function schemaFrom(json: unknown): Schema | null {
  const raw = json as Raw;
  const s = raw?.data?.__schema ?? raw?.__schema;
  if (!s?.types) return null;
  const types = new Map<string, GqlType>();
  for (const t of s.types) {
    const fields = (t.fields ?? t.inputFields ?? []).map((f) => ({
      name: f.name,
      description: f.description ?? "",
      type: typeString(f.type),
      typeName: namedType(f.type),
      args: (f.args ?? []).map((a) => ({ name: a.name, description: a.description ?? "", type: typeString(a.type), defaultValue: a.defaultValue ?? null })),
    }));
    types.set(t.name, { name: t.name, kind: t.kind, description: t.description ?? "", fields });
  }
  return { query: s.queryType?.name, mutation: s.mutationType?.name, subscription: s.subscriptionType?.name, types };
}

export type Context = { kind: "fields"; type: GqlType } | { kind: "args"; type: GqlType; field: Field } | null;

const TOKEN = /#[^\n]*|"""[\s\S]*?(?:"""|$)|"(?:[^"\\\n]|\\.)*"?|\.\.\.|\$?[_A-Za-z]\w*|-?\d[\w.+-]*|\S/g;

/**
 * What `offset` in a GraphQL document is in: the selection set of a type, where fields go, or the arguments of a
 * field, where argument names go. Walks the document from the start, following operations, fragments, inline
 * fragments, and each field's type. Null anywhere else, such as in an argument's value or a string.
 */
export function contextAt(schema: Schema, text: string, offset: number): Context {
  // Leave out the word being typed, so it doesn't count as a field or argument.
  const before = text.slice(0, offset).replace(/\w+$/, "");
  const stack: (GqlType | undefined)[] = [];
  let operation = "query";
  let field = ""; // The last field name in the selection set, which a { or ( belongs to.
  let on = false; // The next name is a type condition.
  let condition = "";
  let directive = false;
  // Inside a field's (…): its field, the depth of ( [ {, and whether a name comes next.
  let args: { field?: Field; depth: number; name: boolean } | null = null;
  let last = "";
  for (const [token] of before.matchAll(TOKEN)) {
    if (token.startsWith("#")) continue;
    const block = token.startsWith('"""');
    if (token.startsWith('"') && (block ? token.length < 6 || !token.endsWith('"""') : token.length < 2 || !token.endsWith('"'))) return null; // In a string.
    if (args) {
      if ("([{".includes(token)) args.depth++;
      else if (")]}".includes(token)) {
        if (--args.depth === 0) args = null;
        else if (args.depth === 1) args.name = true;
      } else if (args.depth === 1) {
        if (token === ":") args.name = false;
        else if (token === ",") args.name = true;
        else if (!args.name) args.name = true; // A value ends; the next name may follow without a comma.
      }
      last = token;
      continue;
    }
    const top = stack.at(-1);
    if (token === "{") {
      const root = { query: schema.query, mutation: schema.mutation, subscription: schema.subscription }[operation];
      const name = condition || (stack.length ? top?.fields.find((f) => f.name === field)?.typeName : root);
      stack.push(name ? schema.types.get(name) : undefined);
      field = condition = "";
      directive = false;
    } else if (token === "}") {
      stack.pop();
      field = "";
      if (!stack.length) operation = "query";
    } else if (token === "(") {
      const f = stack.length && !directive ? top?.fields.find((x) => x.name === field) : undefined;
      args = { field: f, depth: 1, name: true };
      directive = false;
    } else if (token === "@") directive = true;
    else if (token === "...") on = false;
    else if (/^[_A-Za-z]/.test(token)) {
      if (directive && last === "@") {
        last = token;
        continue;
      }
      directive = false;
      if (on) (condition = token), (on = false);
      else if (token === "on" && (last === "..." || !stack.length)) on = true;
      else if (!stack.length && ["query", "mutation", "subscription"].includes(token)) operation = token;
      else if (stack.length) field = token;
    }
    last = token;
  }
  if (args) return args.field && args.name && args.depth === 1 && stack.at(-1) ? { kind: "args", type: stack.at(-1)!, field: args.field } : null;
  const type = stack.at(-1);
  return type && !on ? { kind: "fields", type } : null;
}
