// The resource designer's Access tab: who can do what with the resource's records, from the model's policy. Each
// ability is a rule (src/policygen.ts) edited in the policy's code. With spatie/laravel-permission, it also shows
// which roles have the permissions the rules name, and grants or revokes them, creating what's missing.
import { h, icon, iconButton } from "./dom";
import * as fapp from "./filamentapp";
import { humanize } from "./filamentcatalog";
import type { Doc } from "./filamentdesigner";
import type { Edit, Imports } from "./phpcode";
import { askName, popover } from "./filamentpickers";
import { shortClass } from "./filamentschema";
import { addMember, type OClass } from "./phpcode";
import { abilityMethod, type Cond, type EntryRule, entryEdits, permissionName, permissionsOf, readEntry, readPolicy, type ReadAbility, type Rule, ruleCode } from "./policygen";
import { showError } from "./status";

/** What the Access tab needs from the view it's in: the resource designer, or a model's own Access view. */
export type AccessHost = {
  root: string;
  facts: { class: string; columns: { name: string }[] } | null;
  info: { model: string; pluralLabel: string | null } | null;
  access: { info: fapp.PolicyInfo; doc: Doc | null } | null;
  accessError: string;
  loadAccess(): Promise<void>;
  host: { openAt(path: string, line: number, column?: number): void; status(text: string): void };
  reveal(node: { span: [number, number] }, doc: Doc): void;
  apply(doc: Doc, build: (imports: Imports, fill: (code: string) => string) => Edit[] | null, message: string): Promise<unknown>;
};

const COND_KINDS: [Cond["kind"], string][] = [
  ["permission", "has the permission"],
  ["role", "has the role"],
  ["owner", "owns the record, by"],
];

export function renderAccessTab(d: AccessHost): HTMLElement {
  const model = d.facts?.class ?? d.info?.model ?? null;
  const plural = (d.info?.pluralLabel ?? (model ? `${humanize(shortClass(model)).toLowerCase()}s` : "records")).toLowerCase();
  if (!model) return h("div", { class: "fd-page-tab" }, h("p", { class: "fd-note fd-center" }, "The designer can't tell the resource's model, so it can't find its policy."));
  if (d.accessError) return h("div", { class: "fd-error" }, icon("warning"), h("div", {}, h("strong", {}, "The designer can't read the policy"), h("p", {}, d.accessError), h("div", { class: "fd-error-actions" }, h("button", { type: "button", onclick: () => void d.loadAccess() }, icon("refresh"), "Try again"))));
  if (!d.access) {
    void d.loadAccess();
    return h("div", { class: "fd-loading" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), "Reading the policy…");
  }
  const { info, doc } = d.access;
  const head = (actions: (HTMLElement | null)[], note: string) => h("div", { class: "fd-page-tab-head" }, h("div", {}, h("h2", {}, "Access"), h("p", { class: "fd-note" }, note)), ...actions);
  if (!info.policy || !doc) {
    const create = h("button", { type: "button", class: "primary" }, icon("add"), "Create a policy");
    create.onclick = () => void createPolicy(d, model, create);
    return h(
      "div",
      { class: "fd-page-tab" },
      head([create], `Who can see, create, edit, and delete ${plural}.`),
      h("div", { class: "fd-access-empty" }, icon("shield"), h("div", {}, h("strong", {}, `${shortClass(model)} has no policy`), h("p", { class: "fd-note" }, `So everyone who can open the panel can do everything with ${plural}. A policy decides that for each action: for example, only users with a permission can delete. A new policy allows everything until you change it.`))),
      permissionsSection(d, info, [], model),
    );
  }
  const cls = doc.outline.classes.find((c) => c.name);
  if (!cls) return h("p", { class: "fd-note fd-center" }, "There's no class in the policy's file.");
  const read = readPolicy(doc.text, cls, shortClass(model));
  const rows = (list: ReadAbility[]) => list.map((r) => abilityRow(d, r, info, model));
  return h(
    "div",
    { class: "fd-page-tab" },
    head([h("button", { type: "button", onclick: () => d.host.openAt(doc.path, 1) }, icon("go-to-file"), shortClass(info.policy))], `Who can do what with ${plural}, from ${shortClass(info.policy)}. An action someone can't do is hidden from them.`),
    doc.outline.errors ? h("div", { class: "fd-helper-note fd-error-note" }, icon("warning"), h("span", {}, "The policy has syntax errors. Fix them to change it here.")) : null,
    h("div", { class: "fd-access" }, ...rows(read.filter((r) => !r.ability.more))),
    h("details", { class: "fd-access-more", open: read.some((r) => r.ability.more && r.method && r.rule?.kind !== "everyone") }, h("summary", {}, "More abilities"), h("div", { class: "fd-access" }, ...rows(read.filter((r) => r.ability.more)))),
    permissionsSection(d, info, permissionsOf(read), model),
  );
}

