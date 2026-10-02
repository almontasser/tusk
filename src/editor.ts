import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { isWindows } from "./platform.ts";

self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === "json") return new JsonWorker();
    if (["css", "scss", "less"].includes(label)) return new CssWorker();
    if (["html", "handlebars", "razor"].includes(label)) return new HtmlWorker();
    if (["typescript", "javascript"].includes(label)) return new TsWorker();
    return new EditorWorker();
  },
};

// The app writes paths with `/` on Windows too (see platform.ts), so a URI's `fsPath` does as well.
if (isWindows) {
  for (let proto = Object.getPrototypeOf(monaco.Uri.file("/")); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    const fsPath = Object.getOwnPropertyDescriptor(proto, "fsPath");
    if (fsPath?.get) Object.defineProperty(proto, "fsPath", { ...fsPath, get() { return (fsPath.get!.call(this) as string).replaceAll("\\", "/"); } });
  }
}

export { monaco };

export function createEditor(el: HTMLElement) {
  return monaco.editor.create(el, {
    automaticLayout: true,
    fontSize: 13,
    fontFamily: "JetBrains Mono, JetBrainsMono Nerd Font Mono, JetBrainsMono Nerd Font, SF Mono, Menlo, Cascadia Mono, Consolas, DejaVu Sans Mono, monospace",
    fontLigatures: true,
    lineHeight: 1.6,
    minimap: { enabled: false },
    padding: { top: 8 },
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
  // Inside <script> and <style>, JavaScript or CSS is an embedded language. Blade there leaves it and comes back
  // after, as the PHP grammar does for <?php … ?>: state `blade…In.<state>.<language>` returns to `<state>.<language>`.
  const back = (token: string) => ({ token, switchTo: "@$S2.$S3", nextEmbedded: "$S3" });
  const leave = (token: string, to: string, state: string) => ({ token, switchTo: `@${to}.${state}.$S2`, nextEmbedded: "@pop" });
  const directive = /[@](?:json|js|if|elseif|else|endif|unless|endunless|isset|endisset|foreach|endforeach|for|endfor|forelse|empty|endforelse|while|endwhile|switch|case|break|default|endswitch|include|vite|can|endcan|cannot|endcannot|env|endenv|push|endpush|stack|section|endsection|yield|auth|endauth|guest|endguest|csrf|once|endonce|production|endproduction)\b/;
  const embedded = (state: string, directives: boolean): Rule[] => [
    [/\{\{--/, leave("comment.blade", "bladeCommentIn", state)],
    [/\{\{|\{!!/, leave("delimiter.blade", "bladeEchoIn", state)],
    // Only in scripts: CSS has at-rules of its own, such as @media and Tailwind's @apply. Monarch only looks at
    // rules that leave the embedded language, so a directive leaves first and is read in bladeDirectiveIn.
    ...(directives
      ? ([
          [/[@]php\b(?!\s*\()/, leave("keyword.blade", "bladePhpIn", state)],
          [directive, { token: "@rematch", switchTo: `@bladeDirectiveIn.${state}.$S2`, nextEmbedded: "@pop" }],
        ] as Rule[])
      : []),
  ];
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
      scriptEmbedded: [...embedded("scriptEmbedded", true), ...t.scriptEmbedded],
      styleEmbedded: [...embedded("styleEmbedded", false), ...t.styleEmbedded],
      bladeEchoIn: [[/\}\}|!!\}/, back("delimiter.blade")], { include: "phpRoot" }],
      bladeCommentIn: [[/--\}\}/, back("comment.blade")], [/./, "comment.blade"]],
      bladePhpIn: [[/[@]endphp\b/, back("keyword.blade")], { include: "phpRoot" }],
      bladeDirectiveIn: [
        [/([@]\w+)(\s*)(\()/, ["keyword.blade", "", { token: "delimiter.parenthesis.php", switchTo: "@bladeArgsIn.$S2.$S3" }]],
        [/[@]\w+/, back("keyword.blade")],
      ],
      bladeArgsIn: [[/\(/, "delimiter.parenthesis.php", "@bladeArgs"], [/\)/, back("delimiter.parenthesis.php")], { include: "phpRoot" }],
    },
  });
});

// Enter in a docblock continues it with a `*` under the one above, as VS Code does for TypeScript. Monaco's PHP config
// has no Enter rules, and it merges configs field by field, so this adds to it.
monaco.languages.setLanguageConfiguration("php", {
  onEnterRules: [
    // /** | */
    { beforeText: /^\s*\/\*\*(?!\/)([^*]|\*(?!\/))*$/, afterText: /^\s*\*\/$/, action: { indentAction: monaco.languages.IndentAction.IndentOutdent, appendText: " * " } },
    // /** …|
    { beforeText: /^\s*\/\*\*(?!\/)([^*]|\*(?!\/))*$/, action: { indentAction: monaco.languages.IndentAction.None, appendText: " * " } },
    //  * …| under a docblock line, so a line of code that starts with `*` isn't continued.
    { beforeText: /^\s*\*(\s([^*]|\*(?!\/))*)?$/, previousLineText: /^\s*(\/\*\*|\*)/, action: { indentAction: monaco.languages.IndentAction.None, appendText: "* " } },
    //  */| goes back to the indentation of the /**.
    { beforeText: /^\s*\*\/\s*$/, action: { indentAction: monaco.languages.IndentAction.None, removeText: 1 } },
  ],
});

