// Sample records: a model's factory makes as many as you ask for, in the app's database, so a new resource,
// dashboard, or report has something to show. Runs with Artisan (in Sail's container when it's up).
import { h, icon } from "./dom";
import * as fapp from "./filamentapp";
import { host } from "./filamentdesigner";
import { askName } from "./filamentpickers";
import { shortClass } from "./filamentschema";
import { pick, rank, type Item } from "./palette";
import { errorText, showError } from "./status";

/** Asks how many records to make, and makes them with the model's factory. */
export async function addSampleRecords(cls: string, anchor: HTMLElement | { x: number; y: number }) {
  const count = await askName(anchor, { title: `How many ${shortClass(cls)} records?`, value: "10", action: "Make them", validate: (v) => (/^\d+$/.test(v) && Number(v) > 0 && Number(v) <= 10000 ? null : "A number from 1 to 10,000.") });
  if (!count) return;
  host.status(`Making ${count} ${shortClass(cls)} records…`);
  try {
    // One line of PHP; the class comes from the app, so it's a plain name.
    const out = await fapp.artisan(host.root(), ["tinker", "--execute", `echo \\${cls}::factory()->count(${Number(count)})->create()->count();`]);
    const made = /(\d+)\s*$/.exec(out.trim())?.[1] ?? count;
    fapp.forget(["model:", "models"]);
    host.status(`Made ${made} ${shortClass(cls)} records.`);
  } catch (e) {
    showError(`Can't make ${shortClass(cls)} records`, e);
  }
}

/** Picks a model with a factory, and makes sample records of it. */
export async function sampleRecordsPicker() {
  const root = host.root();
  const models = await fapp.models(root).catch((e) => (host.status(`Can't read the models: ${errorText(e)}`), null));
  if (!models) return;
  const items: Item[] = Object.values(models).map((m) => ({
    label: shortClass(m.class),
    detail: m.class,
    icon: "codicon-database",
    run: async () => {
      const details = await fapp.model(root, m.class).catch(() => null);
      if (!details?.factory) return host.status(`${shortClass(m.class)} has no factory. The model designer can write one.`);
      void addSampleRecords(m.class, { x: innerWidth / 2 - 150, y: 120 });
    },
  }));
  pick("Sample records: pick a model", (query) => (query.trim() ? rank(query, items) : items));
}

/** The model designer's button for sample records, for a model with a factory. */
export const sampleButton = (cls: string) => {
  const b = h("button", { type: "button", class: "fd-chip-link", title: "Make records with the model's factory" }, icon("beaker"), "Sample records");
  b.onclick = () => void addSampleRecords(cls, b);
  return b;
};