/** One ability: what it covers, and who may. */
function abilityRow(d: AccessHost, r: ReadAbility, info: fapp.PolicyInfo, model: string): HTMLElement {
  const set = (rule: Rule) => void setRule(d, r, rule, model);
  const rule = r.rule;
  let editor: HTMLElement;
  if (rule?.kind === "custom") {
    const replace = h("select", {}, h("option", { value: "", textContent: "Replace with…" }), h("option", { value: "everyone", textContent: "Everyone" }), h("option", { value: "nobody", textContent: "Nobody" }), h("option", { value: "when", textContent: "Only users who…" }));
    replace.onchange = () => replace.value && set(fresh(replace.value as Rule["kind"], r, model, info));
    editor = h("div", { class: "fd-access-rule" }, h("button", { type: "button", class: "fd-code-chip", title: "Written as code. Open it to change it, or replace it.", onclick: () => r.method && d.reveal(r.method, d.access!.doc!) }, icon("code"), h("span", {}, codeSummary(d, r))), replace);
  } else {
    const who = h(
      "select",
      { class: "fd-access-who" },
      ...(rule ? [] : [h("option", { value: "", textContent: "Everyone (not in the policy)", selected: true })]),
      h("option", { value: "everyone", textContent: "Everyone", selected: rule?.kind === "everyone" }),
      h("option", { value: "nobody", textContent: "Nobody", selected: rule?.kind === "nobody" }),
      h("option", { value: "when", textContent: "Only users who…", selected: rule?.kind === "when" }),
    );
    who.onchange = () => who.value && set(fresh(who.value as Rule["kind"], r, model, info));
    editor = h("div", { class: "fd-access-rule" }, who, rule?.kind === "when" ? conditions(d, r, rule, info, model) : null);
  }
  return h("div", { class: `fd-access-row${!r.method ? " missing" : ""}` }, h("div", { class: "fd-access-label", title: r.ability.hint }, h("strong", {}, r.ability.label), h("span", { class: "fd-note" }, r.ability.hint)), editor);
}

/** What a method written as code returns, shortened, or "Code" when it does more than return. */
function codeSummary(d: AccessHost, r: ReadAbility): string {
  const ret = r.method?.returns.length === 1 ? r.method.returns[0] : null;
  const text = ret ? d.access!.doc!.text.slice(ret.span[0], ret.span[1]).replace(/\s+/g, " ") : "Code";
  return text.length > 70 ? `${text.slice(0, 69)}…` : text;
}

/** A new rule of a kind: "Only users who…" starts with the ability's permission. */
function fresh(kind: Rule["kind"], r: ReadAbility, model: string, info: fapp.PolicyInfo): Rule {
  if (kind === "when") return { kind, join: "any", conds: [{ kind: "permission", name: permissionName(r.ability.name, shortClass(model), { keys: info.shieldKeys, format: info.shieldFormat }) }] };
  return { kind } as Rule;
}

