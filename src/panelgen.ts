// Panel settings: what a panel provider's `panel()` configures (brand, colors, sign-in pages, layout, navigation
// groups, plugins, tenancy), read from the calls on `$panel` and written back as small edits to those calls. A
// provider may configure the panel over several statements; each setting is read from the last call that sets it,
// and new calls go on the longest chain. No editor imports, so Node tests it.
import {
  type ArrayNode,
  type ChainNode,
  type Edit,
  type OMethod,
  type PCall,
  type PNode,
  findCall,
  insertItem,
  moveItem,
  phpString,
  removeCall,
  removeItem,
  replaceItem,
  replaceNode,
  setArgs,
  setCall,
  textValue,
} from "./phpcode.ts";

export type PanelCode = { chains: ChainNode[]; main: ChainNode | null };

/** The chains of calls on the method's `$panel`, in the order they run. */
export function panelChains(method: OMethod): PanelCode {
  const v = method.params[0]?.name ?? "panel";
  const onPanel = (n: PNode | undefined): n is ChainNode => n?.kind === "chain" && n.base.kind === "var" && n.base.name === v;
  const chains = [...(method.statements ?? []).filter((s) => s.assigns === null || s.assigns === v).map((s) => s.value), ...method.returns].filter(onPanel).sort((a, b) => a.span[0] - b.span[0]);
  const main = chains.reduce<ChainNode | null>((best, c) => (!best || c.calls.length > best.calls.length ? c : best), null);
  return { chains, main };
}

/** The last call named `name` on the panel, with its chain. */
export function panelCall(code: PanelCode, name: string): { chain: ChainNode; call: PCall } | null {
  for (const chain of [...code.chains].reverse()) {
    const call = findCall(chain, name);
    if (call) return { chain, call };
  }
  return null;
}

export type Setting = {
  call: string;
  label: string;
  group: string;
  kind: "flag" | "text" | "asset" | "width";
  hint?: string;
  /** A flag's value when the call isn't there. */
  on?: boolean;
  placeholder?: string;
};

export const SETTINGS: Setting[] = [
  { group: "Panel", call: "path", label: "URL path", kind: "text", hint: "Where the panel lives, such as /admin. Empty puts it at the site's root." },
  { group: "Brand", call: "brandName", label: "Name", kind: "text", hint: "Shown in the sidebar and the browser tab, when there's no logo." },
  { group: "Brand", call: "brandLogo", label: "Logo", kind: "asset", placeholder: "images/logo.svg", hint: "A file in public/, or a URL. It replaces the name." },
  { group: "Brand", call: "darkModeBrandLogo", label: "Logo in dark mode", kind: "asset", placeholder: "images/logo-dark.svg" },
  { group: "Brand", call: "brandLogoHeight", label: "Logo height", kind: "text", placeholder: "1.5rem" },
  { group: "Brand", call: "favicon", label: "Favicon", kind: "asset", placeholder: "favicon.ico" },
  { group: "Brand", call: "font", label: "Font", kind: "text", placeholder: "Inter", hint: "A Google font's name, loaded from Bunny Fonts." },
  { group: "Sign-in", call: "login", label: "Login page", kind: "flag", hint: "Without it, the panel needs another way to sign users in." },
  { group: "Sign-in", call: "registration", label: "Registration", kind: "flag", hint: "Anyone can make an account." },
  { group: "Sign-in", call: "passwordReset", label: "Password reset", kind: "flag", hint: "Needs mail to be set up." },
  { group: "Sign-in", call: "emailVerification", label: "Email verification", kind: "flag", hint: "The user model must implement MustVerifyEmail." },
  { group: "Sign-in", call: "emailChangeVerification", label: "Verify email changes", kind: "flag" },
  { group: "Sign-in", call: "profile", label: "Profile page", kind: "flag", hint: "Users change their name, email, and password." },
  { group: "Layout", call: "topNavigation", label: "Navigation at the top", kind: "flag", hint: "Instead of a sidebar." },
  { group: "Layout", call: "sidebarCollapsibleOnDesktop", label: "Sidebar collapses to icons", kind: "flag" },
  { group: "Layout", call: "sidebarFullyCollapsibleOnDesktop", label: "Sidebar hides completely", kind: "flag" },
  { group: "Layout", call: "maxContentWidth", label: "Content width", kind: "width" },
  { group: "Layout", call: "breadcrumbs", label: "Breadcrumbs", kind: "flag", on: true },
  { group: "Layout", call: "darkMode", label: "Dark mode", kind: "flag", on: true, hint: "Users can switch to dark mode." },
  { group: "Features", call: "globalSearch", label: "Global search", kind: "flag", on: true, hint: "Searches resources that have a record title." },
  { group: "Features", call: "databaseNotifications", label: "Notifications bell", kind: "flag", hint: "Notifications saved in the database. Needs the notifications table." },
  { group: "Features", call: "spa", label: "Single-page navigation", kind: "flag", hint: "Pages load without a full reload." },
  { group: "Features", call: "unsavedChangesAlerts", label: "Warn about unsaved changes", kind: "flag" },
  { group: "Features", call: "databaseTransactions", label: "Save in transactions", kind: "flag", hint: "A failed save changes nothing." },
  { group: "Features", call: "strictAuthorization", label: "Strict authorization", kind: "flag", hint: "An ability the policy doesn't have is an error, not allowed." },
];