// Unified diffs, such as the one Mago adds to a type mismatch to show where two types differ.
monaco.languages.register({ id: "diff", extensions: [".diff", ".patch"], aliases: ["Diff"] });
monaco.languages.setMonarchTokensProvider("diff", {
  tokenizer: { root: [[/^(---|\+\+\+|@@).*$/, "meta.diff"], [/^\+.*$/, "inserted.diff"], [/^-.*$/, "deleted.diff"], [/.*$/, ""]] },
});

// `.env` files get a language of their own, so Tusk's server can complete keys and offer fixes in them. The
// grammar reads them as phpdotenv does: `#` comments, `export`, quoted values that span lines, and `${VAR}` references.
monaco.languages.register({ id: "dotenv", filenames: [".env"], filenamePatterns: [".env.*"], aliases: ["Environment"] });
monaco.languages.setLanguageConfiguration("dotenv", {
  comments: { lineComment: "#" },
  autoClosingPairs: [{ open: '"', close: '"' }, { open: "'", close: "'" }, { open: "${", close: "}" }],
});
monaco.languages.setMonarchTokensProvider("dotenv", {
  tokenizer: {
    root: [
      [/^\s*#.*$/, "comment"],
      [/^(\s*)(export\s+|)([A-Za-z_][\w.]*)(\s*)(=)/, ["", "keyword", "key", "", "delimiter"]],
      [/"/, "string", "@double"],
      [/'/, "string", "@single"],
      [/\s+#.*$/, "comment"],
      [/(?:true|false|null|empty)(?=\s*(?:#|$))/i, "constant"],
      [/-?\d+(?:\.\d+)?(?=\s*(?:#|$))/, "number"],
      [/\$\{[^}]*\}/, "variable"],
      [/[^\s"'$#]+|[$#]/, "string"],
    ],
    double: [
      [/"/, "string", "@pop"],
      [/\\./, "string.escape"],
      [/\$\{[^}]*\}/, "variable"],
      [/[^"\\$]+|\$/, "string"],
    ],
    single: [
      [/'/, "string", "@pop"],
      [/[^']+/, "string"],
    ],
  },
});

// Vue, Svelte, and Astro components use Monaco's HTML grammar, which highlights <script> as JavaScript
// and <style> as CSS. They pick the language with lang="ts" or lang="scss" rather than type, so those
// rules switch to the grammar's custom-type states. The Vue and TypeScript servers add the rest for Vue.
/** Monaco's HTML grammar, with lang="ts" and lang="scss" choosing the script and style languages. */
async function componentGrammar(frontmatter: boolean): Promise<monaco.languages.IMonarchLanguage> {
  const html = await import("monaco-editor/languages/definitions/html/html.js");
  const t = html.language.tokenizer;
  return {
    ...html.language,
    tokenizer: {
      ...t,
      // Astro's --- fence at the top of the file holds TypeScript.
      root: frontmatter ? [[/^---\s*$/, { token: "delimiter", next: "@frontmatter", nextEmbedded: "typescript" }], ...t.root] : t.root,
      frontmatter: [[/^---\s*$/, { token: "@rematch", switchTo: "@frontmatterEnd", nextEmbedded: "@pop" }]],
      frontmatterEnd: [[/^---\s*$/, "delimiter", "@pop"]],
      script: [[/lang\s*=\s*["'](?:ts|tsx|typescript)["']/, { token: "attribute.value", switchTo: "@scriptWithCustomType.typescript" }], ...t.script],
      style: [[/lang\s*=\s*["'](scss|less)["']/, { token: "attribute.value", switchTo: "@styleWithCustomType.$1" }], ...t.style],
    },
  };
}
for (const [id, extension, alias] of [["vue", ".vue", "Vue"], ["svelte", ".svelte", "Svelte"], ["astro", ".astro", "Astro"]]) {
  monaco.languages.register({ id, extensions: [extension], aliases: [alias] });
  monaco.languages.onLanguage(id, async () => {
    const html = await import("monaco-editor/languages/definitions/html/html.js");
    monaco.languages.setLanguageConfiguration(id, html.conf);
    monaco.languages.setMonarchTokensProvider(id, await componentGrammar(id === "astro"));
  });
}
