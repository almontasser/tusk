// Reading settings.json: which saved values to use, and which are invalid and why.

export type Value = boolean | number | string | Record<string, string>;
/** A number setting's range, by key. */
export type Ranges = Record<string, { min: number; max: number }>;

/**
 * Parses settings.json's text. Returns the file's object, or why it can't be used: it isn't JSON, or isn't an
 * object. The caller keeps the file as it is until you fix it.
 */
export function parseSettingsFile(text: string): { raw: Record<string, unknown> } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { error: `settings.json isn't valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "settings.json must hold one JSON object, such as { \"fontSize\": 14 }" };
  return { raw: parsed as Record<string, unknown> };
}

/**
 * The value of each known setting: the saved one when it has the default's type (and for a number, is in its
 * range), or else the default. `invalid` says why each saved value that was set aside can't be used; those stay in
 * the file until you change the setting, so a typo doesn't cost you the value.
 */
export function readSaved(raw: Record<string, unknown>, defaults: Record<string, Value>, ranges: Ranges) {
  const values: Record<string, Value> = {};
  const invalid = new Map<string, string>();
  for (const [key, fallback] of Object.entries(defaults)) {
    const v = raw[key];
    values[key] = fallback;
    if (v === undefined) continue;
    const kind = typeof fallback;
    if (typeof v !== kind || v === null || Array.isArray(v) !== Array.isArray(fallback)) {
      invalid.set(key, `must be ${kind === "boolean" ? "true or false" : kind === "number" ? "a number" : kind === "string" ? "text in quotes" : "an object"}`);
      continue;
    }
    const range = ranges[key];
    if (range && ((v as number) < range.min || (v as number) > range.max)) {
      invalid.set(key, `must be from ${range.min} to ${range.max}`);
      continue;
    }
    values[key] = v as Value;
  }
  return { values, invalid };
}

/** What to write to settings.json: the file's own keys, including ones this version doesn't know, then the values in use, except invalid ones, which keep their saved text. */
export function settingsToWrite(raw: Record<string, unknown>, values: Record<string, unknown>, invalid: Set<string> | Map<string, string>) {
  const out: Record<string, unknown> = { ...raw };
  for (const [k, v] of Object.entries(values)) if (!invalid.has(k)) out[k] = v;
  return out;
}
