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

// Blade templates get their own language, so PHP-only servers skip them. The grammar is Monaco's
// PHP/HTML grammar with Blade states in front: echoes, directive arguments, and @php blocks hold PHP,
// highlighted by the PHP grammar's own phpRoot rules, and they work inside tags and attribute values too.
monaco.languages.register({ id: "blade", extensions: [".blade.php"], aliases: ["Blade"] });
monaco.languages.onLanguage("blade", async () => {
  const php = await import("monaco-editor/languages/definitions/php/php.js");
  const t = php.language.tokenizer;
  type Rule = monaco.languages.IMonarchLanguageRule;
  // Blade that can appear anywhere: in text, in tags, and in attribute values.
  const blade: Rule[] = [
    [/\{\{--/, "comment.blade", "@bladeComment"],
    [/@\{\{/, ""], // @{{ prints braces literally
    [/\{\{|\{!!/, "delimiter.blade", "@bladeEcho"],
    // Monarch reads @name in a regex as a reference to a grammar attribute, so write the at sign as [@].
    [/[@]php\b(?!\s*\()/, "keyword.blade", "@bladePhp"],
    [/(@\w+)(\s*)(\()/, ["keyword.blade", "", { token: "delimiter.parenthesis.php", next: "@bladeArgs" }]],
    [/@\w+/, "keyword.blade"],
  ];
  // <x-card.header>, <livewire:counter>. <script> and <style> keep the PHP grammar's JS and CSS states.
  const tagName = /(<\/?)((?!script\b|style\b)[\w\-:.]+)/;
  monaco.languages.setLanguageConfiguration("blade", php.conf);
  monaco.languages.setMonarchTokensProvider("blade", {
    ...php.language,
    tokenizer: {
      ...t,
      root: [
        ...blade,
        [tagName, ["delimiter.html", { token: "tag.html", next: "@bladeTag" }]],
        // The PHP grammar's text rule would swallow Blade syntax, so stop text at `@` and `{`.
        ...t.root.map((rule) => (Array.isArray(rule) && String(rule[0]) === String(/[^<]+/) ? ([/[^<@{]+|[@{]/, ""] as Rule) : rule)),
      ],
      bladeTag: [
        [/\/?>/, "delimiter.html", "@pop"],
        ...blade,
        // :title="$post->title" binds a PHP expression.
        [/(:[\w\-:.]+)(\s*)(=)(\s*)(")/, ["attribute.name", "", "delimiter", "", { token: "attribute.value", next: "@bladeBound" }]],
        [/"/, "attribute.value", "@bladeValueDouble"],
        [/'/, "attribute.value", "@bladeValueSingle"],
        [/[\w\-:.]+/, "attribute.name"],
        [/=/, "delimiter"],
        [/[ \t\r\n]+/, ""],
      ],
      bladeValueDouble: [[/"/, "attribute.value", "@pop"], ...blade, [/[^"{@]+|[{@]/, "attribute.value"]],
      bladeValueSingle: [[/'/, "attribute.value", "@pop"], ...blade, [/[^'{@]+|[{@]/, "attribute.value"]],
      bladeBound: [[/"/, "attribute.value", "@pop"], { include: "phpRoot" }],
      bladeEcho: [[/\}\}|!!\}/, "delimiter.blade", "@pop"], { include: "phpRoot" }],
      bladeArgs: [
        [/\(/, "delimiter.parenthesis.php", "@bladeArgs"],
        [/\)/, "delimiter.parenthesis.php", "@pop"],
        { include: "phpRoot" },
      ],
      bladePhp: [[/[@]endphp\b/, "keyword.blade", "@pop"], { include: "phpRoot" }],
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
