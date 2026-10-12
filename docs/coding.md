# Coding and refactoring

## Bookmarks

Press F3 to bookmark the current line, and F3 again to remove the bookmark. A
bookmark shows as a blue marker in the gutter and moves with its line as you
edit. You can also right-click the gutter at a line and choose **Add
Bookmark**.

Press ⌥F3 to give the line's bookmark a mnemonic, a digit or a letter, which
the gutter shows instead of the marker. Type the character and press Enter.
⌃1 to ⌃9 jump to the bookmark with that digit. Choosing a mnemonic another
bookmark has moves it to this line.

⌘F3 opens the **Bookmarks** tab in the bottom panel. It groups bookmarks by
file and shows each line's code, even for files that aren't open, with its
mnemonic and description.

- Enter or a double-click goes to the bookmark; ↑ and ↓ move, → and ← open and
  close a file, and typing jumps to a bookmark by its code or description.
- F2 (or the pencil) edits the description in place: Enter keeps it, Escape
  cancels.
- Delete removes the selected bookmark, or a file's bookmarks when a file is
  selected. **Remove all** asks first.
- Drag a bookmark within its file, or a file among the others, to reorder
  them.

Bookmarks are saved in the project's local state, not in `tusk.json`, and
bookmarks from earlier versions move there the first time you open the
project.

## Docblocks

In PHP files, pressing Enter in a `/** … */` docblock starts the new line with a
`*` lined up under the one above, and with the same spaces after it, so what you
type next lines up with the text above, such as an array shape's next key.
Pressing Enter after `*/` goes back to the indentation of the `/**`. Tab in a
docblock line moves to tab stops counted from the text after `* `, not from the
start of the line.

## Snippets

Snippets work like PhpStorm's live templates: type a snippet's prefix, choose
it from the completion list, and press Tab to move between its placeholders.

Run **Edit Snippets (Live Templates)** from ⌘⇧A to open `snippets.json`. The
first time, the file is created with two examples. It uses VS Code's snippet
format, so you can paste snippets from VS Code:

```json
{
  "Laravel route": {
    "scope": "php",
    "prefix": "rget",
    "body": ["Route::get('/${1:path}', [${2:Controller}::class, '${3:index}']);"],
    "description": "A GET route to a controller method"
  }
}
```

`scope` lists language IDs, such as `php,blade`. Leave it out to offer the
snippet in every file. Changes apply as you type in the file.

### Postfix completion

In PHP files, type a dot and a template name after an expression to wrap it, as
in PhpStorm: `$user.if` becomes `if ($user) {}`. The expression can be a
variable, a call, or a chain such as `$this->posts()->first()`.

| Template | Result |
| --- | --- |
| `.if`, `.notnull`, `.null`, `.isset` | `if (expr)`, `if (expr !== null)`, `if (expr === null)`, `if (isset(expr))` |
| `.foreach` | `foreach (expr as $item)` |
| `.return`, `.throw` | `return expr;`, `throw expr;` |
| `.var` | `$var = expr;` |
| `.not`, `.par` | `!expr`, `(expr)` |
| `.dd`, `.dump` | `dd(expr);`, `dump(expr);` |

## Compare files

With a file open, run one of these from ⌘⇧A to open the diff view:

- **Compare with Clipboard** compares the file with the clipboard's text.
- **Compare with File…** compares it with another project file that you
  choose.

The diff shows the editor's text, including unsaved changes.

## Safe delete

Press ⌘⌦ in a class, interface, trait, enum, method, or function to delete it
only if nothing uses it. The editor looks for usages with the PHP server, and also
searches the project's PHP files for the names Laravel uses: a class's full
name in strings (as in config files), and a method's name, its scope name
(`scopePublished` as `published`), or its attribute name (`getFullNameAttribute`
as `full_name`). So `->relationship('author')` counts as a use of `author()`.

- If something uses it, the palette lists the usages. Choose one to open it,
  or choose **Delete anyway**.
