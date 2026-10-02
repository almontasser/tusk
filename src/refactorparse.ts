// Text-level PHP helpers: brackets and top-level commas, and the Change Signature dialog's checks. Free of editor
// imports so Node can test it. ponytail: a scanner for brackets and strings, not a PHP parser; heredocs aren't
// handled. Tusk's server rewrites the code itself (`signature.rs`).

/**
 * Where a string or comment that starts at `i` ends (its last character), or -1 when none starts there, so a
 * quote in `// don't` doesn't open a string. `#[` is an attribute, not a comment.
 */
function skipQuoted(text: string, i: number): number {
  const c = text[i];
  if (c === "'" || c === '"') {
    for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    return i;
  }
  if ((c === "/" && text[i + 1] === "/") || (c === "#" && text[i + 1] !== "[")) {
    const end = text.indexOf("\n", i);
    return end < 0 ? text.length : end - 1;
  }
  if (c === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end < 0 ? text.length : end + 1;
  }
  return -1;
}

/** The index of the bracket that closes the one at `open`, skipping strings, comments, and nested brackets. -1 if none. */
export function matchBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    const skip = skipQuoted(text, i);
    if (skip >= 0) i = skip;
    else if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** Splits at commas that aren't inside brackets or strings, trimming each part. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const skip = skipQuoted(text, i);
    if (skip >= 0) i = skip;
    else if ("([{".includes(c)) {
      const end = matchBracket(text, i);
      if (end < 0) break;
      i = end;
    } else if (c === ",") {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p, i, all) => p || i < all.length - 1);
}

/**
 * A parameter. `type` is everything before the name: attributes, a promoted property's modifiers, and the type.
 * In a new signature, `from` is the old parameter's name, and `callValue` the value to pass in existing calls
 * for a new parameter (its default value when unset).
 */
export type Param = { text: string; name: string; type: string; byRef: boolean; defaultValue?: string; variadic: boolean; from?: string; callValue?: string };

/** A parameter's declaration, as `private readonly int &...$name = 1`. */
const paramText = (p: Param) => `${p.type ? `${p.type} ` : ""}${p.byRef ? "&" : ""}${p.variadic ? "..." : ""}$${p.name}${p.defaultValue !== undefined && p.defaultValue !== "" ? ` = ${p.defaultValue}` : ""}`;

// ---- Change Signature ----

export type Signature = { modifiers: string; name: string; returnType: string; params: Param[] };
const IDENTIFIER = /^[A-Za-z_\x80-\uffff][\w\x80-\uffff]*$/;

/** The declaration a signature writes, for the preview line. */
export const signatureText = (s: Signature) =>
  `${s.modifiers ? `${s.modifiers} ` : ""}function ${s.name}(${s.params.map(paramText).join(", ")})${s.returnType ? `: ${s.returnType}` : ""}`;

/** What's wrong with a signature, or null. `before` is the old one, for parameters that must keep their name. */
export function signatureProblem(s: Signature, before: Signature, kind: "method" | "function" | "constructor"): string | null {
  if (!IDENTIFIER.test(s.name)) return "The name must be a valid PHP name.";
  const names = s.params.map((p) => p.name);
  const bad = s.params.find((p) => !IDENTIFIER.test(p.name));
  if (bad) return bad.name ? `$${bad.name} isn't a valid parameter name.` : "Each parameter needs a name.";
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) return `Two parameters are named $${twice}.`;
  const variadic = s.params.findIndex((p) => p.variadic);
  if (variadic >= 0 && variadic < s.params.length - 1) return `The variadic parameter $${s.params[variadic].name} must come last.`;
  for (const p of s.params) {
    if (!p.from && !p.defaultValue && !p.callValue && !p.variadic) return `The new parameter $${p.name} needs a default value or a value for existing calls.`;
    const old = before.params.find((o) => o.name === p.from);
    // A promoted property's name is also a property name; Rename (⇧F6) changes both.
    if (kind === "constructor" && old && p.name !== old.name && /\b(public|protected|private|readonly)\b/.test(old.type)) return `$${old.name} is a promoted property. Rename it with Rename (⇧F6).`;
  }
  return null;
}

/** A signature PHP accepts but deprecates: an optional parameter before a required one acts as required. */
export function signatureWarning(s: Signature): string | null {
  const isRequired = (p: Param) => !p.defaultValue && !p.variadic;
  const optional = s.params.findIndex((p, i) => !isRequired(p) && s.params.slice(i + 1).some(isRequired));
  if (optional < 0) return null;
  const required = s.params.slice(optional + 1).find(isRequired)!;
  return `$${s.params[optional].name} is optional but comes before the required $${required.name}, so PHP treats it as required.`;
}
