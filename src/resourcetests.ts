// Generate tests for a Filament resource: reads the resource's form, table, pages, model, and policy, makes the
// factories the tests need when the models have none, writes a Pest test file (or PHPUnit's, without Pest), or adds
// the tests an existing file lacks, and runs it with the test runner. The code comes from `src/resourcetestgen.ts`.
import { invoke } from "@tauri-apps/api/core";
import { editFiles } from "./codeapply";
import * as fapp from "./filamentapp";
import { host } from "./filamentdesigner";
import { readRoot, type Root, type RootKind, shortClass } from "./filamentschema";
import { toolPath } from "./lsp";
import { choose, confirm, pick, rank, type Item } from "./palette";
import { addMember, classNamed, methodNamed } from "./phpcode";
import { readPolicy, type Rule } from "./policygen";
import { factoriesNeeded, factoryClass, factoryFor, factoryKeys, factoryParents, hasEditAction, missingBlocks, type PageKind, readColumns, readFields, type TestAbility, testFile, type TestSpec } from "./resourcetestgen";
import { shellQuote } from "./runconfig";
import { errorText, showError } from "./status";
import { composerCommand } from "./toolpaths";
import { traitsEdits } from "./usergen";

const HAS_FACTORY = "Illuminate\\Database\\Eloquent\\Factories\\HasFactory";
const read = (path: string) => invoke<string>("read_file", { path });
const exists = (path: string) => invoke<boolean>("path_exists", { path }).catch(() => false);

/** Picks a resource and generates its tests. */
export async function resourceTestsPicker() {
  const root = host.root();
  const app = await fapp.app(root).catch((e) => (host.status(`Can't read the app: ${errorText(e)}`), null));
  if (!app) return;
  const items: Item[] = app.panels.flatMap((p) =>
    p.resources.filter((r) => r.file).map((r) => ({ label: r.navigationLabel ?? r.pluralLabel ?? shortClass(r.class), detail: `${p.id} · ${shortClass(r.class)}`, icon: "codicon-beaker", run: () => void generateResourceTests(`${root}/${r.file}`) })),
  );
  pick("Generate tests for a resource", (query) => (query.trim() ? rank(query, items) : items));
}

/**
 * Writes tests for the resource in `file`, or adds the ones its test file lacks, and runs them. Asks first when the
 * project has no Pest, or when models have no factories.
 */