function conditions(d: AccessHost, r: Pick<ReadAbility, "ability">, rule: Extract<Rule, { kind: "when" }>, info: fapp.PolicyInfo, model: string, set: (next: Rule) => void = (next) => void setRule(d, r as ReadAbility, next, model)): HTMLElement {
  const columns = (d.facts?.columns ?? []).map((c) => c.name).filter((c) => /(^|_)(user|owner|author|created_by|creator)(_id)?$|_by$/.test(c) || c === "user_id");
  const list = h("div", { class: "fd-access-conds" });
  rule.conds.forEach((c, i) => {
    const kinds = COND_KINDS.filter(([k]) => k !== "owner" || r.ability.record);
    const kind = h("select", {}, ...kinds.map(([k, l]) => h("option", { value: k, textContent: l, selected: k === c.kind })));
    kind.onchange = () => {
      const k = kind.value as Cond["kind"];
      const next: Cond = k === "owner" ? { kind: k, column: columns[0] ?? "user_id" } : k === "role" ? { kind: k, name: info.roles[0]?.name ?? "admin" } : { kind: k, name: permissionName(r.ability.name, shortClass(model), { keys: info.shieldKeys, format: info.shieldFormat }) };
      set({ ...rule, conds: rule.conds.map((x, j) => (j === i ? next : x)) });
    };
    let value: HTMLElement;
    if (c.kind === "owner") {
      const all = [...new Set([c.column, ...columns, ...(d.facts?.columns ?? []).map((x) => x.name).filter((x) => x.endsWith("_id"))])];
      value = h("select", { class: "fd-mono" }, ...all.map((col) => h("option", { value: col, textContent: col, selected: col === c.column })));
      value.onchange = () => set({ ...rule, conds: rule.conds.map((x, j) => (j === i ? { kind: "owner", column: (value as HTMLSelectElement).value } : x)) });
    } else {
      const options = c.kind === "role" ? info.roles.map((x) => x.name) : info.permissions;
      const id = `fd-access-${r.ability.name}-${i}`;
      const input = h("input", { class: "fd-mono", value: c.name, spellcheck: false, placeholder: c.kind === "role" ? "admin" : "update_post" }) as HTMLInputElement;
      input.setAttribute("list", id);
      input.onchange = () => input.value.trim() && set({ ...rule, conds: rule.conds.map((x, j) => (j === i ? { kind: c.kind, name: input.value.trim() } : x)) });
      input.onkeydown = (e) => void (e.key === "Enter" && input.blur());
      value = h("span", { class: "fd-access-value" }, input, h("datalist", { id }, ...options.map((o) => h("option", { value: o }))));
    }
    list.append(
      h(
        "div",
        { class: "fd-access-cond" },
        i === 0 ? h("span", { class: "fd-access-join" }) : joinToggle(rule, set),
        kind,
        value,
        rule.conds.length > 1 ? iconButton("close", "Remove the condition", () => set({ ...rule, conds: rule.conds.filter((_, j) => j !== i) })) : h("span", {}),
      ),
    );
  });
  list.append(h("button", { type: "button", class: "fd-lane-add fd-access-add", onclick: () => set({ ...rule, conds: [...rule.conds, r.ability.record && columns[0] && !rule.conds.some((c) => c.kind === "owner") ? { kind: "owner", column: columns[0] } : { kind: "role", name: info.roles[0]?.name ?? "admin" }] }) }, icon("add"), "Add a condition"));
  return list;
}

const joinToggle = (rule: Extract<Rule, { kind: "when" }>, set: (r: Rule) => void) => h("button", { type: "button", class: "fd-access-join", title: "Whether any condition is enough, or all must hold. Click to switch.", onclick: () => set({ ...rule, join: rule.join === "any" ? "all" : "any" }) }, rule.join === "any" ? "or" : "and");

