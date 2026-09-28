// Changes to the user model that panel features need: contracts and traits for two-factor sign-in, the columns
// they store their secrets in, and the methods tenancy asks for. No editor imports, so Node tests it.
import { addMember, type Edit, type OClass, phpString } from "./phpcode.ts";

const short = (fqn: string) => fqn.slice(fqn.lastIndexOf("\\") + 1);

/** Adds interfaces the class doesn't implement yet, as `{{Fqn}}` names. */
export function implementsEdits(text: string, cls: OClass, fqns: string[]): Edit[] {
  const has = new Set(cls.implements.map((i) => short(i).toLowerCase()));
  const missing = fqns.filter((f) => !has.has(short(f).toLowerCase()));
  if (!missing.length) return [];
  const names = missing.map((f) => `{{${f}}}`).join(", ");
  // The declaration runs from the class's start to its opening brace.
  const open = text.lastIndexOf("{", cls.bodyStart);
  const head = text.slice(cls.span[0], open);
  if (cls.implements.length) {
    const end = cls.span[0] + head.trimEnd().length;
    return [{ start: end, end, text: `, ${names}` }];
  }
  const at = cls.span[0] + head.trimEnd().length;
  return [{ start: at, end: at, text: ` implements ${names}` }];
}

/** Adds traits the class doesn't use yet, after the traits it uses, or at the top of its body. */
export function traitsEdits(text: string, cls: OClass, fqns: string[]): Edit[] {
  const has = new Set(cls.traits.map((t) => short(t).toLowerCase()));
  const missing = fqns.filter((f) => !has.has(short(f).toLowerCase()));
  if (!missing.length) return [];
  const body = text.slice(cls.bodyStart, cls.bodyEnd);
  const uses = [...body.matchAll(/^[ \t]*use\s+[^;(]+;[ \t]*$/gm)];
  const lines = missing.map((f) => `    use {{${f}}};`).join("\n");
  if (uses.length) {
    const last = uses[uses.length - 1];
    const at = cls.bodyStart + last.index! + last[0].length;
    return [{ start: at, end: at, text: `\n${lines}` }];
  }
  return [{ start: cls.bodyStart, end: cls.bodyStart, text: `\n${lines}\n` }];
}

export const MFA_COLUMNS: Record<string, string> = {
  app_authentication_secret: "$table->text('app_authentication_secret')->nullable();",
  app_authentication_recovery_codes: "$table->text('app_authentication_recovery_codes')->nullable();",
  has_email_authentication: "$table->boolean('has_email_authentication')->default(false);",
};

/** A migration that adds columns to a table, and drops them when rolled back. */
export function addColumnsMigration(table: string, columns: string[]): string {
  const add = columns.map((c) => `            ${MFA_COLUMNS[c]}`).join("\n");
  return `<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table(${phpString(table)}, function (Blueprint $table) {
${add}
        });
    }

    public function down(): void
    {
        Schema::table(${phpString(table)}, function (Blueprint $table) {
            $table->dropColumn([${columns.map(phpString).join(", ")}]);
        });
    }
};
`;
}

/** A migration's file name, as `make:migration` names them. */
export function migrationName(name: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}_${p(now.getMonth() + 1)}_${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}_${name}.php`;
}

// ---- Tenancy ----

export const HAS_TENANTS = "Filament\\Models\\Contracts\\HasTenants";

/**
 * The methods HasTenants asks for, through the user's relationship to the tenant model: the tenants a user
 * belongs to, and whether they may open one.
 */
export function tenantMethods(relation: { name: string; type: string }): string[] | null {
  const r = relation.name;
  const panel = "{{Filament\\Panel}}";
  const model = "{{Illuminate\\Database\\Eloquent\\Model}}";
  const collection = "{{Illuminate\\Support\\Collection}}";
  if (/^(BelongsToMany|MorphToMany|HasMany)$/.test(relation.type))
    return [
      `/** The ${r} the user belongs to, which the panel lets them switch between. */\npublic function getTenants(${panel} $panel): array | ${collection}\n{\n    return $this->${r};\n}`,
      `public function canAccessTenant(${model} $tenant): bool\n{\n    return $this->${r}()->whereKey($tenant)->exists();\n}`,
    ];
  if (/^(BelongsTo|HasOne|MorphTo)$/.test(relation.type))
    return [
      `/** The user's ${r}: the one tenant they work in. */\npublic function getTenants(${panel} $panel): array | ${collection}\n{\n    return collect([$this->${r}])->filter();\n}`,
      `public function canAccessTenant(${model} $tenant): bool\n{\n    return $this->${r}?->is($tenant) ?? false;\n}`,
    ];
  return null;
}

/** Adds HasTenants and its methods to the user model. */
export function userTenantEdits(text: string, cls: OClass, relation: { name: string; type: string }): Edit[] | null {
  const methods = tenantMethods(relation);
  if (!methods) return null;
  const has = new Set(cls.methods.map((m) => m.name));
  return [...implementsEdits(text, cls, [HAS_TENANTS]), ...methods.filter((m) => !has.has(/function (\w+)/.exec(m)![1])).map((m) => addMember(text, cls, m))];
}

/** Removes a trait's `use` line from a class body, with the blank line after it. */
export function removeTraitEdits(text: string, cls: OClass, fqn: string): Edit[] {
  const name = short(fqn);
  const m = new RegExp(`\\n[ \\t]*use\\s+\\\\?(?:[\\w\\\\]*\\\\)?${name}\\s*;[ \\t]*(?:\\n[ \\t]*(?=\\n))?`).exec(text.slice(cls.bodyStart, cls.bodyEnd));
  return m ? [{ start: cls.bodyStart + m.index, end: cls.bodyStart + m.index + m[0].length, text: "" }] : [];
}