/** Widths `maxContentWidth()` offers, as Width's cases. */
export const WIDTHS: [string, string][] = [
  ["", "Default (7XL)"],
  ["Full", "Full width"],
  ["ScreenTwoExtraLarge", "Screen 2XL"],
  ["ScreenExtraLarge", "Screen XL"],
  ["FiveExtraLarge", "5XL"],
  ["ScreenLarge", "Screen large"],
];
export const WIDTH = "Filament\\Support\\Enums\\Width";

export type SettingValue = { value: string | boolean; code?: undefined } | { value?: undefined; code: string };

/** A setting's value, or the code that sets it when it isn't one the settings write. */
export function readSetting(text: string, code: PanelCode, s: Setting): SettingValue {
  const found = panelCall(code, s.call);
  const arg = found?.call.args.items[0];
  if (s.kind === "flag") {
    if (!found) return { value: !!s.on };
    if (arg && !arg.name && arg.value.kind === "bool") return { value: arg.value.value };
    return { value: true };
  }
  if (!found) return { value: "" };
  if (!arg) return s.kind === "text" && s.call === "path" ? { value: "" } : { code: text.slice(found.call.span[0], found.call.span[1]) };
  const v = arg.value;
  if (s.kind === "text" && v.kind === "string" && !v.interpolated && found.call.args.items.length === 1) return { value: v.value };
  if (s.kind === "asset") {
    if (v.kind === "string" && !v.interpolated) return { value: v.value };
    if (v.kind === "func" && /^(asset|url)$/.test(v.name) && v.args.items.length === 1 && v.args.items[0].value.kind === "string") return { value: (v.args.items[0].value as { value: string }).value };
  }
  if (s.kind === "width" && v.kind === "classConst" && /(^|\\)Width$/.test(v.class)) return { value: v.name };
  return { code: text.slice(found.call.span[0], found.call.span[1]) };
}