- If nothing does, confirm in the palette. A method or function is removed with
  its docblock and attributes (undo with ⌘Z). A class that's alone in its file
  moves the file to the Trash.

## Refactor This

Press ⌃T to list the refactorings that apply at the caret or to the selection,
with their shortcuts, as PhpStorm's **Refactor This** does. The refactorings'
choices open in a small popup below the caret: press a row's number (1 to 9)
or ⏎ to choose, or type to filter. The popup highlights in the editor what each
choice would change. The list: Rename, Change
Signature, the three Extracts, Introduce Field and Parameter, Inline, Pull Members Up, Extract Interface,
Move Class, and Safe Delete, plus
the PHP server's other refactoring actions there. The **Refactor** menu has them all.

## Extract variable, constant, and method

Press ⌥⌘V to put an expression in a new variable. With nothing selected, a
popup at the caret lists the expressions around it, from the innermost, such
as `$item['price']`, `$item['price'] * $item['qty']`, and the whole product.
The PHP server reads the code, so a whole ternary, a `match`, a heredoc, a
closure, or the call that takes the expression is offered too, and the editor
highlights each as you move through the list. A selection that covers only part
of an expression, such as `unt($ite` in `count($items)`, grows to the smallest
whole expression around it, and the status bar says so.

- When the same expression appears more than once in the function, choose
  **Replace all N occurrences** or **Replace this occurrence only**. The editor
  highlights the occurrences, and the scroll bar marks them. Spacing and
  comments don't matter, and a closure's copies, which read its own variables,
  aren't counted.
- The assignment goes before the statement that holds the first use, in the
  innermost block that holds them all, so it lands inside a loop, an `else`, or
  a `case` when the uses are there. A statement that's only the expression,
  such as `foo();`, becomes the assignment. Inside a string, as in
  `"Hi $user->name"`, the variable is written `{$name}`.
- The server suggests a name from the expression: `$user->getEmail()` gives
  `$email`, `$item['unit_price']` gives `$unitPrice`, `new Invoice()` gives
  `$invoice`, and a value of a class type the class's name. Every copy of the
  name is framed; type another name and every copy follows. A hint above it
  reminds you that ⏎ or Escape finishes, and ⌘Z undoes the whole extraction.
- When an occurrence runs only sometimes, such as on the right of `&&` or `??`,
  in a ternary's branch, or in a `match` arm, the occurrences popup says so:
  **Will run every time, not only when $n > 1 is true**. With one occurrence,
  the hint above the new name says it. For Introduce Parameter, an enclosing
  `if` or `else` counts too, since every call would compute the value.
- When the expression can't be extracted, a hint at the caret says why: it's
  written to (`$a['x'] = 1`), it uses an arrow function's parameters, or it's
  a declaration's default value, for example.

**Extract variable**, **Extract constant**, and **Introduce field** are also in
the ⌥⏎ menu on a selection, and run the same way.

Press ⌥⌘C on a string or number, or on an expression of literals and
constants, such as `self::LIMIT * 2`, to extract a class constant. It works the
same way: choose among the constant expressions around the caret, choose the
occurrences in the class, and type the name. `'pending review'` suggests
`PENDING_REVIEW`. The constant is `private` (`public` in an interface) and goes
after the class's other constants, or after its trait uses and enum cases, or
at the top. Uses become `self::NAME`, in property defaults and other constants
too.

Press ⌥⌘F in a method to put an expression in a new private property,
PhpStorm's **Introduce Field**. A constant expression, such as `1.14`, becomes
the property's default; anything else is assigned with `$this->name = …` before
its first use, and its uses become `$this->name` (`self::$name` in a static
method). The property goes after the class's other properties, or after its
constants, typed with the expression's type from the analyzer, with an import
when it names a class.

