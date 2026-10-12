# Laravel, Filament, and other languages

## Laravel features

In Laravel projects (folders with an `artisan` file), the PHP server adds
completion, hover, go to definition, links, and diagnostics for config keys,
routes, views, translations, environment variables, middleware, gates and
policies, container bindings, assets, Vite and Mix files, storage disks,
Inertia pages, validation rules, and Eloquent attributes and relations, in PHP
and Blade files. For example, ⌘-click on `view('welcome')` opens
`resources/views/welcome.blade.php`.

- **Lists of views**, as `View::first([...])`, `view()->first([...])`,
  `@includeFirst([...])`, `@extendsFirst`, and `@componentFirst` take,
  hover, complete, and link each view. Laravel renders the first that exists,
  so missing views are reported only when none of the list exists.
- **Artisan commands**, in a test's `artisan()` and `$this->artisan()`,
  `Artisan::call()` and `queue()`, a command's `$this->call()`, and
  `Schedule::command()`: names complete with their descriptions, and hover
  shows the command's usage and opens its class, or its closure in
  `routes/console.php`. After the name, `--` completes the command's options.
  So do the keys of the parameters array, with its arguments: `['month' =>
  …, '--force' => true]`. A command that doesn't exist, and an option or
  argument it doesn't take, inline or as a key, are reported, so a typo such
  as `messages:archvie` shows in the editor rather than when the test runs.
  The list comes from the booted app, so it includes packages' commands and
  closures, and it's read again when `app/Console`, `routes/console.php`,
  `bootstrap/app.php`, a provider, or `composer.lock` changes.
- **Icons** from the blade-icons sets you install, such as blade-heroicons:
  in `svg('…')`, `@svg('…')`, `<x-heroicon-o-user />` tags, and any string
  that starts with a set's prefix, such as `'heroicon-'`, names complete, and
  the selected one shows its SVG beside the list. Hover shows the icon, and
  ⌘B opens its file. The sets and their prefixes come from the booted app, or
  from the packages' service providers when it can't boot.
- **Route parameters** complete and hover in the parameters of `route()`,
  `to_route()`, `redirect()->route()`, `URL::signedRoute()`,
  `URL::temporarySignedRoute()`, and `action()`, from the route's URI: `{post}`
  is required, `{post?}` optional, and `{post:slug}` binds by `slug`. A
  required parameter that a call leaves out is reported when the call passes
  only string keys, or no parameters, since Laravel fills the rest from
  positional values. Keys that the project's `URL::defaults()` fills count as
  given, and a `URL::defaults()` whose keys aren't plain strings turns the check
  off.
- **Links between classes** show above a class as code lenses: an event links
  to its listeners and to the places that dispatch it, a listener to its events,
  a model to its observers and policy (and back), and a job, notification, or
  mailable to the places that dispatch or send it, such as `event(new
  OrderShipped)`, `ProcessOrder::dispatch()`, `$user->notify(new
  InvoicePaid)`, or `Mail::to($user)->send(new Receipt)`. Listeners come from
  `$listen`, `Event::listen()`, and the `handle()` of listeners in
  `app/Listeners`, which Laravel discovers; observers from `#[ObservedBy]` and
  `Model::observe()`; and policies from `#[UsePolicy]`, `Gate::policy()`,
  `$policies`, and Laravel's naming convention. They're read from the
  project's code, so they work without a booted app.
- **Broadcast channels** from `Broadcast::channel()` in `routes/channels.php`
  complete in `new PrivateChannel('`, `PresenceChannel`, `Channel`, and
  `Broadcast::private()`, `presence()`, and `on()`. A channel with parameters
  inserts its name up to the first one, such as `orders.`, for your code to
  finish. ⌘B on `'orders.'` in `new PrivateChannel('orders.'.$order->id)` or
  `"orders.{$order->id}"` opens the channel's definition, and hover shows its
  callback. A private or presence channel whose whole name is a plain string
  that no channel matches is reported, as long as every channel the project
  defines has a plain name.
- **Pennant features** complete, hover, and open their definition in
  `Feature::active()`, `inactive()`, `value()`, `someAreActive([...])`, and the
  rest, in `Feature::for($user)->active()`, in `@feature` and `@featureany`, and
  in `EnsureFeaturesAreActive::using()`. They come from `Feature::define()`
  and the classes in `app/Features`, named by their class or their `$name`. An
  unknown feature is reported when Pennant is installed and every definition
  has a plain name, and a class name always counts as found.
- **Context keys** that `Context::add()`, `addHidden()`, `push()`, and the
  like set complete in `Context::get()`, `has()`, `pull()`, `only()`, and the
  rest, and ⌘B opens where they're set. Unknown keys aren't reported, since
  any code can add one.
- **Reads with a default**, such as `config('services.x.key', null)` or
  `env('APP_URL', 'http://localhost')`, and `Config::has()` checks, aren't
  reported when the key doesn't exist, since they expect it may be missing.
- **Config keys being set**, in `config(['app.locale' => …])` and
  `Config::set('app.locale', …)`, complete, hover, and link like keys being
  read, but a key that doesn't exist isn't reported, since setting one adds it.