/** The edits that give a setting a value: a flag's default or an empty text removes the call. */
export function settingEdits(text: string, code: PanelCode, s: Setting, value: string | boolean): Edit[] {
  const found = panelCall(code, s.call);
  const isDefault = s.kind === "flag" ? value === !!s.on : value === "" && s.call !== "path";
  if (isDefault) return found ? allCalls(code, s.call).map(([chain, call]) => removeCall(chain, call)) : [];
  let args: string;
  if (s.kind === "flag") {
    // Turning on a call that's there keeps its arguments, such as a custom login page.
    if (found && value === true) {
      const arg = found.call.args.items[0];
      return arg?.value.kind === "bool" && !arg.name ? [setArgs(text, found.call.args, "")] : [];
    }
    args = value ? "" : "false";
  } else if (s.kind === "asset") args = /^(https?:)?\/\//.test(String(value)) ? phpString(String(value)) : `asset(${phpString(String(value).replace(/^\/+/, ""))})`;
  else if (s.kind === "width") args = `{{${WIDTH}}}::${value}`;
  else args = phpString(String(value));
  if (found) return [setArgs(text, found.call.args, args)];
  return code.main ? [setCall(text, code.main, s.call, args)] : [];
}

const allCalls = (code: PanelCode, name: string): [ChainNode, PCall][] => code.chains.flatMap((chain) => chain.calls.filter((c) => c.name === name).map((c): [ChainNode, PCall] => [chain, c]));

// ---- Colors ----

export const COLOR_ROLES: [string, string, string][] = [
  ["primary", "Primary", "Amber"],
  ["gray", "Gray", "Zinc"],
  ["danger", "Danger", "Red"],
  ["warning", "Warning", "Amber"],
  ["success", "Success", "Green"],
  ["info", "Info", "Blue"],
];
export const COLOR = "Filament\\Support\\Colors\\Color";

export type ColorValue = { kind: "palette"; name: string } | { kind: "hex"; hex: string } | { kind: "code"; code: string };

/** The `colors()` array, with each role's color. */
export function readColors(text: string, code: PanelCode): { arr: ArrayNode | null; call: PCall | null; roles: Map<string, { index: number; color: ColorValue }> } {
  const found = panelCall(code, "colors");
  const arr = found?.call.args.items[0]?.value.kind === "array" ? found.call.args.items[0].value : null;
  const roles = new Map<string, { index: number; color: ColorValue }>();
  arr?.items.forEach((item, index) => {
    const key = item.key?.kind === "string" ? item.key.value : null;
    if (key) roles.set(key, { index, color: colorOf(text, item.value) });
  });
  return { arr, call: found?.call ?? null, roles };
}