Press ⌥⌘P to make an expression a new parameter of its method, PhpStorm's
**Introduce Parameter**. The **Change Signature** dialog opens with the
parameter added, named and typed by the server, and its name selected; a
constant expression becomes its default, and anything else the value passed in
existing calls. The expression can't use the method's variables or `$this`,
which don't exist at the calls, nor, unless it's a constant, `self`, `static`,
or `parent`, which would name the calling class.

When you only add the parameter in the dialog, the PHP server writes the
change: the declaration, the methods that override it, and every call,
including `new` for a constructor. A call passes the expression, with an
import when it names a class, and a call that leaves out optional arguments
before the new parameter passes it by name. A parameter without a default
can't go on a method that overrides, or is overridden by, another one, whose
signatures must still match. Other editors get **Introduce parameter** as a
code action.

Press ⌥⌘M to extract the selection, or an expression chosen as above, into a
method. The PHP server writes the method with its parameters and return type; you
then type its name in place.

## Inline

Press ⌥⌘N on a variable, a constant, or a method or function, at its
declaration or at a use, to replace its uses with its value or body, as
PhpStorm's **Inline** does. The PHP server reads the code and writes the edit.
A popup at the caret offers the choices: inline every use and remove the
declaration, inline every use and keep it, or inline only the use under the
cursor. The editor highlights what each choice changes. When the change would
make something run differently, such as a call that would run three times
instead of once, each choice says so, and you decide. ⌘Z undoes the whole
change, in every file it touched.

- The value gets parentheses only where the code around it would bind tighter:
  `$total * 2` with `$total = $a + $b` becomes `($a + $b) * 2`, and
  `[$total]` becomes `[$a + $b]`. In a string, a value that starts with `$`
  goes in braces, as in `"Hi {$user->name}"`. A heredoc or a multi-line array
  moves with its lines' indentation.
- When it can't inline at all, a hint at the caret says why. Places it has to
  leave, such as a call from another class to a method that reads private
  properties, show in the **Refactoring Preview** with the reason, and the rest
  applies from there.
- Other editors get it as a `refactor.inline` code action, which inlines every
  use.

**Variables.** Inline works on a variable that a statement of its own assigns
once, as `$total = $a + $b;`, in the block that holds its uses. It refuses, and
says why, when the variable is a parameter, a closure captures it with `use`,
something changes it later (including a function that takes it by reference,
such as `sort($items)`), a variable its value reads changes before a use, or
the function reads its variables by name with `compact()` or `extract()`.

**Constants.** On a class constant or a global `const`, its uses take its
value. Uses through subclasses count, unless a subclass declares its own. The
value's names are written so they mean the same in each file: `self::BASE`
becomes `Order::BASE` elsewhere, and a class the file doesn't import gets a
`use` line. A use that can't reach what the value names, such as a private
constant, is left. A constant declared with others in one statement is removed
from it alone. Enum cases are objects, not values, so they can't be inlined.

**Methods and functions.** Calls take the body.

- Arguments take their parameters' places. An argument that does more than
  read a value, such as `$this->load()`, and that the body reads more than
  once, in a closure, or after other code runs, goes into a variable first, in
  argument order; so does one the body changes. Named arguments find their
  parameters, and a missing argument gets the default.
- `$this` becomes the object the call was made on. In another class, `self`
  and `__CLASS__` name the method's class, and class names get imports. A local
  variable whose name the caller already uses gets a number, such as `$sum2`.
- A call that's a statement of its own becomes the body's statements. A call
  whose value is used becomes the method's `return` expression, with any
  statements before the statement that holds it.
- It refuses, and says why, for a method that returns early, a generator, one
  with static variables, by-reference or variadic parameters, or
  `__METHOD__`, and one a subclass overrides. It leaves a nullsafe call
  (`?->`), a first-class callable such as `$this->total(...)`, and a call from
  another class to a method that uses members private there. A method that
  calls itself, or implements another class's method, stays.

## Change signature

Press ⌘F6 in a method or function to open the **Change Signature** dialog, laid
out as PhpStorm's:

- Change the visibility, the name, and the return type.
- Edit each parameter's type, name, and default value. **Add Parameter** or ⌘N
  adds one after the focused row, the arrows or ⌥↑ and ⌥↓ reorder them, and the
  trash button removes one.
- A new parameter needs a default value or a **Value in existing calls**, which
  goes into every call without becoming a default.
- The new signature shows as you type, and a problem, such as two parameters
  with one name, disables **Refactor**. An optional parameter before a required
  one gets a warning, since PHP deprecates it.

The signature below the table is colored as the editor colors PHP.

**Refactor** (⏎) applies the change; **Preview** first opens the **Refactoring
Preview** panel, which lists every changed line by file, with the removed and
added tokens marked. Click a file to fold it, or a line to open it. **Do
Refactor** there applies it, and Escape cancels. The preview also opens on its own
when some calls can't be rewritten, listing them under **Left unchanged**.

The editor rewrites the declaration and every call: positional arguments move
with their parameters, named arguments stay named (under a parameter's new
name), and once an argument must be named, the ones after it are named too. A
renamed parameter is renamed in the body and the docblock. A default written
into a call is spelled so it means the same there, such as `self::LIMIT`
becoming `Order::LIMIT`. Methods in subclasses and implementing classes that
override it change with it, keeping their own parameter names, parameters of
their own, and return type unless you renamed or changed one. For a constructor, the calls
are `new` of the class and of subclasses that inherit its constructor, `new
self` and `new static` inside them, and `parent::__construct()` in subclasses;
a subclass's own constructor keeps its parameters, and a promoted property is
renamed with Rename instead. Arguments one per line stay one per line. Calls it
can't rewrite safely, such as ones that spread `...$args`, are left unchanged.


## Pull members up and extract interface

Both start from the class at the caret: choose **Pull Members Up…** or
**Extract Interface…** from ⌃T or the **Refactor** menu. A dialog lists the
class's members with their signatures, colored as in the editor.

- Check the members to move. Click a row, or use ↑ and ↓ and Space; ⌘A
  selects every member shown, and the filter box narrows a long list. A member
  that can't move says why instead of offering a checkbox.
- Below the list, the dialog shows the code the members become, and
  warns about anything that would break. Where there's a fix, such as a method
  that uses a property you left behind, a button applies it.
- Click **Refactor**, or press ⏎, to apply the change and save the files. Click
  **Preview** to see every changed line first in the **Refactoring Preview**.
  One ⌘Z undoes it in every file.

**Pull Members Up** moves members to a parent class, or declares them in an
interface the class implements. Choose the target under **To**: the class's
parents, nearest first, and its interfaces. Classes in `vendor` are listed but
can't be chosen.

- Constants, properties, and methods move with their docblocks and attributes.
  Methods go at the end of the parent, and constants and properties after the
  parent's own.
- Check **abstract** on a method to declare it abstract in the parent and keep
  its code in the class. The parent becomes `abstract`, and the dialog warns
  about sibling classes that don't declare the method.
- Pulling a method into an interface adds its declaration there; the class
  keeps its code. Interfaces take public methods and constants only.
- A private member that the class still uses becomes `protected`, marked in
  the row. When a member you move uses one that stays, the dialog stops you if
  that one is private, which the parent can't reach, and warns otherwise,
  since the parent's other subclasses won't have it. It also warns about calls
  to `parent::`, whose meaning changes one level up.
- Class names in the moved code are rewritten for the parent's file: they keep
  their short names where its imports allow, get a new `use` import, or are
  written in full when a short name would mean another class. Imports the
  class no longer uses are removed.
- Functions and constants keep meaning the same ones: a helper declared in the
  class's namespace, or imported with `use function` or `use const`, is written
  in full when the parent is in another namespace, such as
  `\App\Services\format_amount()`. PHP's own, such as `strlen()`, stay as
  they are.
