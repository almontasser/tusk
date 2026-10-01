import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./designerfixture.ts";
import { combine, discoverClustersEdits, groupEdits, groupOrderEdits, type NavItem, orderSorts, readNav, renameGroupEdits, setNav, sidebar } from "./navgen.ts";
import { panelChains } from "./panelgen.ts";
import { applyEdits, mergeEdits, methodNamed } from "./phpcode.ts";

const item = (label: string, o: Partial<NavItem> = {}): NavItem => ({ kind: "resource", class: `App\\${label}`, file: `app/${label}.php`, label, icon: null, group: null, sort: null, parent: null, badge: null, cluster: null, registers: true, hasItem: true, overrides: {}, ...o });
const g = (label: string) => ({ label, enum: null, case: null });
const plain = (code: string) => code.replace(/\{\{[\w\\]*?(\w+)\}\}/g, "$1");

test("the sidebar orders items and groups as Filament does", () => {
  const items = [
    item("Reports", { kind: "page", group: g("Content"), sort: 5 }),
    item("Posts", { group: g("Content") }),
    item("Users"),
    item("Orders", { group: g("Shop"), sort: 1 }),
    item("Refunds", { group: g("Shop"), parent: "Orders" }),
    item("Tags", { group: g("Other") }),
    item("Settings", { cluster: "App\\SettingsCluster" }),
    item("Archive", { hasItem: false }),
  ];
  const side = sidebar(items, [{ key: 0, label: "Shop", icon: null, collapsed: false }, { key: 1, label: "Content", icon: null, collapsed: false }]);
  assert.deepEqual(side.map((s) => s.key), ["", "Shop", "Content", "Other"]);
  assert.deepEqual(side[2].items.map((i) => i.label), ["Posts", "Reports"]);
  assert.deepEqual(side[1].items.map((i) => [i.label, i.children.map((c) => c.label)]), [["Orders", ["Refunds"]]]);
  assert.deepEqual(sidebar(items, null, "App\\SettingsCluster").map((s) => s.items.map((i) => i.label)), [["Settings"]]);
  // Enum groups follow their cases' order; unlisted groups come in the order of their first item.
  const e = (c: string, index: number) => ({ label: c, enum: "App\\Nav", case: c, index });
  assert.deepEqual(sidebar([item("A", { group: e("B", 1) }), item("B", { group: e("A", 0) })], []).map((s) => s.key), ["App\\Nav::A", "App\\Nav::B"]);
});

test("settings read as values, translated getters, or code", () => {
  const { outline } = fixture("NavResource");
  const cls = outline.classes[0];
  assert.equal(readNav(cls, "navigationSort").kind, "value");
  assert.equal(readNav(cls, "navigationGroup").kind, "value");
  assert.equal(readNav(cls, "cluster").kind, "value");
  assert.deepEqual(readNav(cls, "navigationLabel").kind === "translated" && readNav(cls, "navigationLabel"), { ...readNav(cls, "navigationLabel"), text: "Orders" });
  assert.equal(readNav(cls, "shouldRegisterNavigation").kind, "code");
  assert.equal(readNav(cls, "navigationIcon", "app/Filament/BaseResource.php").kind, "code");
  const page = fixture("NavPage").outline.classes[0];
  assert.equal(readNav(page, "navigationSort").kind, "code");
  assert.equal(readNav(page, "navigationGroup").kind, "translated");
  assert.equal(readNav(page, "navigationParentItem").kind, "default");
});

test("moving into a group keeps the project's way of writing it", () => {
  const { text, outline } = fixture("NavResource");
  const cls = outline.classes[0];
  const to = (t: Parameters<typeof groupEdits>[2]) => plain(applyEdits(text, groupEdits(text, cls, t)));
  assert.match(to({ label: "Content", enum: null, case: null, translated: false }), /\$navigationGroup = 'Content';/);
  assert.match(to({ label: "Shop", enum: "App\\Enums\\NavGroup", case: "Billing", translated: false }), /\$navigationGroup = NavGroup::Billing;/);
  const translated = to({ label: "Content", enum: null, case: null, translated: true });
  assert.doesNotMatch(translated, /\$navigationGroup/);
  assert.match(translated, /public static function getNavigationGroup\(\): \?string\n    \{\n        return __\('Content'\);\n    \}\n\}/);
  assert.doesNotMatch(to(null), /navigationGroup/);
  // A new property gets Filament 4's declaration.
  const page = fixture("NavPage");
  const pcls = page.outline.classes[0];
  const out = plain(applyEdits(page.text, setNav(page.text, pcls, "navigationParentItem", "'Posts'")));
  assert.match(out, /protected static \?string \$navigationParentItem = 'Posts';/);
  assert.match(plain(applyEdits(page.text, renameGroupEdits(page.text, pcls, "Blog"))), /return __\('Blog'\);/);
  // Replacing a translated getter with a string removes the getter.
  const back = applyEdits(page.text, groupEdits(page.text, pcls, { label: "Blog", enum: null, case: null, translated: false }));
  assert.doesNotMatch(back, /getNavigationGroup/);
  assert.match(back, /\$navigationGroup = 'Blog';/);
  // A sort and a group together, where the new properties go where the getter was.
  const both = applyEdits(page.text, mergeEdits(combine(setNav(page.text, pcls, "navigationParentItem", "'Posts'"), groupEdits(page.text, pcls, { label: "Blog", enum: null, case: null, translated: false }))));
  assert.match(both, /\$navigationGroup = 'Blog';[\s\S]*\$navigationParentItem = 'Posts';\n\}\n$/);
});

test("sorts count up around fixed items", () => {
  assert.deepEqual(orderSorts([{ sort: 4, fixed: false }, { sort: -2, fixed: true }, { sort: null, fixed: false }]), [1, -2, 2]);
  assert.deepEqual(orderSorts([{ sort: 1, fixed: false }, { sort: 10, fixed: true }, { sort: 2, fixed: false }]), [1, 10, 11]);
});

test("the provider's groups follow a new order, keeping their code", () => {
  const { text, outline } = fixture("DemoPanelProvider");
  const code = panelChains(methodNamed(outline.classes[0], "panel")!);
  const out = applyEdits(text, groupOrderEdits(text, code, [{ label: "Blog", translated: false }, { label: "Shop", translated: false }, { label: "New", translated: false }]));
  assert.match(out, /->navigationGroups\(\[\n {16}'Blog',\n {16}'Shop',\n {16}'New',\n {16}'HR',\n {16}'Projects',\n {12}\]\)/);
  const discover = applyEdits(text, discoverClustersEdits(text, code, "app/Filament/Pages", "App\\Filament\\Pages"));
  assert.match(discover, /->discoverClusters\(in: app_path\('Filament\/Clusters'\), for: 'App\\Filament\\Clusters'\)/);
});
