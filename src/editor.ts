import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === "json") return new JsonWorker();
    if (["css", "scss", "less"].includes(label)) return new CssWorker();
    if (["html", "handlebars", "razor"].includes(label)) return new HtmlWorker();
    if (["typescript", "javascript"].includes(label)) return new TsWorker();
    return new EditorWorker();
  },
};

export { monaco };

export function createEditor(el: HTMLElement) {
  return monaco.editor.create(el, {
    automaticLayout: true,
    fontSize: 13,
    fontFamily: "JetBrains Mono, SF Mono, Menlo, monospace",
    fontLigatures: true,
    lineHeight: 1.6,
    minimap: { enabled: false },
    padding: { top: 8 },
    smoothScrolling: true,
    cursorSmoothCaretAnimation: "on",
    cursorBlinking: "smooth",
    renderLineHighlight: "all",
    scrollBeyondLastLine: false,
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
    guides: { indentation: true, bracketPairs: false },
    bracketPairColorization: { enabled: false },
    stickyScroll: { enabled: true },
    fixedOverflowWidgets: true,
    model: null,
  });
}

// Blade templates get their own language, so PHP-only servers skip them. The grammar is
// Monaco's PHP/HTML grammar with Blade comments, echoes, and directives in front.
// ponytail: Blade rules apply in HTML text only, not inside tags or attributes.
monaco.languages.register({ id: "blade", extensions: [".blade.php"], aliases: ["Blade"] });
monaco.languages.onLanguage("blade", async () => {
  const php = await import("monaco-editor/languages/definitions/php/php.js");
  const t = php.language.tokenizer;
  monaco.languages.setLanguageConfiguration("blade", php.conf);
  monaco.languages.setMonarchTokensProvider("blade", {
    ...php.language,
    tokenizer: {
      ...t,
      root: [
        [/\{\{--/, "comment.blade", "@bladeComment"],
        [/\{\{|\}\}|\{!!|!!\}/, "delimiter.blade"],
        [/@[a-zA-Z]+/, "keyword.blade"],
        // The PHP grammar's text rule would swallow Blade syntax, so stop text at `@`, `{`, `}`, and `!`.
        ...t.root.map((rule) => (Array.isArray(rule) && String(rule[0]) === String(/[^<]+/) ? ([/[^<@{}!]+|[@{}!]/, ""] as monaco.languages.IMonarchLanguageRule) : rule)),
      ],
      bladeComment: [[/--\}\}/, "comment.blade", "@pop"], [/./, "comment.blade"]],
    },
  });
});

// Vue single-file components use Monaco's HTML grammar, which already highlights
// <script> as JavaScript and <style> as CSS. The Vue and TypeScript servers add the rest.
monaco.languages.register({ id: "vue", extensions: [".vue"], aliases: ["Vue"] });
monaco.languages.onLanguage("vue", async () => {
  const html = await import("monaco-editor/languages/definitions/html/html.js");
  monaco.languages.setLanguageConfiguration("vue", html.conf);
  monaco.languages.setMonarchTokensProvider("vue", html.language);
});
