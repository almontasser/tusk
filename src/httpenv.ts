// The environment editor: every environment's variables in one table, with a column per environment and a row per
// variable. Private variables go to http-client.private.env.json, which stays out of Git; the rest go to
// http-client.env.json, which the team shares.
import { invoke } from "@tauri-apps/api/core";
import { changed, createEnvironmentFile, dotenv, ENV_FILE, environmentDir, host, ignorePrivateFile, PRIVATE_ENV_FILE } from "./httpclient";
import { envFiles, type EnvRow, type EnvTable, envTable, looksSecret } from "./httpfile";
import { h, iconButton, showHttpPanel } from "./httpview";
import { pick } from "./palette";

const view = h("div", { class: "http-client http-env-editor" });

/** Opens the environment editor for the environment files that apply to `path`, or the project root's for "". */
export async function editEnvironments(path = "") {
  if (!host.root()) return;
  const dir = path ? await environmentDir(path) : host.root();
  // A missing file is empty; a file that isn't JSON stops the editor, so saving can't replace what's in it.
  const read = async (name: string) => {
    const text = await invoke<string>("read_file", { path: `${dir}/${name}` }).catch(() => null);
    return text === null ? null : (JSON.parse(text) as Record<string, Record<string, unknown>>);
  };
  let table: EnvTable;
  try {
    const [shared, secret] = await Promise.all([read(ENV_FILE), read(PRIVATE_ENV_FILE)]);
    table = envTable(shared, secret);
    if (!shared && !secret) {
      table.envs.push("local");
      table.rows.push({ name: "host", private: false, values: { local: (await dotenv()).APP_URL || "http://localhost:8000" } });
    }
  } catch (e) {
    return host.status(`Can't read the environment files, so fix their JSON first: ${e}`);
  }
  render(dir, table);
  showHttpPanel("HTTP Environments", view);
}

/** A cell is missing a value when another environment has one and $shared doesn't cover it. */
const missing = (t: EnvTable, row: EnvRow, env: string) => env !== "$shared" && !row.values[env] && !row.values.$shared && t.envs.some((e) => e !== "$shared" && e !== env && row.values[e]);

function render(dir: string, t: EnvTable) {
  const ask = (placeholder: string, taken: string[], then: (name: string) => void, detail = (_: string) => "") =>
    pick(placeholder, (q) => {
      const name = q.trim();
      const valid = /^[\w.$-]+$/.test(name) && !taken.includes(name);
      return [{ label: valid ? `Add ${name}` : taken.includes(name) ? `${name} already exists` : "Type a name", detail: valid ? detail(name) : "", run: () => valid && (then(name), draw()) }];
    });
  const addVariable = () =>
    ask(
      "Variable name",
      t.rows.map((r) => r.name),
      (name) => t.rows.push({ name, private: looksSecret(name), values: {} }),
      (name) => (looksSecret(name) ? `Private: kept in ${PRIVATE_ENV_FILE}` : `Shared: kept in ${ENV_FILE}`),
    );
  const addEnvironment = () => ask("Environment name, such as staging", t.envs, (name) => t.envs.push(name));
  const removeEnvironment = (env: string) => {
    t.envs = t.envs.filter((e) => e !== env);
    for (const row of t.rows) delete row.values[env];
    draw();
  };
  const openJson = (file: string) => (dir === host.root() ? createEnvironmentFile(file) : host.openAt(`${dir}/${file}`, 1).catch(() => host.status(`${file} doesn't exist yet. Save to create it.`)));

  const variableRow = (row: EnvRow, index: number) => {
    const name = h("input", { value: row.name, spellcheck: false, title: "Name. Requests use it as {{name}}" });
    name.oninput = () => (row.name = name.value.trim());
    const secret = h("input", { type: "checkbox", checked: row.private, title: `Private values go in ${PRIVATE_ENV_FILE}, which Git ignores` });
    secret.onchange = () => (row.private = secret.checked);
    const inputs = t.envs.map((env) => h("input", { value: row.values[env] ?? "", spellcheck: false }));
    // Empty cells show the $shared value they get, and a mark when other environments have a value.
    const mark = () =>
      inputs.forEach((input, i) => {
        input.placeholder = t.envs[i] === "$shared" ? "" : (row.values.$shared ?? "");
        input.classList.toggle("missing", missing(t, row, t.envs[i]));
        input.title = input.classList.contains("missing") ? `Not set in ${t.envs[i]}, but set in other environments` : "";
      });
    inputs.forEach((input, i) => (input.oninput = () => ((row.values[t.envs[i]] = input.value === "" ? undefined : input.value), mark())));
    mark();
    return h(
      "tr",
      {},
      h("td", {}, name),
      h("td", { class: "http-env-private" }, secret),
      ...inputs.map((input) => h("td", {}, input)),
      h("td", {}, iconButton("close", "Remove the variable", () => (t.rows.splice(index, 1), draw()))),
    );
  };

  const save = async () => {
    const names = t.rows.map((r) => r.name).filter(Boolean);
    const twice = names.find((n, i) => names.indexOf(n) !== i);
    if (twice) return host.status(`${twice} is in the table twice. Rename or remove one, then save.`);
    const { shared, secret } = envFiles(t);
    const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
    const privatePath = `${dir}/${PRIVATE_ENV_FILE}`;
    try {
      await invoke("write_file", { path: `${dir}/${ENV_FILE}`, contents: json(shared) });
      if (Object.keys(secret).length || (await invoke<boolean>("path_exists", { path: privatePath }))) {
        await invoke("write_file", { path: privatePath, contents: json(secret) });
        await ignorePrivateFile();
      }
    } catch (e) {
      return host.status(`Couldn't save the environments: ${e}`);
    }
    changed();
    host.status(`Saved the environments in ${dir.replace(host.root(), "") || "the project root"}`);
  };

  const draw = () => {
    const head = h(
      "tr",
      {},
      h("th", {}, "Variable"),
      h("th", { title: `Private values go in ${PRIVATE_ENV_FILE}, which Git ignores` }, "Private"),
      ...t.envs.map((env) =>
        h("th", { title: env === "$shared" ? "Values every environment gets, unless it sets its own" : "" }, h("span", {}, env), env === "$shared" ? null : iconButton("close", `Remove ${env}`, () => removeEnvironment(env))),
      ),
      h("th", {}, iconButton("add", "Add an environment", addEnvironment)),
    );
    view.replaceChildren(
      h(
        "div",
        { class: "http-bar" },
        h("strong", {}, "Environments"),
        h("span", { class: "muted" }, `${dir.replace(host.root(), "") || "Project root"}`),
        h("span", { class: "http-spacer" }),
        h("button", { textContent: "Open JSON", onclick: () => openJson(ENV_FILE) }),
        h("button", { textContent: "Open Private JSON", onclick: () => openJson(PRIVATE_ENV_FILE) }),
        h("button", { class: "primary", textContent: "Save", onclick: save }),
      ),
      h(
        "div",
        { class: "http-env-list" },
        h("table", { class: "http-table http-env-table" }, h("thead", {}, head), h("tbody", {}, ...t.rows.map(variableRow))),
        h("button", { class: "link http-add", textContent: "+ Add variable", onclick: addVariable }),
        h("p", { class: "http-hint" }, `Requests use a variable as {{name}}. Private values go in ${PRIVATE_ENV_FILE}, which Git ignores, and the rest in ${ENV_FILE}, which your team shares. Changes apply when you save.`),
      ),
    );
  };
  draw();
}