- A property promoted in the constructor, such as
  `private Client $client`, becomes a property of the parent; the constructor
  keeps the parameter and assigns it after any `parent::__construct()`. It
  becomes `protected`, since the constructor sets it. A `readonly` one needs
  PHP 8.4, which lets a subclass set it: the dialog blocks it when
  `composer.json` allows an older PHP. Pulling up the constructor itself takes
  its promoted properties with it.

**Extract Interface** creates an interface from the class's public methods and
constants, and makes the class implement it.

- Type the interface's name and namespace; the namespace field suggests the
  project's namespaces. The file goes where `composer.json`'s PSR-4 map puts
  that namespace, shown under the fields, or beside the class when the project
  has no map.
- Methods become declarations, with their docblocks unless you clear **Copy
  docblocks**, and constants move to the interface.
- The interface gets the imports its signatures need, and `declare(strict_types=1)`
  when the class's file has it. The class gets `implements`, and a `use` import
  when the interface is in another namespace.
- Check **Use it in type hints where possible** to type the interface instead
  of the class across the project, as PhpStorm does: a parameter used only to
  call the interface's methods and read its constants, and a private property,
  declared or promoted, used only that way. The option shows how many it
  changes; the **Refactoring Preview** lists the rest and why each stays, such
  as a parameter passed on to other code, or a method the interface doesn't
  declare. Docblock `@param` and `@var` types follow.
- In a Laravel app, **Bind it in AppServiceProvider** adds
  `$this->app->bind(Interface::class, Class::class)` to `register()`, so the
  container can still build what those type hints ask for.
- When it's done, a notice offers to open the new interface. ⌘Z removes the
  file, and the folder it made, along with every other change.

## Move class

Press F6 in a PHP file that declares one class, interface, trait, or enum to
move it to another namespace. The picker lists the project's namespaces, each
with the file it would become; type a new one, such as `App\Services\Billing`,
to create its folder. The file goes where `composer.json`'s PSR-4 map puts that
namespace, and the PHP server updates the class's namespace and every reference,
as when you move the file in the tree. If it can't, for example because no PSR-4
folder in `composer.json` holds the new path, the status bar says why.

## Undo across files

A refactoring that changes several files, such as Rename or Change Signature,
saves them all, and one ⌘Z in any of them undoes it in every file, as in
PhpStorm. A file you edit afterwards leaves the group, since its next undo is
no longer the refactoring's.

## Type hierarchy

Press ⌃H in a PHP file to open the **Hierarchy** tab. With the cursor on a
type's name, such as `Model` in `extends Model` or a trait in `use HasFactory;`,
the tab shows that type. Otherwise, it shows the class, interface, trait, or
enum that the cursor is in.

- **Subtypes** lists the classes that extend it or implement it directly,
  including classes in `vendor`. For a trait, it lists the types that use it.
  Expand one to see its own subtypes.
- **Supertypes** lists its parent class, its interfaces, and its traits.
  Expand one to go further up.

Click a type to open it. PHP's own types, such as `Countable`, are listed
without a file.

## Go to super method

Press ⌘U (**Navigate > Go to Super Method**) in a PHP file to go to the method
that the method at or around the caret overrides or implements, such as
`Model::casts()` from a model's `casts()` or `Resource::form()` from a
Filament resource. The caret can be on the method's name or anywhere in its
body. Outside a method, ⌘U goes to the class's parent class. When there's
more than one target, such as a parent's method and an interface's, pick one
from the list.

The gutter shows an arrow beside methods that override (blue) or implement
(green) another, and beside classes and methods that subclasses extend or
override. Hover over an arrow to see what it points to, and click it to go
there.

## Generate code

Press ⌘N in a PHP file, or choose **Code > Generate…**, to add code to the
class, trait, or enum at the cursor. The list offers what the class lacks:

- **Constructor**: takes and assigns each property that has no default value
  and isn't static. It's offered when the class has no constructor.