/** Writes a rule: replaces the method's return, or adds the method. */
async function setRule(d: AccessHost, r: ReadAbility, rule: Rule, model: string) {
  const doc = d.access?.doc;
  const code = ruleCode(rule, r.vars);
  if (!doc || !code) return;
  const cls = doc.outline.classes.find((c) => c.name)!;
  const typed = cls.methods.find((m) => m.params.length === 2) ?? cls.methods.find((m) => m.params.length);
  await d.apply(
    doc,
    (_imports, fill) => {
      if (r.expr) return [{ start: r.expr.span[0], end: r.expr.span[1], text: code }];
      const userType = typed?.params[0]?.type ?? fill(`{{${d.access!.info.user ?? "App\\Models\\User"}}}`);
      const modelType = typed?.params[1]?.type ?? fill(`{{${model}}}`);
      return [addMember(doc.text, cls, abilityMethod(r.ability, code, r.vars, userType, modelType))];
    },
    `${r.ability.label}: ${rule.kind === "when" ? "only some users" : rule.kind}`,
  );
}

async function createPolicy(d: AccessHost, model: string, button: HTMLButtonElement) {
  button.disabled = true;
  const name = `${shortClass(model)}Policy`;
  try {
    await fapp.artisan(d.root, ["make:policy", name, `--model=${model}`]);
    fapp.forget([`policy:`]);
    await d.loadAccess();
    const doc = d.access?.doc;
    if (!d.access?.info.policy || !doc) return d.host.status(`Created ${name}, but Laravel doesn't use it for ${shortClass(model)}. Register it with Gate::policy() in a service provider.`);
    // Laravel's stub denies everything, which would lock everyone out of the resource. It starts open instead.
    const cls = doc.outline.classes.find((c) => c.name)!;
    const closed = readPolicy(doc.text, cls, shortClass(model)).filter((r) => r.expr && r.rule?.kind === "nobody");
    await d.apply(doc, () => closed.map((r) => ({ start: r.expr!.span[0], end: r.expr!.span[1], text: "true" })), `Created ${name}`);
    d.host.status(`Created ${name}. Everyone can still do everything until you change who can.`);
  } catch (e) {
    button.disabled = false;
    showError("Can't create the policy", e);
  }
}

// ---- Roles and permissions ----

