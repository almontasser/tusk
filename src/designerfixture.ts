// Test helper: a designer fixture's PHP and the outline Tusk's server gives it. Regenerate the outlines after
// changing a fixture: `cargo run --example outline -- ../src/fixtures/designer/*.php` in tusk-lsp/.
import { readFileSync } from "node:fs";
import type { Outline } from "./phpcode.ts";

export function fixture(name: string): { text: string; outline: Outline } {
  const dir = new URL("./fixtures/designer/", import.meta.url);
  return { text: readFileSync(new URL(`${name}.php`, dir), "utf8"), outline: JSON.parse(readFileSync(new URL(`${name}.outline.json`, dir), "utf8")) };
}