- **Getters**, **Setters**, and **Getters and Setters**: `getTitle()` and
  `setTitle()` for each property, including promoted ones, that doesn't have
  one yet. Readonly properties get no setter.
- **`__toString()`**, returning `''`.
- **Implement Methods…** and **Override Methods…**, when the class has
  interface or abstract methods to write, including abstract methods of the
  traits it uses, or parent methods to override. Override asks which method.
- **Complete Constructor**, **Promote Constructor**, and **Add missing
  properties**, when they apply.

## Call hierarchy

Press ⌃⌥H in a PHP file to open the **Call Hierarchy** tab for the method or
function called under the cursor, or else the one the cursor is in.

- **Callers** lists the methods and functions that call it, one row per call.
  For a constructor, that includes `new`, `new self`, `new static`, and
  `parent::__construct()`. Code outside a function, such as a route file, is
  listed by its file. Expand a caller to see its own callers.
- **Callees** lists the project's and packages' methods and functions it calls.
  PHP's own functions aren't listed.

Click a caller to open the call, or a callee to open its declaration.


## Composer

The **Composer** tool window (the package icon) lists the project's direct
dependencies, with dev dependencies marked, and checks Packagist for updates.
Switch the list to **All installed packages** to include the packages your
dependencies need, marked **indirect**.
An update shows in green when it fits the version constraint in
`composer.json`, and in yellow when it needs a new constraint.

- Click or right-click a package to update it, upgrade it to its latest version
  (which changes the constraint), remove it, or open it on Packagist. An
  indirect package can only be updated within its constraints.
- An indirect package shows the packages that require it under its name. Click
  it, then **Why Is It Installed?**, to list them with their version
  constraints. Choose one of them to see why that one is installed, up to
  `composer.json`.
- `composer audit` checks installed packages for security advisories. A package
  with one is marked **advisory**, and the advisory's title, CVE, and severity
  show under its name; click it to open the advisory.
- Type in the filter to narrow the list by name or description.
- A direct dependency is marked **unused?** when no PHP file in the project
  names its namespace. It may still be used through Laravel's package
  discovery, a helper function, or configuration, so check before you remove
  it. Plugins and command-line tools, such as Pint, aren't checked.
- Click **+** to search Packagist and require a package, as a dependency or a
  dev dependency.
- Click the arrow to run `composer update` for everything, after you confirm.

Commands run in terminal tabs with the Composer that ships with the editor, and
the list reloads when they finish.

## Spell checking

The editor marks misspellings in comments, strings, and names with a green
wavy underline, in PHP, Blade, JavaScript, TypeScript, Vue, Markdown, and more. It
splits names such as `$userAdress` and `get_adress` into words. Press ⌥⏎ on a
misspelling (or use the light bulb, or **Quick Fix** in its hover) to:

- Replace it with the suggestion.
- **Save 'word' to project dictionary**: adds the word to the project's
  `_typos.toml` (or the `typos.toml` or `.typos.toml` it already has), under
  `[default.extend-words]`, keeping the rest of the file. Commit the file so
  the rest of the team skips the word too.
- **Save 'word' to user dictionary**: adds the word to your own dictionary,
  `spelling.toml` in `~/Library/Application Support/ly.almontasser.tusk/`,
  which applies to every project.
