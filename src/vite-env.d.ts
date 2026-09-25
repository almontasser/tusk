/// <reference types="vite/client" />

declare module "monaco-editor/languages/definitions/php/php.js" {
  import type { languages } from "monaco-editor";
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage & { tokenizer: Record<string, languages.IMonarchLanguageRule[]> };
}

declare module "monaco-editor/languages/definitions/javascript/javascript.js" {
  import type { languages } from "monaco-editor";
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}

declare module "monaco-editor/languages/definitions/html/html.js" {
  import type { languages } from "monaco-editor";
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}

// Monaco internals for breadcrumbs.ts: the outline service that sticky scroll uses, and symbol icons.
declare module "monaco-editor/editor/standalone/browser/standaloneServices.js" {
  export const StandaloneServices: { get<T>(id: { readonly service?: T }): T };
}
declare module "monaco-editor/editor/contrib/documentSymbols/browser/outlineModel.js" {
  import type { CancellationToken, editor, languages } from "monaco-editor";
  type OutlineModelService = { getOrCreate(model: editor.ITextModel, token: CancellationToken): Promise<{ getTopLevelSymbols(): languages.DocumentSymbol[] }> };
  export const IOutlineModelService: { readonly service?: OutlineModelService };
}
declare module "monaco-editor/editor/common/languages.js" {
  import type { languages } from "monaco-editor";
  export const SymbolKinds: { toIcon(kind: languages.SymbolKind): { id: string } };
}