- **`can:` middleware**, such as `->middleware('can:update,post')`, completes
  the abilities that gates and policies define after `can:`, and hover and ⌘B
  on the ability show its policies. An unknown ability is reported, unless a
  `Gate::before` hook decides abilities at run time.
- **Validation input** keys complete from the rules: in a form request's
  `rules()`, in a controller method that takes the form request, and inside
  the form request itself, `validated('`, `input('`, `string('`,
  `integer('`, `boolean('`, `has('`, `safe()->only([`, and the other input
  methods offer each key, and `$request->` offers the top-level keys as
  members. A plain `Request` gets the keys of a `validate([...])` or
  `Validator::make()` in the same method. Hover shows a key's rules, and ⌘B
  opens the key in `rules()`. Only `validated('…')` and `safe()->…` are
  checked, and only when every key of the rules is known: one array literal
  with plain keys, and no `withValidator()` or `validator()` that can change
  them. Other input methods read any input, so their keys aren't checked.
- **Validated data** has a type: `validated()`, `validate([...])`,
  `Validator::make(...)->validate()`, and a Livewire component's
  `$this->validate()` return an array shape of the rules' keys, and
  `validated('title')` returns the key's type. Types are what can pass the
  rules: `integer` gives `int|float|numeric-string|true`, as Laravel's
  `filter_var()` check accepts, and only `integer:strict` gives `int`; a key
  without `required` can also be an empty string, which skips the rules;
  `nullable` adds `null`; and a key is optional unless it's `required`,
  `accepted`, or `present`.
- **Livewire** `#[Validate('…')]` attributes and `rules()` on components and
  form objects complete rule names, and `validateOnly('` completes the keys.
- **Tables and columns** in `exists:` and `unique:` rules, and in
  `Rule::exists()`, `Rule::unique()`, `new Exists()`, and `new Unique()`,
  complete from the database, with a model class (`exists:App\Models\User,id`
  or `Rule::exists(User::class, '…')`) giving its table. Hover shows a table's
  columns. An unknown table or column is reported only when the tables were
  read from the database; when it can't be read, models' tables and the
  columns their fillable, casts, and timestamps name stand in. `Rule::enum(`
  and `new Enum(` complete the project's enums, and `in:` and `Rule::in([`
  complete the values of the enum the same key's rules name.
- **Eloquent** attributes complete through query chains, such as
  `User::query()->where('`, `$user->posts()->where('`, and a closure passed
  to `whereHas('author', …)` or `with(['posts' => fn ($q) => …])`.
- **Relationship paths** complete segment by segment in `with()`, `load()`,
  `loadMissing()`, `has()`, `whereHas()`, `withCount()`, and the rest:
  after `with('posts.`, you get the relationships of `posts`'s model. Hover
  shows each segment's method and related model, a `morphTo()`'s with the
  models that point back to it, and ⌘B opens the method. `with('posts:id,`
  completes the related model's columns, and so does the column of
  `withSum('items', '…')` and `whereRelation('author', '…')`. A segment the
  model doesn't have is reported, such as `coments` in
  `with('posts.coments')`, but only when the booted app listed the model's
  relationships, the class has no method of that name and no `__call()` of
  its own, and the app adds none with `resolveRelationUsing()`.
- **Aggregates**: `withCount('comments')` adds `comments_count` to the
  models, `withSum('items', 'total')` adds `items_sum_total`, and an alias,
  as in `withCount(['comments as approved_count' => …])`, names its own. The
  chain after them completes these names, as in `->orderBy('comments_count')`,
  and in a file that adds one, `$post->comments_count` is an `int`,
  `$post->posts_exists` a `bool`, and a sum, average, minimum, or maximum
  stays unknown, since the database decides its type. None of them is
  reported as a property that may not exist.
- **Columns from migrations**: when the app can't boot or reach its database,
  the PHP server reads `database/migrations` itself, in file name order:
  `Schema::create()` and `Schema::table()` blueprints with their column types,
  `nullable()`, `change()`, `renameColumn()`, `dropColumn()`, `timestamps()`,
  `softDeletes()`, `morphs()`, `rememberToken()`, and the rest, and
  `Schema::rename()`. The columns complete in query strings and Filament
  fields, and `$post->title` gets its type from the column and the model's
  casts: a `string`, a `?string` for a nullable column, a `Carbon` for a
  `datetime` cast or a timestamp, an enum for an enum cast. `$post->` lists
  the columns with their types, the relationships, and the file's
  aggregates. The columns update as soon as you save a migration. A blueprint inside an `if` or a
  loop, a column named by a variable, a macro, or raw SQL that names the
  table makes that table uncertain: its columns still complete and type,
  but no warning is based on them. When the database answers, its columns
  win.
- **Morph maps**: the aliases `Relation::morphMap()` and `enforceMorphMap()`
  give your models complete in `where('commentable_type', '…')`, as do the
  classes of the models that point back through `morphMany()` or
  `morphOne()`, and hover on an alias shows its class.
