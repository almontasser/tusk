// Which formatter each language uses, per project. Free of editor imports so Node can test it.

export type FormatterId = "auto" | "pint" | "php-cs-fixer" | "mago" | "prettier" | "blade-formatter" | "builtin" | "none";

/** The languages the Formatters dialog lists, each with Monaco's language IDs and the formatters it offers. */
export const FORMAT_GROUPS: { id: string; label: string; languages: string[]; formatters: FormatterId[] }[] = [
  { id: "php", label: "PHP", languages: ["php"], formatters: ["auto", "pint", "php-cs-fixer", "mago", "prettier", "none"] },
  { id: "blade", label: "Blade", languages: ["blade"], formatters: ["auto", "blade-formatter", "prettier", "none"] },
  { id: "js", label: "JavaScript, TypeScript, and Vue", languages: ["javascript", "typescript", "vue"], formatters: ["auto", "prettier", "builtin", "none"] },
  { id: "css", label: "CSS, SCSS, and Less", languages: ["css", "scss", "less"], formatters: ["auto", "prettier", "builtin", "none"] },
  { id: "json", label: "JSON", languages: ["json"], formatters: ["auto", "prettier", "builtin", "none"] },
  { id: "markdown", label: "Markdown", languages: ["markdown"], formatters: ["auto", "prettier", "none"] },
  { id: "yaml", label: "YAML", languages: ["yaml"], formatters: ["auto", "prettier", "none"] },
];

export const FORMATTER_NAMES: Record<FormatterId, string> = {
  auto: "Auto",
  pint: "Laravel Pint",
  "php-cs-fixer": "PHP CS Fixer",
  mago: "Mago",
  prettier: "Prettier",
  "blade-formatter": "blade-formatter",
  builtin: "Built-in",
  none: "None",
};

/** The project's `formatters` value: a formatter and a format-on-save choice per group, both optional. */
export type FormatterChoices = Record<string, { use?: FormatterId; onSave?: boolean }>;

export const groupOf = (language: string) => FORMAT_GROUPS.find((g) => g.languages.includes(language));

/** The formatter a language uses: the project's valid choice, else Auto. Languages outside the groups use Auto. */
export function formatterFor(choices: FormatterChoices | undefined, language: string): FormatterId {
  const group = groupOf(language);
  const use = group && choices?.[group.id]?.use;
  return use && group.formatters.includes(use) ? use : "auto";
}

/** Whether saving a file of `language` formats it: the project's choice for its group, else the global setting. */
export function formatsOnSave(choices: FormatterChoices | undefined, language: string, global: boolean): boolean {
  const group = groupOf(language);
  const onSave = group && choices?.[group.id]?.onSave;
  return typeof onSave === "boolean" ? onSave : global;
}

/** How to install a formatter a project lacks, for the error that says it's missing. */
export const INSTALL_HINTS: Partial<Record<FormatterId, string>> = {
  pint: "Install it in the project with: composer require laravel/pint --dev",
  "php-cs-fixer": "Install it in the project with: composer require friendsofphp/php-cs-fixer --dev",
  prettier: "Install it in the project with: npm install --save-dev prettier",
};
