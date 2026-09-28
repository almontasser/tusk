import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./designerfixture.ts";
import {
  addNavGroupEdits,
  addPluginEdits,
  changeNavGroupEdits,
  colorEdits,
  mfaEdits,
  moveNavGroupEdits,
  readMfa,
  panelChains,
  readColors,
  readNavGroups,
  readPlugins,
  readSetting,
  readTenant,
  SETTINGS,
  settingEdits,
  tenantEdits,
} from "./panelgen.ts";
import { applyEdits, type Edit, methodNamed } from "./phpcode.ts";

const setting = (call: string) => SETTINGS.find((s) => s.call === call)!;
const load = (name: string) => {
  const f = fixture(name);
  return { text: f.text, code: panelChains(methodNamed(f.outline.classes[0], "panel")!) };
};
const run = (text: string, edits: Edit[]) => applyEdits(text, edits).replace(/\{\{[\w\\]*?(\w+)\}\}/g, "$1");

test("settings read from a returned chain", () => {
  const { text, code } = load("DemoPanelProvider");
  assert.deepEqual(readSetting(text, code, setting("spa")), { value: true });
  assert.deepEqual(readSetting(text, code, setting("registration")), { value: false });
  assert.deepEqual(readSetting(text, code, setting("globalSearch")), { value: true });
  assert.deepEqual(readSetting(text, code, setting("font")), { value: "Albert Sans" });
  assert.deepEqual(readSetting(text, code, setting("brandLogo")), { value: "images/logo/dark.svg" });
  assert.deepEqual(readSetting(text, code, setting("login")), { value: true });
});

test("flags add, keep arguments, and go back to their default", () => {
  const { text, code } = load("DemoPanelProvider");
  assert.match(run(text, settingEdits(text, code, setting("registration"), true)), /->font\('Albert Sans'\)\n {12}->registration\(\);/);
  assert.equal(settingEdits(text, code, setting("login"), true).length, 0);
  assert.doesNotMatch(run(text, settingEdits(text, code, setting("spa"), false)), /->spa\(\)/);
  assert.match(run(text, settingEdits(text, code, setting("darkMode"), false)), /->darkMode\(false\);/);
  assert.match(run(text, settingEdits(text, code, setting("brandName"), "Shop")), /->brandName\('Shop'\);/);
  assert.match(run(text, settingEdits(text, code, setting("favicon"), "/favicon.png")), /->favicon\(asset\('favicon.png'\)\);/);
  assert.match(run(text, settingEdits(text, code, setting("maxContentWidth"), "Full")), /->maxContentWidth\(Width::Full\);/);
});

test("a provider that assigns the chain is read and changed there", () => {
  const { text, code } = load("AssignedPanelProvider");
  assert.equal(code.chains.length, 1);
  assert.deepEqual(readSetting(text, code, setting("profile")), { value: true });
  assert.match(run(text, settingEdits(text, code, setting("topNavigation"), true)), /->viteTheme\('resources\/css\/filament\/admin\/theme.css'\)\n {12}->topNavigation\(\);\n\n {8}return \$panel;/);
});

test("colors", () => {
  const { text, code } = load("DemoPanelProvider");
  assert.deepEqual(readColors(text, code).roles.get("primary")?.color, { kind: "palette", name: "Blue" });
  assert.match(run(text, colorEdits(text, code, "primary", { kind: "hex", hex: "#112233" })), /'primary' => '#112233',/);
  assert.match(run(text, colorEdits(text, code, "danger", { kind: "palette", name: "Rose" })), /'primary' => Color::Blue,\n {16}'danger' => Color::Rose,/);
  assert.doesNotMatch(run(text, colorEdits(text, code, "primary", null)), /->colors/);
  const a = load("AssignedPanelProvider");
  assert.match(run(a.text, colorEdits(a.text, a.code, "primary", { kind: "palette", name: "Rose" })), /'primary' => Color::Rose,/);
});

test("navigation groups", () => {
  const { text, code } = load("DemoPanelProvider");
  assert.deepEqual(
    readNavGroups(text, code).groups.map((g) => g.label),
    ["Shop", "HR", "Projects", "Blog"],
  );
  assert.match(run(text, moveNavGroupEdits(text, code, 3, 0)), /'Blog',\n {16}'Shop',\n {16}'HR',\n {16}'Projects',\n {12}\]/);
  assert.match(run(text, addNavGroupEdits(text, code, "Settings", false)), /'Blog',\n {16}'Settings',/);
  const iconed = run(text, changeNavGroupEdits(text, code, 1, { icon: "Heroicon::OutlinedUsers", collapsed: true }));
  assert.match(iconed, /NavigationGroup::make\('HR'\)\n {20}->icon\(Heroicon::OutlinedUsers\)\n {20}->collapsed\(\),/);
  const a = load("AssignedPanelProvider");
  assert.match(run(a.text, addNavGroupEdits(a.text, a.code, "Work", true)), /->navigationGroups\(\[\n {16}__\('Work'\),\n {12}\]\);/);
});

test("plugins and tenancy", () => {
  const a = load("AssignedPanelProvider");
  assert.deepEqual(readPlugins(a.text, a.code).entries.map((e) => e.class), ["BezhanSalleh\\FilamentShield\\FilamentShieldPlugin"]);
  assert.match(run(a.text, addPluginEdits(a.text, a.code, "Vendor\\Pkg\\BlogPlugin")), /FilamentShieldPlugin::make\(\),\n {16}BlogPlugin::make\(\),/);
  assert.doesNotMatch(run(a.text, readPlugins(a.text, a.code).entries[0].remove()), /->plugins/);
  const d = load("DemoPanelProvider");
  assert.match(run(d.text, addPluginEdits(d.text, d.code, "Vendor\\Pkg\\BlogPlugin")), /->plugins\(\[\n {16}BlogPlugin::make\(\),\n {12}\]\);/);
  assert.deepEqual(readTenant(d.text, d.code), { model: null, code: null });
  assert.match(run(d.text, tenantEdits(d.text, d.code, "App\\Models\\Team")), /->tenant\(Team::class\)/);
});

test("two-factor sign-in", () => {
  const { text, code } = load("DemoPanelProvider");
  assert.equal(readMfa(text, code), null);
  const on = run(text, mfaEdits(text, code, { app: true, recoverable: true, email: true, required: false }));
  assert.match(on, /->multiFactorAuthentication\(\[\n {16}AppAuthentication::make\(\)->recoverable\(\),\n {16}EmailAuthentication::make\(\),\n {12}\]\);/);
  const f = on.replace(/\{\{.*?\}\}/g, "");
  assert.ok(f);
  assert.equal(mfaEdits(text, code, { app: false, recoverable: false, email: false, required: false }).length, 0);
});