export async function generateResourceTests(file: string) {
  const root = host.root();
  try {
    const app = await fapp.app(root);
    const rel = file.slice(root.length + 1);
    const panel = app.panels.find((p) => p.resources.some((r) => r.file === rel));
    const info = panel?.resources.find((r) => r.file === rel);
    if (!panel || !info) return host.status("Tusk can't find this resource in the app's panels.");

    // Pest, or PHPUnit when the project doesn't have it and you'd rather not install it.
    const composer = await read(`${root}/composer.json`).catch(() => "");
    const style: TestSpec["style"] = /"pestphp\/pest"\s*:/.test(composer) || (await exists(`${root}/tests/Pest.php`)) ? "pest" : "phpunit";
    if (style === "phpunit") {
      const answer = await choose("The project doesn't use Pest. Write PHPUnit tests, or install Pest first?", ["Write PHPUnit tests", "Install Pest, then write Pest tests"]);
      if (!answer) return;
      if (answer.startsWith("Install")) return installPest(() => void generateResourceTests(file));
    }

    host.status(`Reading ${shortClass(info.class)}…`);
    const [facts, policy, form, table] = await Promise.all([fapp.modelFacts(root, info.model), fapp.policy(root, info.model, info.class), rootOf(file, "form"), rootOf(file, "table")]);
    const user = policy.user ?? "App\\Models\\User";

    // Factories for the models the tests make: the resource's and the user's first, then related models' for fields
    // the factory doesn't fill.
    if (!(await ensureFactories([info.model, user]))) return;
    const factoryPath = await fapp.fileOfClass(root, factoryClass(info.model));
    const factory = factoryPath ? classNamed(await fapp.outlineOf(await read(factoryPath), factoryPath), factoryClass(info.model)) : null;
    const fields = form ? readFields(form, facts) : [];
    const keys = factory ? factoryKeys(factory) : null;
    if (!(await ensureFactories(factoriesNeeded({ model: info.model, user, fields, factoryKeys: keys })))) return;

    // The policy's rules for the abilities the pages check.
    let rules: Partial<Record<TestAbility, Rule | null>> | null = null;
    if (policy.file) {
      const path = policy.file.startsWith("/") ? policy.file : `${root}/${policy.file}`;
      const text = await read(path);
      const cls = (await fapp.outlineOf(text, path)).classes.find((c) => c.name);
      if (cls) rules = Object.fromEntries(readPolicy(text, cls, shortClass(info.model)).filter((r) => ["viewAny", "view", "create", "update"].includes(r.ability.name)).map((r) => [r.ability.name, r.rule]));
    }

    const pages: Partial<Record<PageKind, string>> = {};
    for (const p of info.pages) if (p.kind !== "custom" && p.kind !== "related") pages[p.kind] ??= p.class;
    const pest = await read(`${root}/tests/Pest.php`).catch(() => "");
    const dir = (await exists(`${root}/tests/Feature`)) ? "tests/Feature/Filament" : "tests/Filament";
    const className = `${shortClass(info.class)}Test`;
    const spec: TestSpec = {
      style,
      namespace: dir.split("/").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("\\"),
      className,
      label: info.label ?? shortClass(info.model).toLowerCase(),
      plural: info.pluralLabel ?? `${shortClass(info.model).toLowerCase()}s`,
      model: info.model,
      user,
      fields,
      keyName: facts.details.keyName,
      panel: panel.id,
      pages,
      factoryKeys: keys,
      columns: table ? readColumns(table) : [],
      manageEdit: !!table && hasEditAction(table),
      policy: rules ? { rules, spatie: policy.spatie && policy.hasRoles } : null,
      // Laravel's Pest.php applies RefreshDatabase to Feature tests only when the line isn't commented out.
      refreshDatabase: !/^(?!\s*\/\/).*RefreshDatabase/m.test(pest),
    };

    const path = `${root}/${dir}/${className}.php`;
    if (await exists(path)) return addMissing(path, spec);
    await invoke("create_file", { path, contents: testFile(spec) });
    host.status(`Wrote ${dir}/${className}.php. Running it…`);
    host.openAt(path, 1);
    await run(path);
  } catch (e) {
    showError("Can't generate the tests", e);
  }
}

/** A form or table root of the resource, following `PostForm::configure()` to its class. */
async function rootOf(file: string, kind: RootKind): Promise<Root | null> {
  const outline = await fapp.outlineOf(await read(file), file);
  const cls = outline.classes.find((c) => c.name);
  const root = cls && readRoot(cls, kind);
  if (!root?.delegate) return root && !root.custom ? root : null;
  const path = await fapp.fileOfClass(host.root(), root.delegate.class);
  if (!path) return null;
  const other = classNamed(await fapp.outlineOf(await read(path), path), root.delegate.class);
  const inner = other && readRoot(other, kind, root.delegate.method);
  return inner && !inner.custom ? inner : null;
}

