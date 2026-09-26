// Reads .editorconfig files (https://editorconfig.org). Free of editor imports so Node can test it.

export type Properties = Record<string, string>;
type Section = { glob: string; props: Properties };
type Parsed = { root: boolean; sections: Section[] };

export function parse(text: string): Parsed {
  const parsed: Parsed = { root: false, sections: [] };
  let section: Section | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = line.match(/^\[(.*)\]$/);
    if (header) {
      section = { glob: header[1], props: {} };
      parsed.sections.push(section);
      continue;
    }
    const pair = line.match(/^([^=:]+?)\s*[=:]\s*(.*)$/);
    if (!pair) continue;
    const key = pair[1].toLowerCase();
    const value = pair[2].replace(/\s+[#;].*$/, "").trim().toLowerCase();
    if (section) section.props[key] = value;
    else if (key === "root") parsed.root = value === "true";
  }
  return parsed;
}

/** An EditorConfig glob as a regex over a path relative to the .editorconfig's folder. */
export function globToRegex(glob: string): RegExp {
  // A glob without a slash matches the file name in any folder.
  let pattern = glob.includes("/") ? glob.replace(/^\//, "") : `**/${glob}`;
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      // "**/" also matches no folder at all.
      if (pattern[i + 2] === "/") (out += "(?:.*/)?"), (i += 2);
      else (out += ".*"), i++;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = pattern.indexOf("}", i);
      const body = pattern.slice(i + 1, end);
      const range = body.match(/^(-?\d+)\.\.(-?\d+)$/);
      out += range
        ? `(?:${Array.from({ length: Math.abs(+range[2] - +range[1]) + 1 }, (_, k) => Math.min(+range[1], +range[2]) + k).join("|")})`
        : `(?:${body.split(",").map((part) => globToRegex(part.includes("/") ? `/${part}` : part).source.slice(1, -1).replace(/^\(\?:\.\*\/\)\?/, "")).join("|")})`;
      i = end;
    } else if (c === "[") {
      const end = pattern.indexOf("]", i);
      out += `[${pattern.slice(i + 1, end).replace(/^!/, "^")}]`;
      i = end;
    } else out += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/**
 * The properties for a file. `configs` holds each .editorconfig from the project root down to the
 * file's folder, with its folder; closer files and later sections win. A `root = true` file stops
 * the ones above it from counting.
 */
export function propertiesFor(path: string, configs: { dir: string; text: string }[]): Properties {
  const parsed = configs.map((c) => ({ dir: c.dir, ...parse(c.text) }));
  const start = parsed.map((p) => p.root).lastIndexOf(true);
  const props: Properties = {};
  for (const config of parsed.slice(Math.max(0, start))) {
    const rel = path.slice(config.dir.length + 1);
    for (const s of config.sections) if (globToRegex(s.glob).test(rel)) Object.assign(props, s.props);
  }
  return props;
}

/** Monaco model options from the properties, or undefined for properties that aren't set. */
export function indentation(props: Properties): { insertSpaces?: boolean; tabSize?: number; indentSize?: number } {
  const size = Number(props.indent_size) || undefined;
  const tabWidth = Number(props.tab_width) || undefined;
  return {
    insertSpaces: props.indent_style === "space" ? true : props.indent_style === "tab" ? false : undefined,
    tabSize: tabWidth ?? size,
    indentSize: size,
  };
}

/** Whether text has old Mac line endings: CR alone, never LF. */
export const isCrOnly = (text: string) => text.includes("\r") && !text.includes("\n");

/** Text with LF or CRLF lines, given CR line endings. */
export const toCr = (text: string) => text.replace(/\r?\n/g, "\r");
