/// <reference types="vite/client" />

declare module "monaco-editor/languages/definitions/php/php.js" {
  import type { languages } from "monaco-editor";
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage & { tokenizer: Record<string, languages.IMonarchLanguageRule[]> };
}

declare module "monaco-editor/languages/definitions/html/html.js" {
  import type { languages } from "monaco-editor";
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}