/** Offers the tests an existing file lacks, such as one for a field that became required, or opens it. */
async function addMissing(path: string, spec: TestSpec) {
  const name = path.slice(host.root().length + 1);
  const text = (await host.ensureModel(path)).getValue();
  const blocks = missingBlocks(spec, text);
  if (!blocks.length) {
    host.openAt(path, 1);
    return host.status(`${name} has every test Tusk writes for this resource.`);
  }
  const tests = blocks.filter((b) => b.key !== "setup" && b.key !== "refresh").map((b) => b.key);
  const answer = await choose(`${name} exists. It lacks ${tests.length ? tests.map((t) => `“${t}”`).join(", ") : "the setup the tests need"}.`, [`Add ${blocks.length === 1 ? "it" : "them"}`, "Open the file"]);
  if (!answer) return;
  host.openAt(path, 1);
  if (answer === "Open the file") return;
  const done = await editFiles(
    [
      {
        path,
        build: (current, outline) => {
          if (spec.style === "pest") {
            const end = current.trimEnd().length;
            return [{ start: end, end, text: `\n\n${blocks.map((b) => b.code).join("\n\n")}\n` }];
          }
          const cls = outline.classes.find((c) => c.name);
          if (!cls) throw new Error(`${name} has no test class.`);
          // A new setUp() needs the RefreshDatabase trait the class may lack, as the files Tusk writes have.
          const trait = methodNamed(cls, "setUp") ? [] : traitsEdits(current, cls, ["Illuminate\\Foundation\\Testing\\RefreshDatabase"]);
          return [...trait, ...blocks.map((b) => addMember(current, cls, b.code))];
        },
      },
    ],
    `Added ${blocks.length} ${blocks.length === 1 ? "test" : "tests"} to ${name}`,
  );
  if (done) await run(path);
}

/** Runs a test file in the test runner, which shows the results in the Tests tab. */
async function run(path: string) {
  const { runTest } = await import("./runner");
  await runTest(path, { line: 1, name: "all tests in file" });
}

/**
 * Makes sure each model has a factory: `HasFactory` on the model and the factory class Laravel looks for. Offers to
 * write the ones that are missing, with the model designer's fakes for each column. Resolves to whether they all
 * have one now.
 */
async function ensureFactories(models: string[]): Promise<boolean> {
  const root = host.root();
  const missing: { details: fapp.ModelDetails; trait: boolean; file: string | null }[] = [];
  const queue = [...models];
  for (let cls = queue.shift(); cls; cls = queue.shift()) {
    if (missing.some((m) => m.details.class === cls)) continue;
    const details = await fapp.model(root, cls);
    const file = await fapp.fileOfClass(root, factoryClass(cls));
    if (details.factory && file) continue;
    missing.push({ details, trait: !details.factory, file });
    // A new factory makes the records its required foreign keys point to, with their factories.
    if (!file) queue.push(...factoryParents(details));
  }
  if (!missing.length) return true;
  const names = missing.map((m) => shortClass(m.details.class));
  if (!(await confirm(`The tests make records with factories. ${names.join(", ")} ${names.length > 1 ? "have" : "has"} none. Make ${names.length > 1 ? "them" : "it"}?`, "Make the factories"))) return false;
  const enums = (await fapp.enums(root).catch(() => [])).map((e) => e.class);
  for (const m of missing) {
    if (m.file) continue;
    const path = `${root}/database/factories/${factoryClass(m.details.class).replace(/^Database\\Factories\\/, "").replace(/\\/g, "/")}.php`;
    await invoke("create_file", { path, contents: factoryFor(m.details, enums) });
  }
  const traits = missing.filter((m) => m.trait && m.details.file);
  if (traits.length)
    await editFiles(
      traits.map((m) => ({ path: m.details.file!.startsWith("/") ? m.details.file! : `${root}/${m.details.file}`, build: (text, outline) => {
        const cls = classNamed(outline, m.details.class);
        return cls ? traitsEdits(text, cls, [HAS_FACTORY]) : null;
      } })),
      `Made factories for ${names.join(", ")}`,
    );
  fapp.forget(["model:", "models"]);
  return true;
}

/** Installs Pest with its Laravel plugin in a terminal tab, then calls `done`. */
async function installPest(done: () => void) {
  const composer = composerCommand(await toolPath("composer/composer.phar")).map(shellQuote).join(" ");
  const line = `${composer} require pestphp/pest pestphp/pest-plugin-laravel --dev --with-all-dependencies --no-interaction && vendor/bin/pest --init`;
  host.openTerminal("Install Pest", ["/bin/sh", "-c", line], done);
}