- **Don't check spelling in this file**: adds the file to `[files]
  extend-exclude` in the project's typos file.

A saved word takes effect at once, in every open file. **Settings > Spelling**
lists both dictionaries, where you can add and remove words, and sets how
misspellings show (typos, warnings, or errors; warnings and errors count in
the Problems panel) and which file types to check. To turn spell checking off,
clear **Check spelling**.

## AI code completion

The editor can suggest code as you type, like GitHub Copilot, with a model
that runs on your Mac. No code leaves the machine. Suggestions appear as gray
text after the cursor: press Tab to accept one, or keep typing to ignore it. To
take only part of it, press ⌘→ for the next word, or ⌘⇧→ for the next line. While
the list of completions is open, a suggestion shows only if it agrees with the
selected item; press Escape to close the list and see it.

To turn it on, select **AI code completion** in Settings, or run
**Toggle AI Completion** from the palette. The first time, the editor
downloads the model into
`~/Library/Application Support/ly.almontasser.tusk/models/`, and the
status bar shows the progress. While it's on, the status bar shows **AI**;
click it to turn completion off.

Choose the model in **AI completion model**:

| Model | Download | Notes |
| --- | --- | --- |
| Qwen2.5-Coder 1.5B | 1.6 GB | The fastest: each suggestion takes about 0.2 s less, with about 5–8 fewer exact suggestions in 100 |
| Qwen2.5-Coder 3B | 3.3 GB | The default: the best suggestions for their speed |
| Qwen2.5-Coder 7B | 8.1 GB | The best suggestions, but slower, and needs 16 GB of memory or more |

The first start takes about 15 seconds while macOS prepares the GPU code;
later starts take a second or two. The model uses a little more memory than
its download size while completion is on (1.9 GB for the 1.5B model, 3.5 GB for 3B). Turning
completion off stops it and frees that memory. To delete a downloaded model,
remove its file from the `models` folder.

### What the model sees

Besides the code around the cursor, each suggestion draws on the rest of the
project, so the model uses your classes, methods, and columns instead of
guessing:

- **Classes used near the cursor:** the declarations, properties, and method
  signatures of up to eight of the project's classes that the code near the
  cursor refers to, found through the PSR-4 folders in `composer.json`.
- **Imported files, in JavaScript, TypeScript, and Vue:** outlines of the
  project files the script imports (relative paths, or aliases such as `@/`),
  with function bodies left out. For a Vue file, its `<script>`.
- **Types of variables:** when the code near the cursor calls methods on a
  variable or property, such as `$publisher->` after
  `$publisher = $this->factory->publisher();`, the editor asks the PHP server for its
  type and adds that class, even when the file never names it.
- **Where a Blade view gets its variables:** in `resources/views/posts/show.blade.php`,
  the code that renders `posts.show`, such as
  `return view('posts.show', compact('post'));`, with the classes and model
  columns used there. For a component, the `<x-…>` tags that use it and its
  class. So `{{ $post->` knows which model `$post` is.
- **Model columns, in Blade views:** each Eloquent model's columns used where the
  view is rendered, with their types from the database and the model's casts,
  and its relationships, written the way Laravel IDE Helper writes them. They
  update a few seconds after you save a model or a migration. PHP files don't
  get them: the code around already shows the columns, and a benchmark found
  no gain there.
- **What you worked on lately:** the code around the cursor in the last six
  places you left in other files.
- **Similar code:** the parts of the project that share the most names with the
  lines before the cursor, such as another controller that does the same thing.

For example, in a controller that uses a `PostPublisher` service,
`$this->publisher->` completes to `publishNow($post)` from that class, where
without the project the model guessed a `publish()` method that doesn't
exist.

The editor keeps the project's source files in memory for this: up to 3,000
PHP, JavaScript, TypeScript, and Vue files, leaving out `vendor`,
`node_modules`, and files that `.gitignore` excludes. Indexing 1,500 files takes
under half a second.

In a benchmark on an open-source Laravel app, the project context raised the
share of suggestions that match the hidden line exactly from 48% to 60%.
Suggestions also stop before code that's already below the cursor, instead of
repeating it, and before a line the model is unsure of. When the model is
unsure from the first line, the editor shows nothing: in the benchmark, every
suggestion hidden that way was wrong.

A suggestion usually appears about 0.4 seconds after you stop typing. When you
type again before it arrives, the editor cancels the request, so the model
moves on to the new text at once. When you
open a file or move to another part of it, the model needs up to 2 seconds to
read the new context, so the editor has it read the context as soon as you
arrive, before you type.