/** Which roles have the permissions the rules name, with spatie/laravel-permission. */
function permissionsSection(d: AccessHost, info: fapp.PolicyInfo, used: string[], model: string): HTMLElement | null {
  const title = h("h3", {}, icon("key"), "Roles and permissions");
  if (!info.spatie) return h("section", { class: "fd-access-perms" }, title, h("p", { class: "fd-note" }, "Rules can name roles and permissions when the app has spatie/laravel-permission, which stores them in the database and gives them to users. Without it, a permission is any Gate ability the app defines."));
  const notes: HTMLElement[] = [];
  if (!info.hasRoles) notes.push(h("p", { class: "fd-note" }, icon("warning"), ` ${shortClass(info.user ?? "User")} doesn't use Spatie's HasRoles trait, so users have no roles or permissions yet.`));
  if (info.shield) notes.push(h("p", { class: "fd-note" }, icon("info"), ` Filament Shield is installed: its Roles page edits the same permissions, and new rules use its names${info.shieldKeys ? " for this resource" : ""}.`));
  if (info.superAdmin?.viaGate) notes.push(h("p", { class: "fd-note" }, icon("info"), ` Users with the ${info.superAdmin.name} role can do everything: Shield lets them past these rules.`));
  if (info.error) return h("section", { class: "fd-access-perms" }, title, ...notes, h("p", { class: "fd-note" }, icon("warning"), ` The designer can't read them from the database: ${info.error}`));
  const snake = shortClass(model).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const perms = [...new Set([...used, ...info.permissions.filter((p) => p.toLowerCase().includes(snake))])];
  const change = async (args: string[], message: string) => {
    try {
      await fapp.changePermission(d.root, args);
      fapp.forget([`policy:`]);
      await d.loadAccess();
      d.host.status(message);
    } catch (e) {
      showError("Can't change the permissions", e);
    }
  };
  const newRole = h("button", { type: "button" }, icon("add"), "New role");
  newRole.onclick = async () => {
    const name = await askName(newRole, { title: "New role", placeholder: "editor", suggestions: [], validate: (v) => (info.roles.some((r) => r.name === v) ? "There's a role with that name." : null) });
    if (name) await change(["create-role", name], `Created the ${name} role.`);
  };
  const table = h("div", { class: "fd-access-matrix", style: `--roles:${info.roles.length}` });
  table.append(h("span", { class: "fd-access-matrix-head" }, "Permission"), ...info.roles.map((r) => h("span", { class: "fd-access-matrix-head center" }, r.name)));
  for (const p of perms) {
    const exists = info.permissions.includes(p);
    table.append(
      h(
        "span",
        { class: "fd-access-perm" },
        h("code", {}, p),
        exists ? null : h("button", { type: "button", class: "fd-chip-link", title: "It's named in the policy but not in the database", onclick: () => void change(["create-permission", p], `Created ${p}.`) }, "Create"),
      ),
      ...info.roles.map((r) => {
        const box = h("input", { type: "checkbox", checked: r.permissions.includes(p), title: `${r.name}: ${p}` });
        box.onchange = () => void change([box.checked ? "grant" : "revoke", r.name, p], `${box.checked ? "Gave" : "Took"} ${p} ${box.checked ? "to" : "from"} ${r.name}.`);
        return h("span", { class: "center" }, box);
      }),
    );
  }
  // Shield makes permissions for every resource, page, and widget of each panel; policies only where none exist,
  // since it would otherwise replace the policies these rules are written in.
  const generate = info.shield ? h("button", { type: "button" }, icon("sparkle"), "Generate with Shield…") : null;
  if (generate)
    generate.onclick = () => {
      const run = async (option: string, label: string) => {
        p.close();
        try {
          const app = await fapp.app(d.root);
          for (const panel of app.panels) await fapp.artisan(d.root, ["shield:generate", "--all", `--option=${option}`, "--ignore-existing-policies", `--panel=${panel.id}`]);
          fapp.forget([`policy:`, "app"]);
          await d.loadAccess();
          d.host.status(label);
        } catch (e) {
          showError("Shield couldn't generate them", e);
        }
      };
      const p = popover(
        generate,
        h(
          "div",
          { class: "fd-menu" },
          h("button", { type: "button", class: "fd-menu-item", onclick: () => void run("permissions", "Shield created the permissions.") }, icon("key"), h("span", {}, "Create the permissions"), h("span", { class: "fd-note" }, "for every resource, page, and widget")),
          h("button", { type: "button", class: "fd-menu-item", onclick: () => void run("policies_and_permissions", "Shield created the permissions and the missing policies.") }, icon("shield"), h("span", {}, "Also write missing policies"), h("span", { class: "fd-note" }, "existing ones stay")),
        ),
      );
    };
  return h(
    "section",
    { class: "fd-access-perms" },
    h("div", { class: "fd-access-perms-head" }, title, h("span", { class: "fd-spacer" }), generate, newRole),
    ...notes,
    !info.roles.length ? h("p", { class: "fd-note" }, "No roles yet. Create one, then give it permissions here.") : null,
    perms.length && info.roles.length ? table : perms.length ? null : h("p", { class: "fd-note" }, "The rules name no permissions yet. Pick “Only users who…” and “has the permission” for an ability."),
  );
}

// ---- Custom pages and widgets ----

/** What the Access section of a custom page or a widget needs from the view it's in. */
export type EntryHost = {
  root: string;
  kind: "page" | "widget";
  fqn: string;
  text: string;
  cls: OClass;
  host: AccessHost["host"];
  info: (fapp.PolicyInfo & { shieldKey: string | null }) | null;
  error: string;
  /** Shows code in the class's file. */
  reveal(offset: number): void;
  /** Reads who can again, after a role or permission changed. */
  load(): Promise<void>;
  edit(build: (text: string, cls: OClass, fill: (code: string) => string) => Edit[] | null, message: string): unknown;
};