- **Lazy-loading hints**: turn on **Hint at lazy-loaded relationships** in
  **Settings > PHP Analysis** to mark where a loop over a query's models reads
  a relationship the query doesn't eager-load, as in
  `foreach (Post::all() as $post) { $post->author->name; }`, with
  `->each(fn …)`, and in a Blade view's `@foreach`. It's a heuristic: it only
  looks where the query is in view, in the same function or view, as the
  loop's expression or a variable assigned once from it, and it stays quiet
  when it can't tell what the query loads, such as `with($relations)`. A
  model's `$with`, `load()` on the variable, and
  `Model::automaticallyEagerLoadRelationships()` count as eager-loading.
- **Gates** match the model you pass: `Gate::allows('update', $post)` links to
  the policy for `$post`'s class, and warns when no policy for it defines the
  ability. A project with a `Gate::before` hook, such as
  spatie/laravel-permission's, gets no warnings for unknown abilities, since
  the hook decides them at run time.
- **Quick fixes** create a missing view (`resources/views/…blade.php`) or
  Inertia page, add a missing variable to `.env` (or the value from
  `.env.example`), and, in `.env` files, add a `VITE_` copy of the selected
  variables. Each opens what it changed.
- **`.env` files** are highlighted: keys, values, comments, `export`, and
  `${VAR}` references. Typing a key completes the keys your other `.env*`
  files assign and those `config/*.php` reads with `env()`, less the ones the
  file already has. The value comes from `.env.example` or the `env()`
  default, never from `.env`, so a secret doesn't land in a committed file.
  ⌘-click a key to see where the project reads it with `env('KEY')`.

Translation keys in `__()`, `trans()`, `trans_choice()`, `@lang()`, and
`Lang::get()` complete from `lang/*/*.php`, `lang/*.json`, and packages'
translations. Hover shows the value in each locale with its file, and ⌘B or
⌘-click opens the line that defines it. An unknown key that looks like
`group.key` shows a warning; a key without a dot, such as `__('Welcome back')`,
doesn't, since Laravel shows the key itself when no JSON file has it. When a
project has more than 200 keys, completion lists the keys without their values.

- **Routes**, from ⌘⇧A, lists the app's routes from `php artisan route:list`.
  Search by method, path, route name, or controller, and choose a route to
  open its controller method. Routes to classes in `vendor`, such as Filament
  pages, open once the PHP server has indexed them. If `route:list` fails, it runs in
  a terminal tab so you can see the error.
- **Laravel Tinker**, from ⌘⇧A, opens `php artisan tinker` in a terminal tab.
- **Show Laravel Log**, in **Tools > Laravel** and ⌘⇧A, opens the newest log in
  `storage/logs` (the latest daily log, or else `laravel.log`) at its last line.

When Sail's containers are running, both commands run in the container.

### Blade

Blade files highlight their HTML, the PHP inside `{{ }}`, `{!! !!}`,
directive arguments such as `@if (…)` and `@class([…])`, and `@php` blocks,
also inside tags and attribute values. Component tags such as
`<x-card.header>` and bound attributes such as `:title="$post->title"` are
recognized. Inside `<script>`, echoes, comments, `@json(…)` and other
directives, and `@php` blocks highlight as Blade and PHP, with the JavaScript
around them intact; inside `<style>`, echoes and comments do. The PHP server
completes component names after `<x-`. ⌘B on a component tag opens its view,
and for a class-based component also its class in `app/View/Components`.

Mago checks the PHP in Blade files as you type, and the Problems panel's scan
checks every view in `resources/views`: echoes,
`@php` blocks, `<?php` blocks, the arguments of Laravel's directives (`@if`,
`@foreach`, `@include`, `@class`, `@props`, and the rest), and bound attributes
on component tags. It reports syntax errors, and unknown classes, functions,
methods, and constants, and wrong arguments, at their place in the view.
`@use` imports count. A view's variables have the types that the project code
rendering it passes: `view('posts.show', compact('post'))` in a controller types
`$post`, so `{{ $post->titel }}` is reported as an unknown property, and so is
a misspelling on `$comment` inside `@foreach ($post->comments as $comment)`.
`View::make()`, `->view()`, `Route::view()`, `->with()`, and a Livewire
component's or Filament page's public properties count too. A class component's
view gets its public properties and methods: `{{ $isActive }}` calls a method
without parameters, as Laravel does, and `$label('Hi')` is checked against the
method's parameters and return type. A prop passed as `<x-slot:footer>` is a
`ComponentSlot`. When several places
render a view, a variable they all pass gets each place's type; one that some
place doesn't pass, or passes a value of unknown type, isn't checked. The check
doesn't report undefined variables. Custom directives aren't checked.

Laravel's conditionals narrow types the way Laravel compiles them: `@if`,
`@unless`, `@isset`, `@empty`, `@else`, and the rest. So
`{{ $post->author->name }}` reports a possibly null author, but not inside
`@isset($post->author)` or `@if ($post->author)`, and `@break($item === null)`
narrows what comes after it in a loop. Inside `@auth`, and in `@guest`'s
`@else`, `Auth::user()`, `auth()->guard()->user()`, and a `$user` that holds
one aren't null.

