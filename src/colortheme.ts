// Converts color themes from other editors into this editor's form: Monaco token rules and colors,
// the interface's CSS variables, and terminal colors. Reads VS Code themes (JSON with comments),
// TextMate themes (.tmTheme plists), and Monaco themes (such as the monaco-themes package).
// No Monaco import here, so the tests can run it in Node.

type Style = { foreground?: string; fontStyle?: string };
type TokenColor = { scope?: string | string[]; settings: Style & { background?: string } };
/** A theme in VS Code's format, which every source is converted to. Imported themes are saved like this. */
export type ColorTheme = { name: string; type: "dark" | "light"; colors: Record<string, string>; tokenColors: TokenColor[] };

/** Parses JSON with comments and trailing commas, as VS Code theme files often have. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1 || text.length;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Parses an XML property list, such as a .tmTheme file. */
export function parsePlist(xml: string): unknown {
  const tokens = xml.replace(/<!--[\s\S]*?-->/g, "").match(/<(\/?)(dict|array|key|string|integer|real|true|false|date|data)(\s*\/)?>([^<]*)/g) ?? [];
  const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  let i = 0;
  const value = (): unknown => {
    const [, close, tag, empty, text] = tokens[i++].match(/<(\/?)(\w+)(\s*\/)?>([^<]*)/)!;
    if (close) throw new Error(`Unexpected </${tag}> in the property list`);
    if (tag === "true" || tag === "false") return tag === "true";
    if (empty) return tag === "dict" ? {} : tag === "array" ? [] : "";
    if (tag === "dict") {
      const dict: Record<string, unknown> = {};
      while (!tokens[i].startsWith("</dict")) {
        const key = decode(tokens[i++].replace(/<key>/, ""));
        i++; // </key>
        dict[key] = value();
      }
      i++;
      return dict;
    }
    if (tag === "array") {
      const list: unknown[] = [];
      while (!tokens[i].startsWith("</array")) list.push(value());
      i++;
      return list;
    }
    i++; // The closing tag.
    return tag === "integer" || tag === "real" ? Number(text) : decode(text);
  };
  const start = tokens.findIndex((t) => /^<(dict|array)>/.test(t));
  if (start < 0) throw new Error("Not a property list");
  i = start;
  return value();
}

// ---- Colors ----