/**
 * Who can open a custom page or see a widget: everyone, nobody, users with a permission or role (the same
 * conditions as a resource's abilities), or, with Filament Shield, the permission Shield gives it.
 */
export function renderEntryAccess(e: EntryHost): HTMLElement {
  const noun = e.kind === "page" ? "open this page" : "see this widget";
  const head = h("div", { class: "fd-page-tab-head" }, h("div", {}, h("h2", {}, "Access"), h("p", { class: "fd-note" }, `Who can ${noun}. ${e.kind === "page" ? "The page is also left out of the navigation for everyone else." : "Everyone else doesn't see it on the dashboard."}`)));
  if (e.error) return h("div", { class: "fd-page-tab" }, head, h("p", { class: "fd-note" }, icon("warning"), ` Can't read the roles: ${e.error}`));
  if (!e.info) {
    void e.load();
    return h("div", { class: "fd-loading" }, h("span", { class: "codicon codicon-loading codicon-modifier-spin" }), "Reading the roles…");
  }
  const info = e.info;
  const method = e.kind === "page" ? "canAccess" : "canView";
  const rule = readEntry(e.text, e.cls, e.kind);
  const ability = { name: method, label: e.kind === "page" ? "Open the page" : "See the widget", record: false, more: false, hint: "" };
  const short = shortClass(e.fqn);
  const permission = info.shieldKey ?? permissionName("view", short, { keys: null, format: info.shieldFormat });
  const write = (next: EntryRule) =>
    e.edit((text, cls, fill) => entryEdits(text, cls, e.kind, next, fill), `Access: ${next.kind === "when" ? "only some users" : next.kind === "shield" ? "Filament Shield decides" : next.kind}`);
  const who = h(
    "select",
    { class: "fd-access-who" },
    h("option", { value: "everyone", textContent: "Everyone who can open the panel", selected: rule.kind === "everyone" }),
    h("option", { value: "nobody", textContent: "Nobody", selected: rule.kind === "nobody" }),
    h("option", { value: "when", textContent: "Only users who…", selected: rule.kind === "when" }),
    ...(info.shield ? [h("option", { value: "shield", textContent: "Filament Shield decides", selected: rule.kind === "shield" })] : []),
    ...(rule.kind === "custom" ? [h("option", { value: "custom", textContent: "Code", selected: true, disabled: true })] : []),
  );
  who.onchange = () => void write(who.value === "when" ? { kind: "when", join: "any", conds: [{ kind: "permission", name: permission }] } : ({ kind: who.value } as EntryRule));
  let detail: HTMLElement | null = null;
  if (rule.kind === "when") detail = conditions({ root: e.root } as AccessHost, { ability }, rule, info, short, (next) => void write(next));
  else if (rule.kind === "shield") detail = h("p", { class: "fd-note" }, info.shieldKey ? `Users with the ${info.shieldKey} permission. Give it to roles below, or on Shield's Roles page.` : "Shield doesn't list this class yet, so everyone can. Check Shield's config for pages and widgets.");
  else if (rule.kind === "custom") {
    const m = e.cls.methods.find((x) => x.name === method);
    detail = h("button", { type: "button", class: "fd-code-chip", onclick: () => m && e.reveal(m.span[0]) }, icon("code"), `Written as code in ${method}()`);
  }
  const used = [...(rule.kind === "when" ? rule.conds.filter((c) => c.kind === "permission").map((c) => (c as { name: string }).name) : []), ...(rule.kind === "shield" && info.shieldKey ? [info.shieldKey] : [])];
  const adapter = { root: e.root, host: e.host, loadAccess: e.load } as AccessHost;
  return h(
    "div",
    { class: "fd-page-tab" },
    head,
    h("div", { class: "fd-access" }, h("div", { class: "fd-access-row" }, h("div", { class: "fd-access-label" }, h("strong", {}, ability.label), h("span", { class: "fd-note" }, `${method}()`)), h("div", { class: "fd-access-rule" }, who, detail))),
    permissionsSection(adapter, info, used, short),
  );
}