The PHP in a view also has hover, completion, and ⌘B, with the same variable
types: `{{ $` lists the view's variables with their types, `{{ $post->` lists
the members of `$post`'s class, hovering `$post->title` shows the property, and
⌘B on it opens the model. Completing a class that the view doesn't import adds
`@use('App\Models\Post')` among the `@use` lines at the view's top, in order,
or after its leading `@props` and `@aware` lines. A namespaced function or
constant gets `@use('function App\helper')` or `@use('const App\LIMIT')`, after
the classes. When the view already has a group for the name's namespace, such as
`@use('App\Models\{Post, User}')`, the name joins it instead. On a Laravel whose
`@use` doesn't read `function`, `const`, or groups, the name is written in full,
`\App\helper()`, and so is a class on a Laravel without `@use`. On an unknown
class name, ⌥⏎ offers **Import class** for each class of that name, with the
same edit.

Blade files format (⌥⌘L) with the bundled `blade-formatter`, which indents
Blade, HTML, and scripts, and reads your project's `.bladeformatterrc` when it
has one. When your project's own Prettier has a Blade plugin, that runs
instead.

### Livewire

In a Livewire component's view, the PHP server knows the component. The view's
component is the class that passes the view's name to `view()` or
`View::make()`, or names it in a `$view` property, as a Filament page does, or,
for a class without `render()`, the class Livewire's naming convention gives,
so `resources/views/livewire/posts/edit-post.blade.php` belongs to
`App\Livewire\Posts\EditPost` (or the `class_namespace` in
`config/livewire.php`). A Volt view, or a Livewire 4 single-file component,
declares its class in its own `<?php new class extends Component { … } ?>`
block.

- **`wire:model`**, with any modifiers (`.live`, `.blur`, `.debounce.250ms`),
  completes the component's public properties, and after `form.` the public
  properties of the Livewire Form object in `$form`. `$set('` and `$toggle('`
  complete them too.
- **Actions** such as `wire:click`, `wire:submit`, `wire:change`,
  `wire:keydown.enter`, `wire:poll`, and `wire:init` complete the component's
  public methods, without its lifecycle hooks, and Livewire's magic actions:
  `$refresh`, `$set`, `$toggle`, `$dispatch`, `$parent`, and the rest.
  `wire:target` completes both.