function colorOf(text: string, v: PNode): ColorValue {
  if (v.kind === "classConst" && /(^|\\)Color$/.test(v.class)) return { kind: "palette", name: v.name };
  if (v.kind === "string" && /^#[0-9a-f]{3,8}$/i.test(v.value)) return { kind: "hex", hex: v.value };
  if (v.kind === "static" && /(^|\\)Color$/.test(v.class) && v.method === "hex" && v.args.items[0]?.value.kind === "string") return { kind: "hex", hex: (v.args.items[0].value as { value: string }).value };
  return { kind: "code", code: text.slice(v.span[0], v.span[1]) };
}

export const colorCode = (c: { kind: "palette"; name: string } | { kind: "hex"; hex: string }) => (c.kind === "palette" ? `{{${COLOR}}}::${c.name}` : phpString(c.hex));

/** Sets a role's color, or removes it (back to Filament's default) when `color` is null. */
export function colorEdits(text: string, code: PanelCode, role: string, color: { kind: "palette"; name: string } | { kind: "hex"; hex: string } | null): Edit[] {
  const { arr, call, roles } = readColors(text, code);
  const at = roles.get(role);
  if (!color) {
    if (!arr || !at) return [];
    if (arr.items.length === 1) return allCalls(code, "colors").map(([chain, c]) => removeCall(chain, c));
    return [removeItem(text, arr, at.index)];
  }
  if (at && arr) return [replaceItem(text, arr, at.index, colorCode(color))];
  if (arr) return [insertItem(text, arr, arr.items.length, `${phpString(role)} => ${colorCode(color)}`)];
  if (call) return [];
  return code.main ? [setCall(text, code.main, "colors", `[\n    ${phpString(role)} => ${colorCode(color)},\n]`)] : [];
}

// ---- Navigation groups ----

export const NAV_GROUP = "Filament\\Navigation\\NavigationGroup";

export type NavGroup = { index: number; label: string | null; translated: boolean; icon: PNode | null; collapsed: boolean; kind: "text" | "make" | "code"; node: PNode };

/** The `navigationGroups()` array and its groups, in order. */
export function readNavGroups(text: string, code: PanelCode): { arr: ArrayNode | null; code: string | null; groups: NavGroup[] } {
  const found = panelCall(code, "navigationGroups");
  if (!found) return { arr: null, code: null, groups: [] };
  const v = found.call.args.items[0]?.value;
  if (v?.kind !== "array") return { arr: null, code: text.slice(found.call.span[0], found.call.span[1]), groups: [] };
  const groups = v.items.map((item, index): NavGroup => {
    const t = textValue(item.value);
    if (t) return { index, label: t.text, translated: t.translated, icon: null, collapsed: false, kind: "text", node: item.value };
    const n = item.value;
    const base = n.kind === "chain" ? n.base : n;
    if (base.kind === "static" && /(^|\\)NavigationGroup$/.test(base.class) && base.method === "make") {
      const label = textValue(base.args.items[0]?.value) ?? (n.kind === "chain" ? textValue(findCall(n, "label")?.args.items[0]?.value) : undefined);
      const icon = n.kind === "chain" ? (findCall(n, "icon")?.args.items[0]?.value ?? null) : null;
      const collapsed = n.kind === "chain" && !!findCall(n, "collapsed") && findCall(n, "collapsed")!.args.items[0]?.value.kind !== "bool";
      return { index, label: label?.text ?? null, translated: !!label?.translated, icon, collapsed, kind: "make", node: n };
    }
    return { index, label: null, translated: false, icon: null, collapsed: false, kind: "code", node: n };
  });
  return { arr: v, code: null, groups };
}

const labelCode = (label: string, translated: boolean) => (translated ? `__(${phpString(label)})` : phpString(label));

/** A group as code: a plain label, or NavigationGroup::make() when it has an icon or starts collapsed. */
export function navGroupCode(g: { label: string; translated: boolean; icon: string | null; collapsed: boolean }): string {
  if (!g.icon && !g.collapsed) return labelCode(g.label, g.translated);
  return `{{${NAV_GROUP}}}::make(${labelCode(g.label, g.translated)})${g.icon ? `\n    ->icon(${g.icon})` : ""}${g.collapsed ? "\n    ->collapsed()" : ""}`;
}

export function addNavGroupEdits(text: string, code: PanelCode, label: string, translated: boolean, index?: number): Edit[] {
  const { arr, code: other } = readNavGroups(text, code);
  if (other) return [];
  if (arr) return [insertItem(text, arr, index ?? arr.items.length, labelCode(label, translated))];
  return code.main ? [setCall(text, code.main, "navigationGroups", `[\n    ${labelCode(label, translated)},\n]`)] : [];
}

export function removeNavGroupEdits(text: string, code: PanelCode, index: number): Edit[] {
  const { arr } = readNavGroups(text, code);
  if (!arr) return [];
  if (arr.items.length === 1) return allCalls(code, "navigationGroups").map(([chain, c]) => removeCall(chain, c));
  return [removeItem(text, arr, index)];
}

export function moveNavGroupEdits(text: string, code: PanelCode, from: number, to: number): Edit[] {
  const { arr } = readNavGroups(text, code);
  return arr ? moveItem(text, arr, from, to) : [];
}

/** Rewrites a group with a new label, icon code, or collapsed state; a group written as other code is left alone. */
export function changeNavGroupEdits(text: string, code: PanelCode, index: number, change: { label?: string; icon?: string | null; collapsed?: boolean }): Edit[] {
  const { groups } = readNavGroups(text, code);
  const g = groups[index];
  if (!g || g.kind === "code" || g.label === null) return [];
  const icon = change.icon !== undefined ? change.icon : g.icon ? text.slice(g.icon.span[0], g.icon.span[1]) : null;
  const next = { label: change.label ?? g.label, translated: g.translated, icon, collapsed: change.collapsed ?? g.collapsed };
  // A NavigationGroup with calls this doesn't write, such as ->sort(), is changed a call at a time.
  if (g.kind === "make" && g.node.kind === "chain" && g.node.calls.some((c) => !["icon", "collapsed", "label"].includes(c.name))) {
    const n = g.node;
    const edits: Edit[] = [];
    if (change.icon !== undefined) {
      const call = findCall(n, "icon");
      if (change.icon) edits.push(setCall(text, n, "icon", change.icon));
      else if (call) edits.push(removeCall(n, call));
    }
    if (change.collapsed !== undefined) {
      const call = findCall(n, "collapsed");
      if (change.collapsed && !call) edits.push(setCall(text, n, "collapsed", ""));
      else if (!change.collapsed && call) edits.push(removeCall(n, call));
    }
    return edits;
  }
  return [replaceNode(text, g.node, navGroupCode(next))];
}

// ---- Plugins ----

export type PluginEntry = { class: string | null; code: string; remove: () => Edit[] };

/** The plugins the panel registers, with `plugins([...])` or `plugin(...)`; `code` is set when they come from other code. */
export function readPlugins(text: string, code: PanelCode): { entries: PluginEntry[]; other: string | null; arr: ArrayNode | null } {
  const entries: PluginEntry[] = [];
  let other: string | null = null;
  let arr: ArrayNode | null = null;
  const classOf = (n: PNode): string | null => {
    const base = n.kind === "chain" ? n.base : n;
    return base.kind === "static" ? base.class : base.kind === "new" ? base.class : null;
  };
  for (const chain of code.chains)
    for (const call of chain.calls) {
      if (call.name === "plugin" && call.args.items[0]) {
        const n = call.args.items[0].value;
        entries.push({ class: classOf(n), code: text.slice(n.span[0], n.span[1]), remove: () => [removeCall(chain, call)] });
      }
      if (call.name === "plugins") {
        const v = call.args.items[0]?.value;
        if (v?.kind !== "array") {
          other = text.slice(call.span[0], call.span[1]);
          continue;
        }
        arr ??= v;
        const list = v;
        list.items.forEach((item, index) => entries.push({ class: classOf(item.value), code: text.slice(item.value.span[0], item.value.span[1]), remove: () => (list.items.length === 1 ? [removeCall(chain, call)] : [removeItem(text, list, index)]) }));
      }
    }
  return { entries, other, arr };
}

export function addPluginEdits(text: string, code: PanelCode, fqn: string): Edit[] {
  const { arr } = readPlugins(text, code);
  const item = `{{${fqn}}}::make()`;
  if (arr) return [insertItem(text, arr, arr.items.length, item)];
  return code.main ? [setCall(text, code.main, "plugins", `[\n    ${item},\n]`)] : [];
}

// ---- Tenancy ----

/** The tenant model's class, as written, or the call's code when it isn't `Model::class`. */
export function readTenant(text: string, code: PanelCode): { model: string | null; code: string | null } {
  const found = panelCall(code, "tenant");
  if (!found) return { model: null, code: null };
  const v = found.call.args.items[0]?.value;
  if (v?.kind === "classConst" && v.name === "class") return { model: v.class, code: null };
  return { model: null, code: text.slice(found.call.span[0], found.call.span[1]) };
}

export function tenantEdits(text: string, code: PanelCode, model: string | null): Edit[] {
  const found = panelCall(code, "tenant");
  if (!model) return found ? allCalls(code, "tenant").map(([chain, c]) => removeCall(chain, c)) : [];
  // Only the model changes; ownershipRelationship and the other arguments stay.
  const first = found?.call.args.items[0];
  if (found && first) return [{ start: first.value.span[0], end: first.value.span[1], text: `{{${model}}}::class` }];
  return code.main ? [setCall(text, code.main, "tenant", `{{${model}}}::class`, undefined, "path")] : [];
}

// ---- Widgets ----

/** The widget classes the panel registers with `widgets([...])`, each with the edit that removes it. */
export function readPanelWidgets(text: string, code: PanelCode): { class: string | null; remove: () => Edit[] }[] {
  const out: { class: string | null; remove: () => Edit[] }[] = [];
  for (const chain of code.chains)
    for (const call of chain.calls) {
      const v = call.name === "widgets" ? call.args.items[0]?.value : undefined;
      if (v?.kind !== "array") continue;
      v.items.forEach((item, index) =>
        out.push({ class: item.value.kind === "classConst" && item.value.name === "class" ? item.value.class : null, remove: () => [v.items.length === 1 ? setArgs(text, call.args, "[]") : removeItem(text, v, index)] }),
      );
    }
  return out;
}

// ---- Two-factor sign-in ----

export const APP_AUTH = "Filament\\Auth\\MultiFactor\\App\\AppAuthentication";
export const EMAIL_AUTH = "Filament\\Auth\\MultiFactor\\Email\\EmailAuthentication";

/** Which second factors the panel offers: codes from an authenticator app (with recovery codes), or by email. */
export type Mfa = { app: boolean; recoverable: boolean; email: boolean; required: boolean };

/** The panel's `multiFactorAuthentication()`: null when it has none, or its code when it's more than the designer writes. */
export function readMfa(text: string, code: PanelCode): Mfa | { code: string } | null {
  const found = panelCall(code, "multiFactorAuthentication");
  if (!found) return null;
  const whole = { code: text.slice(found.call.span[0], found.call.span[1]) };
  const providers = found.call.args.items.find((a) => !a.name || a.name === "providers")?.value;
  const required = found.call.args.items.find((a) => a.name === "isRequired")?.value;
  if (providers?.kind !== "array" || (required && required.kind !== "bool")) return whole;
  const m: Mfa = { app: false, recoverable: false, email: false, required: required?.kind === "bool" && required.value };
  for (const item of providers.items) {
    const n = item.value;
    const base = n.kind === "chain" ? n.base : n;
    if (base.kind !== "static" || base.method !== "make") return whole;
    const calls = n.kind === "chain" ? n.calls : [];
    if (/(^|\\)AppAuthentication$/.test(base.class) && calls.every((c) => c.name === "recoverable")) {
      m.app = true;
      m.recoverable = calls.some((c) => c.args.items[0]?.value.kind !== "bool" || (c.args.items[0].value as { value: boolean }).value);
    } else if (/(^|\\)EmailAuthentication$/.test(base.class) && !calls.length) m.email = true;
    else return whole;
  }
  return m;
}

/** Sets the panel's second factors, or takes two-factor sign-in off when there are none. */
export function mfaEdits(text: string, code: PanelCode, m: Mfa): Edit[] {
  const found = panelCall(code, "multiFactorAuthentication");
  const providers = [...(m.app ? [`{{${APP_AUTH}}}::make()${m.recoverable ? "->recoverable()" : ""}`] : []), ...(m.email ? [`{{${EMAIL_AUTH}}}::make()`] : [])];
  if (!providers.length) return found ? allCalls(code, "multiFactorAuthentication").map(([chain, c]) => removeCall(chain, c)) : [];
  const args = `[\n${providers.map((p) => `    ${p},`).join("\n")}\n]${m.required ? ", isRequired: true" : ""}`;
  if (found) return [setArgs(text, found.call.args, args)];
  return code.main ? [setCall(text, code.main, "multiFactorAuthentication", args)] : [];
}