/** Normalizes a hex color to #rrggbb or #rrggbbaa, or returns undefined if it isn't one. */
export function hex(color: unknown): string | undefined {
  if (typeof color !== "string") return undefined;
  const m = color.trim().match(/^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!m) return undefined;
  const h = m[1].length <= 4 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${h.toLowerCase()}`;
}
const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const alpha = (c: string) => (c.length === 9 ? parseInt(c.slice(7), 16) / 255 : 1);
const toHex = (v: number[]) => `#${v.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;

/** Mixes `b` into `a`: 0 is `a`, 1 is `b`. Ignores alpha. */
export const mix = (a: string, b: string, t: number) => toHex(rgb(a).map((x, i) => x + (rgb(b)[i] - x) * t));
/** Paints a translucent color over an opaque one. */
export const solid = (c: string, over: string) => mix(over, c.slice(0, 7), alpha(c));
/** Relative luminance, 0 for black to 1 for white. */
export const luminance = (c: string) => {
  const [r, g, b] = rgb(c).map((x) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// ---- Reading themes ----

/** TextMate's global settings, and the VS Code colors they become. */
const TM_GLOBALS: Record<string, string> = {
  background: "editor.background",
  foreground: "editor.foreground",
  caret: "editorCursor.foreground",
  selection: "editor.selectionBackground",
  lineHighlight: "editor.lineHighlightBackground",
  invisibles: "editorWhitespace.foreground",
  gutterForeground: "editorLineNumber.foreground",
  findHighlight: "editor.findMatchHighlightBackground",
};

/**
 * Reads a VS Code theme, a TextMate theme (as parsed by parsePlist), or a Monaco theme into a ColorTheme.
 * Resolve VS Code's `include` and a `tokenColors` file path before calling this.
 */
export function readTheme(raw: unknown, fallbackName = "Imported theme"): ColorTheme {
  if (!raw || typeof raw !== "object") throw new Error("Not a color theme");
  const t = raw as Record<string, unknown>;
  const colors: Record<string, string> = {};
  for (const [key, value] of Object.entries((t.colors as object) ?? {})) {
    const c = hex(value);
    if (c) colors[key] = c;
  }
  let tokenColors: TokenColor[];
  if (Array.isArray(t.rules)) {
    // Monaco: { base, rules: [{ token, foreground }] }, where tokens are TextMate scopes.
    tokenColors = t.rules.map((r: Record<string, string>) => ({
      scope: r.token || undefined,
      settings: { foreground: r.foreground && `#${r.foreground.replace(/^#/, "")}`, background: r.background && `#${r.background.replace(/^#/, "")}`, fontStyle: r.fontStyle },
    }));
  } else {
    // VS Code's tokenColors, or TextMate's settings (which older VS Code themes use too).
    const list = Array.isArray(t.tokenColors) ? t.tokenColors : Array.isArray(t.settings) ? t.settings : [];
    tokenColors = list.filter((e) => e && typeof e === "object" && e.settings && typeof e.settings === "object");
  }
  // A rule without a scope holds TextMate's global settings.
  for (const rule of tokenColors.filter((r) => !r.scope)) {
    for (const [key, value] of Object.entries(rule.settings)) {
      const c = hex(value);
      if (c && TM_GLOBALS[key]) colors[TM_GLOBALS[key]] ??= c;
    }
  }
  if (!colors["editor.background"] && !colors["editor.foreground"] && !tokenColors.length) throw new Error("The file has no theme colors");

  const declared = String(t.type ?? t.base ?? "");
  const type = /light|^vs$|hc-light/.test(declared)
    ? "light"
    : /dark|black|^hc$/.test(declared)
      ? "dark"
      : luminance(colors["editor.background"] ?? "#ffffff") < 0.4
        ? "dark"
        : "light";
  colors["editor.background"] ??= type === "dark" ? "#1e1e1e" : "#ffffff";
  colors["editor.foreground"] ??= type === "dark" ? "#d4d4d4" : "#000000";
  const name = typeof t.name === "string" && t.name.trim() ? t.name.trim() : typeof t.displayName === "string" ? t.displayName : fallbackName;
  return { name, type, colors, tokenColors };
}

/**
 * The style TextMate would give `scope`, from the most specific matching selector. Selectors that
 * depend on a parent scope (with a space) never match, since Monaco's tokens have no parents.
 */
export function styleOf(tokenColors: TokenColor[], scope: string): { style: Style; score: number } {
  const best = { foreground: [-1, ""] as [number, string | undefined], fontStyle: [-1, ""] as [number, string | undefined] };
  let score = 0;
  for (const rule of tokenColors) {
    if (!rule.scope) continue;
    const selectors = Array.isArray(rule.scope) ? rule.scope : String(rule.scope).split(",");
    for (let sel of selectors) {
      sel = sel.split(" -")[0].trim();
      if (!sel || /\s|[()|&]/.test(sel)) continue;
      if (scope !== sel && !scope.startsWith(sel + ".")) continue;
      const s = sel.split(".").length;
      score = Math.max(score, s);
      // Later rules win ties, as in VS Code.
      if (rule.settings.foreground && s >= best.foreground[0]) best.foreground = [s, rule.settings.foreground];
      if (rule.settings.fontStyle !== undefined && s >= best.fontStyle[0]) best.fontStyle = [s, rule.settings.fontStyle];
    }
  }
  return { style: { foreground: best.foreground[1], fontStyle: best.fontStyle[1] }, score };
}

// ---- Monaco ----

type Rule = { token: string; foreground?: string; fontStyle?: string };
/** A role's color, as "#rrggbb", or a color and font style. */
export type Roles = Record<string, string | Style>;

/**
 * Monaco token rules for the tokens that the PHP, HTML, Blade, JavaScript, CSS, JSON, and Markdown grammars
 * emit, from colors by role. Comments are italic unless a role's style says otherwise.
 */
export function rules(c: Roles): Rule[] {
  const r = (token: string, role: string, fontStyle?: string): Rule | undefined => {
    const v = c[role] ?? (role === "escape" || role === "metatag" || role === "predefined" || role === "constant" ? c.keyword : c.text);
    const style = typeof v === "string" ? { foreground: v } : v;
    if (!style?.foreground) return undefined;
    return { token, foreground: style.foreground.slice(1, 7), fontStyle: style.fontStyle ?? fontStyle };
  };
  return [
    r("", "text"),
    r("comment", "comment", "italic"),
    r("comment.doc", "docComment", "italic"),
    r("keyword", "keyword"),
    r("keyword.flow", "keyword"),
    r("storage", "keyword"),
    r("string", "string"),
    r("string.escape", "escape"),
    r("number", "number"),
    r("regexp", "string"),
    r("variable", "variable"),
    r("variable.predefined", "predefined"),
    r("identifier", "text"),
    r("type", "type"),
    r("type.identifier", "type"),
    c.constant ? r("constant", "constant") : undefined,
    r("delimiter", "text"),
    r("operator", "text"),
    r("metatag", "metatag"),
    r("metatag.php", "metatag"),
    r("tag", "tag"),
    r("attribute.name", "attribute"),
    r("attribute.value", "string"),
    r("keyword.blade", "keyword"),
    r("delimiter.blade", "keyword"),
    r("comment.blade", "comment", "italic"),
    r("key", "field"),
    r("string.key.json", "field"),
    r("string.value.json", "string"),
    r("attribute.name.css", "field"),
    r("attribute.value.css", "string"),
    r("attribute.value.number.css", "number"),
    r("attribute.value.unit.css", "number"),
    r("tag.css", "tag"),
    r("keyword.md", "heading"),
    r("emphasis", "text", "italic"),
    r("strong", "text", "bold"),
  ].filter((rule): rule is Rule => !!rule);
}

/** The TextMate scopes that stand for each role, most specific first. */
const ROLE_SCOPES: Record<string, string[]> = {
  comment: ["comment.line.double-slash.php", "comment"],
  docComment: ["comment.block.documentation.phpdoc.php", "comment.block.documentation", "comment"],
  keyword: ["keyword.control.php", "keyword.control", "keyword", "storage.type"],
  string: ["string.quoted.double.php", "string"],
  escape: ["constant.character.escape.php", "constant.character.escape", "constant.character"],
  number: ["constant.numeric.decimal.php", "constant.numeric", "constant"],
  constant: ["constant.language.php", "constant.language", "constant"],
  variable: ["variable.other.php", "variable.other", "variable"],
  predefined: ["variable.language.this.php", "variable.language", "variable"],
  type: ["entity.name.type.class.php", "support.class", "entity.name.type", "entity.name.class", "storage.type"],
  metatag: ["punctuation.section.embedded.begin.php", "punctuation.section.embedded", "entity.name.tag"],
  tag: ["entity.name.tag.html", "entity.name.tag"],
  attribute: ["entity.other.attribute-name.html", "entity.other.attribute-name"],
  field: ["support.type.property-name.json", "support.type.property-name", "variable.other.property", "variable.other.object.property"],
  heading: ["markup.heading", "entity.name.section"],
};

export type Converted = {
  dark: boolean;
  /** Monaco's IStandaloneThemeData. */
  monaco: { base: "vs" | "vs-dark"; inherit: true; rules: Rule[]; colors: Record<string, string> };
  /** Interface CSS variables, without the leading "--". */
  ui: Record<string, string>;
  /** xterm.js ITheme. */
  terminal: Record<string, string>;
};

/** The first of `keys` that the theme sets to a visible color. */
const first = (colors: Record<string, string>, ...keys: string[]) => keys.map((k) => colors[k]).find((c) => c && alpha(c) > 0);

const ANSI = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"];

/** Converts a theme for Monaco, the interface, and the terminal. */
export function convert(theme: ColorTheme): Converted {
  const c = theme.colors;
  const dark = theme.type === "dark";
  const bg = solid(c["editor.background"], dark ? "#000000" : "#ffffff");
  const fg = solid(c["editor.foreground"], bg);
  const over = (color: string | undefined, under: string) => color && solid(color, under);

  const roles: Roles = { text: fg };
  for (const [role, scopes] of Object.entries(ROLE_SCOPES)) {
    for (const scope of scopes) {
      const { style, score } = styleOf(theme.tokenColors, scope);
      if (score && style.foreground && hex(style.foreground)) {
        // Monaco knows only these styles; themes also use "normal" and "regular".
        const fontStyle = (style.fontStyle ?? "").split(/\s+/).filter((s) => /^(italic|bold|underline|strikethrough)$/.test(s)).join(" ");
        roles[role] = { foreground: solid(hex(style.foreground)!, bg), fontStyle };
        break;
      }
    }
  }

  const text = over(first(c, "foreground"), bg) ?? fg;
  const panel = over(first(c, "sideBar.background", "panel.background", "editorWidget.background"), bg) ?? mix(bg, text, dark ? 0.05 : 0.03);
  const chrome = over(first(c, "titleBar.activeBackground", "editorGroupHeader.tabsBackground", "activityBar.background"), bg) ?? panel;
  const border = over(first(c, "sideBar.border", "editorGroup.border", "panel.border", "editorWidget.border", "contrastBorder"), panel) ?? mix(panel, text, 0.14);
  // Some themes' buttons are nearly the background's color, which would hide focus rings and checkboxes.
  const accent =
    [...["button.background", "focusBorder", "textLink.foreground"].map((k) => over(first(c, k), bg)), (roles.keyword as Style | undefined)?.foreground]
      .find((color) => color && Math.abs(luminance(color) - luminance(bg)) > 0.05) ?? "#3574f0";
  const ui: Record<string, string> = {
    bg,
    panel,
    chrome,
    border,
    "border-subtle": mix(border, panel, 0.4),
    text,
    muted: over(first(c, "descriptionForeground"), panel) ?? mix(text, panel, 0.4),
    faint: mix(text, panel, 0.55),
    accent,
    "accent-hover": over(first(c, "button.hoverBackground"), bg) ?? mix(accent, text, 0.15),
    "on-accent": over(first(c, "button.foreground"), accent) ?? (luminance(accent) > 0.45 ? "#000000" : "#ffffff"),
    hover: first(c, "list.hoverBackground") ?? mix(panel, text, 0.08),
    selected: first(c, "list.activeSelectionBackground", "editor.selectionBackground") ?? mix(panel, accent, 0.35),
    "selected-inactive": first(c, "list.inactiveSelectionBackground") ?? mix(panel, text, 0.12),
    "input-bg": over(first(c, "input.background"), panel) ?? bg,
    "input-border": over(first(c, "input.border", "dropdown.border"), panel) ?? mix(panel, text, 0.22),
  };
  const status: Record<string, string[]> = {
    red: ["terminal.ansiRed", "editorError.foreground", "errorForeground"],
    green: ["terminal.ansiGreen", "gitDecoration.addedResourceForeground"],
    blue: ["terminal.ansiBlue", "textLink.foreground"],
    yellow: ["terminal.ansiYellow", "editorWarning.foreground"],
    purple: ["terminal.ansiMagenta"],
    orange: ["editorWarning.foreground", "terminal.ansiBrightYellow"],
    "gutter-added": ["editorGutter.addedBackground"],
    "gutter-modified": ["editorGutter.modifiedBackground"],
    "gutter-deleted": ["editorGutter.deletedBackground"],
  };
  for (const [name, keys] of Object.entries(status)) {
    const color = over(first(c, ...keys), bg);
    if (color) ui[name] = color;
  }

  const terminal: Record<string, string> = {
    background: over(first(c, "terminal.background"), bg) ?? bg,
    foreground: over(first(c, "terminal.foreground"), bg) ?? fg,
    cursor: first(c, "terminalCursor.foreground", "editorCursor.foreground") ?? fg,
    selectionBackground: first(c, "terminal.selectionBackground", "editor.selectionBackground") ?? `${accent}66`,
  };
  for (const name of ANSI) {
    const key = name[0].toLowerCase() + name.slice(1);
    const normal = first(c, `terminal.ansi${name}`);
    const bright = first(c, `terminal.ansiBright${name}`);
    if (normal) terminal[key] = normal;
    if (bright) terminal[`bright${name}`] = bright;
  }

  return {
    dark,
    monaco: { base: dark ? "vs-dark" : "vs", inherit: true, rules: rules(roles), colors: { ...c, "editor.background": bg, "editor.foreground": fg } },
    ui,
    terminal,
  };
}
