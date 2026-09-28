// Monaco's own editing commands as app actions, so they're in Find Action, the keymap editor, and the menus.
// Keys are PhpStorm's where it has them, else Monaco's. A chord such as `Meta+K Meta+X` is Monaco's own binding,
// shown for reference; the app's key handler doesn't run chords.

/** Where a command goes in the menu bar; `menu.ts` places each group. */
export type Group = "find" | "carets" | "lines" | "case" | "indent" | "comment" | "code" | "navigate" | "folding" | "fold-level";

/** [label, Monaco action id, keys, menu group]. */
export const EDITOR_COMMANDS: [string, string, string, Group][] = [
  ["Find…", "actions.find", "Meta+F", "find"],
  ["Replace…", "editor.action.startFindReplaceAction", "Meta+R", "find"],
  ["Find Next", "editor.action.nextMatchFindAction", "Meta+G", "find"],
  ["Find Previous", "editor.action.previousMatchFindAction", "Meta+Shift+G", "find"],
  ["Add Selection for Next Occurrence", "editor.action.addSelectionToNextFindMatch", "Ctrl+G", "carets"],
  ["Select All Occurrences", "editor.action.selectHighlights", "Ctrl+Meta+G", "carets"],
  ["Change All Occurrences", "editor.action.changeAll", "", "carets"],
  ["Add Caret Above", "editor.action.insertCursorAbove", "Alt+Meta+ArrowUp", "carets"],
  ["Add Caret Below", "editor.action.insertCursorBelow", "Alt+Meta+ArrowDown", "carets"],
  ["Add Carets to Line Ends", "editor.action.insertCursorAtEndOfEachLineSelected", "Alt+Shift+G", "carets"],
  ["Join Lines", "editor.action.joinLines", "Ctrl+Shift+J", "lines"],
  ["Transpose Characters", "editor.action.transpose", "", "lines"],
  ["Sort Lines Ascending", "editor.action.sortLinesAscending", "", "lines"],
  ["Sort Lines Descending", "editor.action.sortLinesDescending", "", "lines"],
  ["Reverse Lines", "editor.action.reverseLines", "", "lines"],
  ["Delete Duplicate Lines", "editor.action.removeDuplicateLines", "", "lines"],
  ["Trim Trailing Whitespace", "editor.action.trimTrailingWhitespace", "Meta+K Meta+X", "lines"],
  ["To Uppercase", "editor.action.transformToUppercase", "", "case"],
  ["To Lowercase", "editor.action.transformToLowercase", "", "case"],
  ["To Title Case", "editor.action.transformToTitlecase", "", "case"],
  ["To camelCase", "editor.action.transformToCamelcase", "", "case"],
  ["To PascalCase", "editor.action.transformToPascalcase", "", "case"],
  ["To snake_case", "editor.action.transformToSnakecase", "", "case"],
  ["To kebab-case", "editor.action.transformToKebabcase", "", "case"],
  ["Indent Line", "editor.action.indentLines", "Meta+BracketRight", "indent"],
  ["Unindent Line", "editor.action.outdentLines", "Meta+BracketLeft", "indent"],
  ["Convert Indents to Spaces", "editor.action.indentationToSpaces", "", "indent"],
  ["Convert Indents to Tabs", "editor.action.indentationToTabs", "", "indent"],
  ["Comment with Line Comment", "editor.action.commentLine", "Meta+Slash", "comment"],
  ["Comment with Block Comment", "editor.action.blockComment", "Alt+Meta+Slash", "comment"],
  ["Basic Completion", "editor.action.triggerSuggest", "Ctrl+Space", "code"],
  ["Auto-Indent Lines", "editor.action.reindentselectedlines", "Ctrl+Alt+I", "code"],
  ["Go to Line/Column…", "editor.action.gotoLine", "Meta+L", "navigate"],
  ["Go to Matching Bracket", "editor.action.jumpToBracket", "Ctrl+M", "navigate"],
  ["Select to Matching Bracket", "editor.action.selectToBracket", "", "navigate"],
  ["Expand", "editor.unfold", "Meta+Equal", "folding"],
  ["Collapse", "editor.fold", "Meta+Minus", "folding"],
  ["Toggle Fold", "editor.toggleFold", "Meta+K Meta+L", "folding"],
  ["Expand Recursively", "editor.unfoldRecursively", "Alt+Meta+Equal", "folding"],
  ["Collapse Recursively", "editor.foldRecursively", "Alt+Meta+Minus", "folding"],
  ["Expand All", "editor.unfoldAll", "Meta+Shift+Equal", "folding"],
  ["Collapse All", "editor.foldAll", "Meta+Shift+Minus", "folding"],
  ["Collapse Doc Comments", "editor.foldAllBlockComments", "Meta+K Meta+Slash", "folding"],
  ["Collapse Regions", "editor.foldAllMarkerRegions", "Meta+K Meta+8", "folding"],
  ["Expand Regions", "editor.unfoldAllMarkerRegions", "Meta+K Meta+9", "folding"],
  ["Fold Selection", "editor.createFoldingRangeFromSelection", "Meta+K Meta+Comma", "folding"],
  ...[1, 2, 3, 4, 5].map((n): [string, string, string, Group] => [`Collapse to Level ${n}`, `editor.foldLevel${n}`, `Meta+K Meta+${n}`, "fold-level"]),
];

/** The labels of a group's commands, in table order. */
export const commandsIn = (group: Group) => EDITOR_COMMANDS.filter((c) => c[3] === group).map((c) => c[0]);