- **`$wire.`** in Alpine attributes (`x-data`, `@click`, `x-show`, `x-model`,
  and the rest) and in `<script>`, such as under `@script`, completes the
  component's properties and methods and `$wire`'s own, such as `$entangle`.
  `$wire.form.` completes the Form object's properties, and `$wire.$set('`,
  `$wire.call('`, and `$wire.$watch('` complete names.
- Hover shows the property or method, and ⌘B opens its declaration, in the
  class, a parent, a trait, or the Volt block.
- A `wire:model` property, a Form object's property, an action's method, or a
  `$set()` or `$toggle()` property that the component surely doesn't have is
  reported. A name is checked only when it's all the value says, such as
  `save` or `save(1)`, not `a(); b()` or `items.{{ $i }}`, and only when Tusk
  knows the whole component: a class with its own `__get()` (for properties)
  or `__call()` (for methods), or a parent or trait the index doesn't have,
  isn't checked, and neither is a view Tusk can't tie to a class. Livewire
  calls only public methods that `Livewire\Component` doesn't declare, and
  binds only public properties, so a protected method or a static property is
  reported.
- **`<livewire:name`** completes the attributes the component takes: its
  public properties and its `mount()` parameters.
- **Computed properties**: `$this->posts` in the component, and in its view,
  has the type that the `#[Computed]` method `posts()`, or a legacy
  `getPostsProperty()`, returns, so `{{ $this->posts->titel }}` is reported.
  In the view, `$this` is the component, and its protected members are in
  reach, as Livewire renders the view in the component's scope.
- **Events**: in `$this->dispatch('`, and in Blade's `$dispatch('`,
  `$wire.dispatch('`, and `Livewire.dispatch('`, event names complete from the
  project's listeners: `#[On('post-created')]`, `$listeners`, `Livewire.on()`,
  and `$wire.$on()`. In `#[On('`, they complete from the project's dispatches.
  Hover lists an event's listeners, with Alpine's `@post-created.window` and
  `addEventListener()`, or its dispatches, and ⌘B opens the components that
  listen, or the places that dispatch. A listener's `{placeholders}`, as in
  `post-updated.{post.id}`, match any value. Laravel Echo's `echo:` events
  aren't offered.

## Filament features

In projects that install Filament (`vendor/filament/filament`), a Filament
language server understands the strings Filament resolves against your
Eloquent models:

- **Completion.** In `::make('…')`, it suggests the model's columns and
  relationships. After a relationship and a dot, such as `'author.'`, it
  suggests the related model's columns. In `->relationship('…')`, it suggests
  relationship names. In the second argument, such as
  `->relationship('author', '…')`, it suggests the related model's columns.
- **Options and state paths.** In `->options(` or `->enum(` on a field the
  model casts to an enum, it suggests that enum, such as `PostStatus::class`.
  In `->default('…')`, it suggests the field's option values: the backed
  values of its enum (from `->options(…::class)`, `->enum(…::class)`, or the
  model's cast), or the keys of a literal `->options([...])` array. Without
  quotes, `->default(` suggests the enum's cases, such as
  `PostStatus::Published`. When the options come from the database, as with
  `->options(Category::pluck('name', 'id'))` or
  `->relationship('author', 'name')`, it suggests their keys, such as `5`,
  with each option's label beside it; typing a label, such as `Acme`, finds
  its key.
- **`$get()` and `$set()`.** In `$get('…')`, `$set('…')`, and `Get`'s
  methods such as `$get->string('…')`, it suggests the fields the closure's
  schema reaches, as Filament resolves them: the fields beside it first, then
  the form's other fields with the `../` they need. In a repeater's item,
  `'../../total'` reaches the form's `total`. Each suggestion shows the
  field's type and label. Hover shows the field's code, label, state path, and
  options, and ⌘B goes to its `::make()`. A path that leaves the form, such
  as `'../../../x'` at the top, hovers as a Livewire property. Absolute paths
  start at the Livewire component: `$get('/data.title')` and
  `$get('data.title', isAbsolute: true)` read a resource form's `title` from
  anywhere in the form, and `'/'` completes to `/data.title` and the form's
  other fields.
- **Compared values.** In `$get('status') === '…'`, `match ($get('status'))`,
  and `in_array($get('status'), ['…'])`, it suggests the field's option keys
  or enum values, or the keys of options from the database, such as a user's
  id. On Filament 4, a field with `->options(PostStatus::class)`
  holds a `PostStatus` case, so it suggests `PostStatus::Draft` and the other
  cases instead.
- **Closure parameters.** Filament fills a closure's parameters by name, such
  as `$record` in `->visible(fn ($record) => …)`. Typing `$` in the parameters
  of a closure passed to a Filament component, column, action, or table
  suggests the names that class injects, read from the project's Filament code,
  so each version and class gets its own: `$record`, `$state`, `$get`, `$set`,
  `$livewire`, `$operation`, and the class's own name, such as `$column`. A
  parameter without a type gets the type Filament gives it: `$get` and `$set`
  are `Get` and `Set`, `$record` is the resource's or relation manager's model
  (or `null` in a form, while creating), `$livewire` is the page or relation
  manager the closure is in, and `$column` or `$component` is the component.
  Members of `$record` then complete and are checked.
- **Resource pages.** In `PostResource::getUrl('…')` and a page's
  `static::getResource()::getUrl('…')`, it suggests the page names from the
  resource's `getPages()`, with each page's class. Hover shows the page, and ⌘B
  opens its class.
- **Go to declaration.** ⌘B on `'author'` in `->relationship('author')` or
  `'author.name'` opens the model's `author()` method. This covers table
  columns and infolist entries, such as `TextColumn::make('author.name')` and
  `TextEntry::make('author.name')`, and hover shows the relationship's type,
  related model, and columns.
- **Warnings.** A relationship name that the model doesn't define is
  underlined as you type. So is a `$get('…')` of a field the schema surely
  doesn't have, such as `$get('total')` in a repeater's item when `total` is
  the form's: the warning suggests `../../total`, or a field with a close
  name, and a quick fix (⌥⏎) writes it. Besides repeaters' items and resource
  forms, this covers an action's modal form that Filament's `Action` or
  `CreateAction` fills with nothing, or any action fills with a literal
  `fillForm([...])`; a Livewire component's own form that its class fills
  only with literal arrays; and a relationship repeater's items at the top of
  a resource's form, which hold the related model's columns too. On Filament 4, comparing an enum
  field's state with a string, as in `$get('status') === 'draft'`, is never
  true, so it's underlined with a quick fix to `PostStatus::Draft`.
- **Icons.** In `->icon('…')`, `->icons([...])`, and the other methods
  whose names end in `Icon`, such as `->prefixIcon()` and `->modalIcon()`,
  in `$navigationIcon`, `FilamentIcon::register()`, an enum's `getIcon()`,
  and the `icon` attributes of `<x-filament::…>` components, icon names
  complete with a preview. Hover over a name or a `Heroicon::OutlinedUser`
  case shows the icon. A name whose set is installed but has no such icon,
  such as `heroicon-o-usr`, is underlined.
- **Colors.** In `->color('…')`, `->colors([...])`, `->badgeColor()`,
  `->iconColor()`, the strings a `->color(fn …)` closure returns, an enum's
  `getColor()`, and `<x-filament::badge color="…">`, color names complete:
  Filament's defaults and the colors your panels and
  `FilamentColor::register()` add. Each name, and each `Color::Amber`, shows
  a swatch of its shade 500. A name Filament doesn't know, such as
  `'secondary'` on Filament 3 and later, is underlined when the app boots.
  true, so it's underlined with a quick fix to `PostStatus::Draft`. A closure
  parameter Filament can't inject, such as `fn (string $page)` in a column's
  `->url()`, is underlined, since Filament throws a
  `BindingResolutionException` when it calls the closure. So is a page name
  the resource's `getPages()` doesn't register, as in `getUrl('show')`, and
  `->searchable()` or `->sortable()` on a table column whose name isn't a
  database column, such as an accessor, since Filament puts the name in the
  query.
- **Links between files.** A resource shows links to its model, pages, and
  relation managers above the class. Pages, schemas, tables, and relation
  managers link back to their resource, and a model links to its resources.

Forms and tables in a relation manager or a related records page
(`ManageRelatedRecords`) use the related model. For example,
fields in `PostsRelationManager` on `AuthorResource` complete `Post` columns.

Columns come from the database when the app can boot and connect. Otherwise
they come from the model's `$fillable`, casts, primary key, and timestamps.

## Tailwind CSS

In projects whose `package.json` lists `tailwindcss`, the Tailwind CSS language
server adds:

- Class name completion, showing each class's CSS, in Blade, PHP, HTML, CSS,
  and JavaScript files.
- The generated CSS when you hover over a class.
- Color swatches next to color classes. Click a swatch to pick a new color.
- Warnings for conflicting classes, such as `flex` with `grid`, and for invalid
  `@apply` and `@variant` use.

Classes are recognized in `class` attributes, in PHP arrays such as Filament's
`->extraAttributes(['class' => '…'])`, and in Blade's `@class([...])`. The
server reads your Tailwind setup from your CSS entry file (Tailwind 4) or
`tailwind.config.js` (Tailwind 3), and uses the project's installed
`tailwindcss` when `node_modules` exists.

## JavaScript, TypeScript, and Vue

JavaScript, TypeScript, and Vue files get a full TypeScript language server
(vtsls), with project-wide completion, hover, go to definition, find
references, rename, code actions, inlay hints, and type errors. In `.vue`
files, the Vue language server adds template and style support, and TypeScript
features work inside templates too, such as hover and completion in
`{{ … }}`.

The servers start the first time you open a JavaScript, TypeScript, or Vue
file, so PHP-only work doesn't pay for them. They use the project's own
TypeScript version when `node_modules/typescript` exists.


Vue, Svelte, and Astro files highlight their HTML, `<script lang="ts">` as
TypeScript, `<style lang="scss">` or `lang="less"` as those languages, and an
Astro file's `---` frontmatter as TypeScript. `.svelte` and `.astro` files get
their own language servers (Svelte's and Astro's), with completion, hover, go
to definition, and type errors in markup, scripts, and styles. Each starts the
first time you open one of its files. TypeScript files see the types of the
Svelte and Astro components they import.

In a project whose `package.json` lists `@angular/core`, the Angular language
server adds completion, hover, go to definition, and type errors to component
templates, both `.html` files and inline `template:` strings. It starts the
first time you open a TypeScript or HTML file, and uses the project's
TypeScript when `node_modules/typescript` exists.

## Diagnostics and formatting

The **Problems** panel (⌘6, or click the error and warning counts in the
status bar) lists errors and warnings across the whole project, grouped by
file; click one to go to it. The **Errors** and **Warnings** buttons, which show
their counts, turn each kind on and off, and the panel remembers your choice.
**Current File** lists only the file in the editor, and the filter box keeps
problems whose message, rule, or path contains every word you type. Files with
errors come first, each with its error and warning counts. The problem under the
cursor is selected in the panel. In the panel, ↑ and ↓ move the selection, ← and
→ collapse and expand a file, Enter opens the problem, and ⌘C copies it as
`path:line:column severity rule message`; on a file, ⌘C copies all its
problems, one per line. Right-click a problem to copy it or its message, or to
show its details. Right-click a file to copy all its problems or only their
messages.
A file with errors shows its name in red with a wavy underline in the file
tree and on its tab, and the folders that contain it show their names in red.
The Problems button in the activity bar shows the error count.

JSON config files are checked against their schemas, with completion and
hovers from them too: `composer.json`, `package.json`, `tsconfig.json` (and
`tsconfig.*.json`), `jsconfig.json`, `.eslintrc.json`, `.prettierrc.json`,
`.babelrc.json`, and `babel.config.json`. The schemas ship with the editor, so
this works offline. A file whose `$schema` names one of these schemas' URLs
gets the bundled copy, and a file whose `$schema` is a path, such as
`"./config.schema.json"`, is checked against that file. Other URLs aren't
downloaded.

Deprecated methods, classes, and functions show struck through, and unused
imports faded, as in VS Code. Hovers lay out long signatures with one parameter per line.

Press F2 or ⇧F2 to go to the next or previous problem in the file, with its
message in a panel below the line. **Next Problem in Files** and **Previous
Problem in Files** in ⌘⇧A, or F8 and ⇧F8 while you aren't debugging, move on to
other files. In the Dark and Light themes, squiggles use the interface's red,
yellow, and blue.

Pointing at a problem in the editor shows it with code formatted as code, and
the checker's notes as paragraphs, and the checker and rule below it, such as
`mago-lint(no-redundant-use)`. Rows in the Problems panel show the same label
and the line and column. **Show Details** in that popup, or the button at the
end of a row in the Problems panel, shows the problem on a page of its own: the
whole message, with long types such as array shapes laid out one key per line,
the code around the problem, and **Go to Code**. When Mago shows how two types
differ as a diff, the popup and the page show it as a colored diff. The page opens as an editor
tab, and Escape closes it. For a Mago lint problem, the page
also shows Mago's explanation of the rule under **About this rule**.

To see the cursor line's worst problem at the end of the line, as the Error Lens
extension does, turn on **Show the cursor line's problem at the end of the
line** in Settings, or run **Toggle Inline Problems** from ⌘⇧A. Long messages
are cut short, and `+2` counts the line's other problems. The message hides
while you type and comes back when you pause.

The first time you open the Problems panel, it scans the project: the PHP
server runs the checks it runs for open files (Mago's analyzer and linter, and
its own, such as unused imports) over every project PHP file at once, in a few
seconds. The status bar and the panel count the files checked so far, and
**Cancel** in the status bar stops the check. **Scan Project** rechecks every file, since a change in one file can
change another's problems. Open files show their live problems as you type.
Mago's notes and help show in the editor only, not in the panel. The status bar
counts cover the project once it has been scanned. Laravel's, Filament's, and
Tailwind's problems show for open files only.

When `composer.lock` or `mago.toml` changes, for example after `composer
require`, the PHP server indexes the project again, so new packages' classes
and functions are found.
This also happens when you open a project whose `composer.lock` changed while
the editor was closed. To do it yourself, run **Reindex Project** from ⌘⇧A.
PHP files that other programs create or change, such as `php artisan make:model`
or a `git checkout`, are indexed a few seconds later.

**Index exclusions** make indexing and Mago's checks faster by skipping vendor
folders whose PHP files declare no classes or functions, such as AWS's API data
and packages' translations. On a Laravel and Filament app, the default list
takes a full index from 116 to 94 seconds. To change the list, run **Index
Exclusions…** from ⌘⇧A:

- **Scan vendor** lists the vendor folders of 100 KB or more where no PHP
  file declares anything, with their file counts and sizes. Checked folders are
  skipped when you save.
- Add a folder by path, such as `vendor/package/data`. `*` matches within a
  folder name and `**` matches any number of folders, as in
  `vendor/**/resources/lang`. **Restore Defaults** puts back the starting list.
- **Share with the project in tusk.json** saves the list in the project's
  `tusk.json`, as `"indexExclude": [...]`, so your team can commit it.
  Otherwise, the list is kept on this Mac only. See [Project settings and
  tusk.json](workspace.md#project-settings-and-tusk-json).

You can also right-click a folder in the Project tree and choose **Exclude
from Index** or **Include in Index**. When you open a project for the first
time, and whenever `composer.lock` changes, the editor scans `vendor` in the
background. If it finds folders to skip that it hasn't suggested before, such
as a new package's data, a hint in the corner offers **Review**, which opens
the dialog with the scan's suggestions. Saving a changed list rebuilds the
index from the start. When the project has its own `mago.toml`, Mago uses that
file's `excludes` instead.

**Formatting** (⌥⌘L) uses your project's own tools:

1. **Prettier**, for every file its configuration can parse: the project's own
   when it has one in `node_modules`, and otherwise the bundled Prettier, which
   formats JavaScript, TypeScript, CSS, SCSS, Less, JSON, HTML, Markdown, YAML,
   Vue, Svelte, and Astro. With `@prettier/plugin-php` or a Blade plugin in
   the project, the project's Prettier formats PHP and Blade files too.
2. **Laravel Pint**, for PHP files Prettier doesn't handle, when the project has
   `vendor/bin/pint`.
3. **Mago's formatter**, the fallback for PHP, built into the PHP server.

That order is **Auto**. To choose a formatter per language, run **Code >
Formatters…**. For PHP, Blade, JavaScript, TypeScript, and Vue, CSS, JSON,
Markdown, and YAML, choose Auto, a specific formatter (Laravel Pint, PHP CS
Fixer, Mago, Prettier, blade-formatter, or Monaco's built-in one, where they
apply), or **None**. Each language also has an **On save** choice that turns
format on save on or off for it; **Default** follows **Format files when
saving**. The choices are a project setting, which you can share in
`tusk.json`, since teams standardize their formatters.

- After formatting, the status bar names the formatter that ran, such as
  "Formatted with Laravel Pint".
- When the chosen formatter isn't installed, Tusk says how to install it, such
  as `composer require laravel/pint --dev`, with a **Formatters…** button.
- PHP CS Fixer formats a copy of the file in the temporary folder with the
  project's configuration, since it doesn't read standard input.

Prettier, including the bundled one, and Pint read the project's own
configuration files, and Prettier follows `.editorconfig`. Mago reads the
`[formatter]` section of `mago.toml`: a `preset` (`default`, `psr-12`, `pint`,
`tempest`, `hack`, or `drupal`), options over it, and `excludes`. A file with
a syntax error isn't formatted; the status bar names the line.

Mago checks PHP files as you type (static analysis and lint).
If your project has a `mago.toml` file, Mago uses it. Otherwise the app uses
defaults tuned for Laravel, in `src-tauri/resources/mago.toml`: the analyzer
reads the project and `vendor` but skips hidden folders, `node_modules`, and
`storage`, rules that flag normal Laravel code (`strict-types`,
`literal-named-argument`, and `prefer-first-class-callable`, since Filament
fills closure parameters by name) are off, rules about code size and
complexity (such as `cyclomatic-complexity`, `halstead`, and
`too-many-methods`) and matters of taste (such as `prefer-static-closure` and
`no-else-clause`) are off, the remaining style rules show as warnings rather
than errors, and tests, factories, and seeders may
set literal passwords. Mago checks against the lowest PHP version your
`composer.json` allows. Mago's analyzer doesn't know Laravel's
magic, such as Eloquent attributes and relationships (`$post->author`),
forwarded calls (`Post::create()`), or request input (`$request->email`). The
editor reads your models' columns, relationships, accessors, and scopes, and
hides those reports, and the ones they cause further on, when Laravel really
has the member; anything left shows as a hint (dots you can hover), not as a
problem. Laravel's root aliases, such as `use DB;`, resolve too: the editor
writes stubs for them that the PHP server and Mago read. It also gives Mago corrected
copies of the Laravel and Pest files whose types are wider than what your code
gets back, as Larastan does: `__()` returns a string, `auth()->user()` your
user model, and `shouldReceive()` takes arguments. Without those copies, as in
a project with its own `mago.toml`, `auth()` still has the default guard's
methods, such as `user()`, `id()`, `check()`, and `login()`, in problems,
completion, and hover, and `auth()->user()` returns what `Auth::user()` does.
A Pest test's `$this` is
the test case `tests/Pest.php` binds to its folder. Problems Mago can't prove, such as a value that may be null, show
as warnings; using a value of unknown type shows as a hint.

⌥⏎ on a Mago problem offers Mago's own fix, such as removing an unused import,
and **Fix All Safe Mago Problems in File**. A fix that may change what the
code does says so in its title. **Fix All Safe Problems in File** in ⌘⇧A
applies the safe fixes without the menu. **Suppress *rule* for this line**
adds a `// @mago-expect lint:rule` comment (`analysis:` for the analyzer)
above the line, or adds the rule to one already there. Mago reports the
comment once the problem is gone, and its fix removes the comment.
⌥⏎ on a linter problem also offers **Disable *rule* in mago.toml** and
**Change *rule*'s level…**, and on an analyzer problem **Ignore *code* in
mago.toml**.

### PHP analysis settings

**Tools > PHP Analysis Settings…** opens **Settings > PHP Analysis** for the
open project:

- **Index every library file in full**: off by default, the PHP server reads
  the vendor code your project reaches in full and the rest by name only. On,
  it reads all of `vendor` in full, for complete types everywhere, at several
  times the memory.
- **Extra stub folders**: folders or PHP files, relative to the project or
  absolute, that the index reads as library code, such as stubs for a PHP
  extension.
- **Hint at lazy-loaded relationships**: off by default. On, a loop over a
  query's models that reads a relationship the query doesn't eager-load gets
  a hint (see "Laravel features").
- **PHP version**: the version Mago checks against, from `composer.json` or
  one you choose (`php-version` in `mago.toml`).
- The analyzer's switches, such as reporting unused parameters or missing
  `@throws`, the problem codes it ignores, and the paths the analyzer and the
  linter skip.
- Every linter rule that applies to the project's PHP version and
  integrations, with Mago's own name and description: filter them, turn each
  on or off, and set its level. A changed rule has a blue edge.

The first three are project settings you can share in `tusk.json`
(`phpAnalysis`). The rest live in `mago.toml`: Tusk edits the file in place,
keeping your comments and every key the page doesn't show, and Mago uses the
change at once. A project without a `mago.toml` uses Tusk's defaults; your
first change creates `mago.toml` from them. **Open mago.toml** edits the file
by hand.

### PHPStan

When the project has `vendor/bin/phpstan`, Tusk runs it on each PHP file as
it opens and each time you save it, with the project's own configuration, and
shows its problems with source `phpstan`. **Settings > PHPStan** (a **This
project** group) sets:

| Setting | Default |
| --- | --- |
| Run PHPStan: when the project has it, always, or never | When the project has `vendor/bin/phpstan` |
| Check files: as they open and on save, or only when you run it | As they open and on save |
| Configuration file: found by PHPStan, or one of the `.neon` files in the project's root | Found by PHPStan (`phpstan.neon`, `phpstan.neon.dist`, `phpstan.dist.neon`) |
| Rule level: the configuration's, or 0 to 10 or max | The configuration's |
| Memory limit | `2G` |
| Timeout | 180 seconds |

Changes apply at once: the open files are checked again with the new
settings, and turning PHPStan off clears its problems. Check **Share in
tusk.json** to give your team the same settings (the `phpstan` key).

**Code > Run PHPStan on Project** checks every file in the configuration's
`paths` and lists the problems in the Problems panel. The **PHPStan** button in
the Problems panel's toolbar shows its state: running, off, or failed, with
the reason in its tooltip, such as a timeout or running out of memory. A
failure also shows once as a notification. Click the button to run PHPStan on
the project or open its settings.

