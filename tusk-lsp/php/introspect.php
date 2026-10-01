<?php

/*
 * Describes a Laravel project's Filament resources and models as JSON.
 *
 *   php introspect.php <project root> resource <Resource class> [<context class>]
 *   php introspect.php <project root> resources
 *   php introspect.php <project root> models
 *   php introspect.php <project root> enum <Enum class>
 *   php introspect.php <project root> builder
 *   php introspect.php <project root> aliases
 *   php introspect.php <project root> mago-stubs <folder>
 *   php introspect.php <project root> views
 *   php introspect.php <project root> filament-catalog
 *   php introspect.php <project root> filament-app
 *   php introspect.php <project root> enums
 *   php introspect.php <project root> migrations
 *   php introspect.php <project root> model <Model class>
 *   php introspect.php <project root> policy <Model class> [<Resource class>]
 *   php introspect.php <project root> translations
 *   php introspect.php <project root> permission <create-permission|create-role|grant|revoke> <name> [<permission>]
 *   php introspect.php <project root> env-settings <config key>...
 *
 * `resource` prints the resource, its pages and relation managers, and the model that
 * forms and tables in <context class> work with. For a relation manager, that's the
 * related model of its relationship. `resources` maps each model to its resources.
 * `models` describes every model under app/ for AI completion: columns with their
 * database types, casts, and relationships. `enum` lists an enum's cases with their values. `builder` lists the query builder methods models
 * forward static and instance calls to. `aliases` maps root class aliases, such as `DB`, to their classes.
 * `mago-stubs` writes vendor files with corrected types for Mago into <folder>, and lists them. `views` lists
 * the names of the app's and packages' views.
 *
 * The designers use the rest. `filament-catalog` lists Filament's components, columns, filters, and actions,
 * with plugins' and the project's, and the fluent methods that configure each, grouped by the class or trait
 * that declares them. `filament-app` lists the panels with their resources, pages, relation managers, and
 * clusters. `enums` lists the app's enums, `migrations` the migration files and which have run, and `model` one
 * model's table, columns, indexes, and declarations. `policy` names a model's policy and lists the roles and
 * permissions of spatie/laravel-permission when the app has it; `permission` creates a permission or role, or
 * grants or revokes a role's permission. `translations` lists the strings of the app's lang files by locale.
 *
 * The language server runs this in a separate process, so edited classes are always
 * loaded fresh.
 */

declare(strict_types=1);

// Notices, such as deprecations an older package raises on a newer PHP, go to stderr, so the JSON on stdout stays
// readable.
ini_set('display_errors', 'stderr');

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\Relation;

[, $root, $mode] = $argv + [null, null, null];
$root = realpath((string) $root) ?: exit(1);
chdir($root);
require $root . '/vendor/autoload.php';

// Boot the app so models can read their table columns from the database.
$booted = false;
$bootError = null;
try {
    $app = require $root . '/bootstrap/app.php';
    $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
    $booted = true;
} catch (Throwable $e) {
    // Without a booted app, columns fall back to what the model declares. The designers say why it failed.
    $bootError = ['message' => $e->getMessage(), 'file' => ltrim(str_replace($root, '', $e->getFile()), '/'), 'line' => $e->getLine()];
}

/** File and line where a class or method is declared. */
function location(ReflectionClass|ReflectionMethod $r): array
{
    return ['file' => $r->getFileName() ?: null, 'line' => $r->getStartLine() ?: 1];
}

/** Columns from the database, or from $fillable, casts, and timestamps when that fails. */
function columns(Model $model): array
{
    global $booted;
    if ($booted) {
        try {
            $columns = $model->getConnection()->getSchemaBuilder()->getColumnListing($model->getTable());
            if ($columns) {
                return array_values($columns);
            }
        } catch (Throwable) {
        }
    }
    $columns = [$model->getKeyName(), ...$model->getFillable(), ...array_keys($model->getCasts())];
    if ($model->usesTimestamps()) {
        array_push($columns, $model->getCreatedAtColumn(), $model->getUpdatedAtColumn());
    }
    return array_values(array_unique($columns));
}

/** Relationship methods: public methods with no parameters whose return type is a Relation. */
function relations(Model $model): array
{
    $relations = [];
    foreach ((new ReflectionClass($model))->getMethods(ReflectionMethod::IS_PUBLIC) as $method) {
        $type = $method->getReturnType();
        if ($method->isStatic() || $method->getNumberOfRequiredParameters() || !$type instanceof ReflectionNamedType) {
            continue;
        }
        if (!is_a($type->getName(), Relation::class, true)) {
            continue;
        }
        $related = null;
        try {
            $related = get_class($model->{$method->getName()}()->getRelated());
        } catch (Throwable) {
        }
        $relations[] = ['name' => $method->getName(), 'type' => (new ReflectionClass($type->getName()))->getShortName(), 'related' => $related] + location($method);
    }
    return $relations;
}

/**
 * Properties a model's accessors add: `getFullNameAttribute()` and `fullName(): Attribute` both give `full_name`,
 * plus the attributes in `$appends`. Inherited ones count, such as those of a base model or a trait.
 */
function accessors(Model $model): array
{
    $names = $model->getAppends();
    foreach ((new ReflectionClass($model))->getMethods() as $method) {
        $name = $method->getName();
        if (preg_match('/^get(\w+)Attribute$/', $name, $m) && $m[1] !== '') {
            $names[] = Illuminate\Support\Str::snake($m[1]);
        } elseif (!$method->isStatic() && ($type = $method->getReturnType()) instanceof ReflectionNamedType && is_a($type->getName(), Illuminate\Database\Eloquent\Casts\Attribute::class, true)) {
            $names[] = Illuminate\Support\Str::snake($name);
            $names[] = $name;
        }
    }
    return array_values(array_unique($names));
}

/** Local scopes, called without their prefix: `scopePublished()` and `#[Scope] published()` both give `published`. */
function scopes(Model $model): array
{
    $names = [];
    foreach ((new ReflectionClass($model))->getMethods() as $method) {
        if (preg_match('/^scope(\w+)$/', $method->getName(), $m)) {
            $names[] = lcfirst($m[1]);
        } elseif ($method->getAttributes('Illuminate\\Database\\Eloquent\\Attributes\\Scope')) {
            $names[] = $method->getName();
        }
    }
    return $names;
}

/** Public methods of Eloquent's and the query builder, which a model forwards calls it doesn't have to. */
function builderMethods(): array
{
    $names = [];
    foreach ([Illuminate\Database\Eloquent\Builder::class, Illuminate\Database\Query\Builder::class] as $class) {
        foreach ((new ReflectionClass($class))->getMethods(ReflectionMethod::IS_PUBLIC) as $method) {
            $names[] = $method->getName();
        }
    }
    return array_values(array_unique($names));
}

/** A model with its columns and relationships, and one level of related models. */
function describeModel(string $class, bool $withRelated = true): ?array
{
    if (!is_a($class, Model::class, true)) {
        return null;
    }
    $model = new $class();
    $relations = relations($model);
    if ($withRelated) {
        foreach ($relations as &$relation) {
            $related = $relation['related'] ? describeModel($relation['related'], false) : null;
            $relation['columns'] = $related['columns'] ?? [];
            $relation['relations'] = array_column($related['relations'] ?? [], 'name');
        }
    }
    return ['class' => $class] + location(new ReflectionClass($class)) + ['columns' => columns($model), 'casts' => $model->getCasts(), 'relations' => $relations];
}

/** Resource classes declared under app/Filament, found by file name. */
function resourceClasses(string $root): array
{
    return classesIn($root . '/app/Filament', 'Resource.php');
}

/** Classes declared in files under $dir whose names end with $suffix, read from the source. */
function classesIn(string $dir, string $suffix = '.php'): array
{
    $classes = [];
    if (!is_dir($dir)) {
        return [];
    }
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir)) as $file) {
        if (!str_ends_with($file->getFilename(), $suffix)) {
            continue;
        }
        $source = file_get_contents($file->getPathname());
        if (preg_match('/^namespace\s+([^;]+);/m', $source, $ns) && preg_match('/^\s*(?:final\s+|abstract\s+)*class\s+(\w+)/m', $source, $cls)) {
            $classes[] = $ns[1] . '\\' . $cls[1];
        }
    }
    return $classes;
}

/** Columns with their database type and whether they can be null, or with null when the database can't be read. */
function columnDetails(Model $model): array
{
    global $booted;
    if ($booted) {
        try {
            $details = [];
            foreach ($model->getConnection()->getSchemaBuilder()->getColumns($model->getTable()) as $column) {
                $details[$column['name']] = ['type' => $column['type_name'], 'nullable' => $column['nullable']];
            }
            if ($details) {
                return $details;
            }
        } catch (Throwable) {
        }
    }
    return array_fill_keys(columns($model), null);
}

function describeResource(string $resource, ?string $context): array
{
    $model = $resource::getModel();
    $pages = [];
    foreach ($resource::getPages() as $name => $registration) {
        $page = $registration->getPage();
        $pages[] = ['name' => $name, 'class' => $page] + location(new ReflectionClass($page));
    }
    $managers = [];
    foreach ($resource::getRelations() as $manager) {
        if (is_string($manager) && class_exists($manager)) {
            $managers[] = ['class' => $manager] + location(new ReflectionClass($manager));
        }
    }

    // A relation manager's forms and tables work with the related model.
    $subject = $model;
    if ($context && is_a($context, Filament\Resources\RelationManagers\RelationManager::class, true)) {
        $relationship = (new ReflectionClass($context))->getStaticPropertyValue('relationship');
        $subject = get_class((new $model())->{$relationship}()->getRelated());
    }

    return [
        'resource' => ['class' => $resource] + location(new ReflectionClass($resource)),
        'model' => describeModel($subject),
        'resourceModel' => $model,
        'pages' => $pages,
        'relationManagers' => $managers,
    ];
}

/**
 * Writes copies of vendor files into $dir with the types Mago reads wrong fixed, for the editor to give Mago in
 * place of the originals. Returns the replaced files, relative to the project. A copy is made only when a patch
 * applies, so another Laravel version just keeps its own files.
 */
function magoStubs(string $root, string $dir): array
{
    // Pest runs each test closure bound to the test case tests/Pest.php extends, not to the TestCall its docblocks say.
    $pest = @file_get_contents("$root/tests/Pest.php") ?: '';
    $testCase = preg_match('/(?:extend|uses)\(\s*\\\\?([\w\\\\]+)::class/', $pest, $m) ? $m[1] : null;
    // auth()->user() and Auth::user() ask the default guard, whose users are config/auth.php's model for it.
    global $booted;
    $user = $booted ? config('auth.providers.' . config('auth.guards.' . config('auth.defaults.guard') . '.provider') . '.model') : null;
    $user = is_string($user) && class_exists($user) ? $user : null;
    // A collection with `non-negative-int` keys is one with `int` keys, but Laravel declares TKey invariant.
    $covariantKeys = ["\n * @template TKey of array-key" => "\n * @template-covariant TKey of array-key"];
    $plucked = ['@return static<array-key, mixed>' => '@return \\Illuminate\\Support\\Collection<array-key, mixed>'];
    $laravel = 'vendor/laravel/framework/src/Illuminate/';
    // Larastan's narrower types, for what Laravel's docblocks leave wide: the value code gets back in practice.
    $patches = [
        $laravel . 'Foundation/helpers.php' => [
            // A translation key gives a string; only a key for a whole file gives an array.
            '@return ($key is null ? \\Illuminate\\Contracts\\Translation\\Translator : array|string)' => '@return ($key is null ? \\Illuminate\\Contracts\\Translation\\Translator : string)',
            '@return ($key is null ? null : array|string)' => '@return string',
            // The auth manager passes calls such as user() on to the default guard.
            '@return ($guard is null ? \\Illuminate\\Contracts\\Auth\\Factory :' => '@return ($guard is null ? \\Illuminate\\Auth\\AuthManager :',
        ],
        // Artisan calls in tests return a pending command unless output mocking is off.
        $laravel . 'Foundation/Testing/Concerns/InteractsWithConsole.php' => ['@return \\Illuminate\\Testing\\PendingCommand|int' => '@return \\Illuminate\\Testing\\PendingCommand'],
        'vendor/pestphp/pest-plugin-laravel/src/Console.php' => ['@return PendingCommand|int' => '@return PendingCommand'],
        // A service provider's $app is the application, not only its contract.
        $laravel . 'Support/ServiceProvider.php' => ['@var \\Illuminate\\Contracts\\Foundation\\Application' => '@var \\Illuminate\\Foundation\\Application'],
        // Disks are filesystem adapters, which add assertExists(), url(), and more to the contract.
        $laravel . 'Support/Facades/Storage.php' => ['@method static \\Illuminate\\Contracts\\Filesystem\\Filesystem' => '@method static \\Illuminate\\Filesystem\\FilesystemAdapter'],
        'vendor/pestphp/pest/src/Functions.php' => $testCase ? ['@param-closure-this TestCall' => "@param-closure-this \\$testCase"] : [],
        $laravel . 'Auth/AuthManager.php' => $user ? ["\n * @mixin \\Illuminate\\Contracts\\Auth\\Guard\n * @mixin \\Illuminate\\Contracts\\Auth\\StatefulGuard" => "\n * @mixin \\EditorStubs\\DefaultGuard"] : [],
        $laravel . 'Support/Facades/Auth.php' => $user ? ['@method static \\Illuminate\\Contracts\\Auth\\Authenticatable|null user()' => "@method static \\$user|null user()"] : [],
        // pluck() gives a collection of other values; Mago keeps the original values' type for `static<…>`.
        // Sanctum's token model, which Mago otherwise reads as the HasAbilities interface its template is bound by.
        'vendor/laravel/sanctum/src/Sanctum.php' => class_exists('Laravel\Sanctum\Sanctum') ? ['class-string<TToken>' => 'class-string<\\' . ltrim(Laravel\Sanctum\Sanctum::$personalAccessTokenModel, '\\') . '>'] : [],
        $laravel . 'Collections/Collection.php' => $covariantKeys + $plucked,
        $laravel . 'Collections/Enumerable.php' => $covariantKeys + $plucked,
        $laravel . 'Collections/LazyCollection.php' => $covariantKeys,
        $laravel . 'Collections/Traits/EnumeratesValues.php' => $covariantKeys,
        $laravel . 'Database/Eloquent/Collection.php' => $covariantKeys,
        // A query builder of posts is a query builder of models, as Filament's getEloquentQuery() returns.
        $laravel . 'Database/Eloquent/Builder.php' => ["\n * @template TModel of \\Illuminate\\Database\\Eloquent\\Model" => "\n * @template-covariant TModel of \\Illuminate\\Database\\Eloquent\\Model"],
    ];
    $sources = [];
    foreach ($patches as $file => $replacements) {
        if (is_file("$root/$file") && $replacements) {
            $sources[$file] = strtr($original = file_get_contents("$root/$file"), $replacements);
            if ($sources[$file] === $original) {
                unset($sources[$file]);
            }
        }
    }
    // Methods that read their arguments with func_get_args(), such as Facade::shouldReceive(), take any number.
    exec('grep -rl --include=*.php func_get_args vendor', $files);
    foreach ($files as $file) {
        $source = $sources[$file] ?? file_get_contents("$root/$file");
        $variadic = variadicFuncGetArgs($source);
        if ($variadic !== $source) {
            $sources[$file] = $variadic;
        }
    }
    // Copies from an earlier run that no longer apply would stand beside the originals.
    exec('rm -rf ' . escapeshellarg("$dir/vendor"));
    foreach ($sources as $file => $source) {
        @mkdir(dirname("$dir/$file"), 0777, true);
        file_put_contents("$dir/$file", $source);
    }
    if (isset($sources[$laravel . 'Auth/AuthManager.php'])) {
        file_put_contents("$dir/vendor/DefaultGuard.php", "<?php\n\nnamespace EditorStubs;\n\n/** The default guard, which the auth manager passes calls on to. */\ninterface DefaultGuard extends \\Illuminate\\Contracts\\Auth\\StatefulGuard\n{\n    /** @return \\$user|null */\n    public function user();\n}\n");
    }
    return array_keys($sources);
}

/** $source with `...$arguments` added to each function that takes more arguments than it declares, with func_get_args(). */
function variadicFuncGetArgs(string $source): string
{
    $tokens = token_get_all($source);
    $code = fn ($t) => !is_array($t) || !in_array($t[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true);
    $inserts = [];
    foreach ($tokens as $i => $token) {
        if (!is_array($token) || $token[0] !== T_FUNCTION) {
            continue;
        }
        // The parameter list: the `(` after the name (none for `use function`), to its match.
        for ($open = $i + 1; $open < count($tokens) && (!$code($tokens[$open]) || $tokens[$open] === '&' || (is_array($tokens[$open]) && $tokens[$open][0] === T_STRING)); $open++);
        if (($tokens[$open] ?? null) !== '(') {
            continue;
        }
        for ($depth = 0, $close = $open; $close < count($tokens); $close++) {
            $depth += $tokens[$close] === '(' ? 1 : ($tokens[$close] === ')' ? -1 : 0);
            if ($depth === 0) {
                break;
            }
        }
        // The body, if any: from the next `{` (before any `;`) to its match.
        for ($body = $close; $body < count($tokens) && $tokens[$body] !== '{' && $tokens[$body] !== ';'; $body++);
        if (($tokens[$body] ?? ';') !== '{') {
            continue;
        }
        for ($depth = 0, $end = $body; $end < count($tokens); $end++) {
            $t = $tokens[$end];
            $depth += $t === '{' || (is_array($t) && in_array($t[0], [T_CURLY_OPEN, T_DOLLAR_OPEN_CURLY_BRACES], true)) ? 1 : ($t === '}' ? -1 : 0);
            if ($depth === 0) {
                break;
            }
        }
        $text = implode('', array_map(fn ($t) => is_array($t) ? $t[1] : $t, array_slice($tokens, $body, $end - $body)));
        $params = array_values(array_filter(array_slice($tokens, $open + 1, $close - $open - 1), $code));
        // Only functions that take their arguments this way: with no parameters (`shouldReceive()`), or with an array
        // or a list of arguments (`is_array($columns) ? $columns : func_get_args()`, or the other way round); others
        // only pass theirs on.
        $takesMore = !$params ? str_contains($text, 'func_get_args') : preg_match('/\?\s*(\$\w+\s*:\s*func_get_args\(\)|func_get_args\(\)\s*:)/', $text);
        if ($takesMore && !in_array(T_ELLIPSIS, array_map(fn ($t) => is_array($t) ? $t[0] : null, $params), true)) {
            // After no parameters or a trailing comma, no comma of its own.
            $inserts[$close] = !$params || end($params) === ',' ? '...$arguments' : ', ...$arguments';
        }
    }
    $out = '';
    foreach ($tokens as $i => $token) {
        $out .= ($inserts[$i] ?? '') . (is_array($token) ? $token[1] : $token);
    }
    return $out;
}

/** Names of the app's views, such as `filament.widgets.stats`, and of packages' (`filament::page`). */
function viewNames(string $root): array
{
    global $booted;
    $finder = $booted ? app('view')->getFinder() : null;
    $folders = ['' => $finder ? $finder->getPaths() : [$root . '/resources/views']] + array_map(fn ($paths) => (array) $paths, $finder ? $finder->getHints() : []);
    $names = [];
    foreach ($folders as $namespace => $paths) {
        foreach ($paths as $path) {
            if (!is_dir($path)) {
                continue;
            }
            foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS)) as $file) {
                if (preg_match('/^(.*?)(\.blade)?\.php$/', substr($file->getPathname(), strlen($path) + 1), $m)) {
                    $names[] = ($namespace === '' ? '' : "$namespace::") . str_replace('/', '.', $m[1]);
                }
            }
        }
    }
    return array_values(array_unique($names));
}

// ---- The designers: Filament's components, the app's panels and resources, enums, and migrations ----

/** The installed version of a Composer package, such as `v4.1.0`, or null. */
function packageVersion(string $root, string $name): ?string
{
    static $installed = null;
    $installed ??= json_decode((string) @file_get_contents($root . '/vendor/composer/installed.json'), true) ?: [];
    foreach ($installed['packages'] ?? $installed as $package) {
        if (($package['name'] ?? null) === $name) {
            return $package['version'] ?? null;
        }
    }
    return null;
}

/**
 * The PSR-4 folders of Filament's packages and of packages that build on Filament, such as plugins, with the
 * project's own folders under app/: where components can be declared.
 */
function componentFolders(string $root): array
{
    $installed = json_decode((string) @file_get_contents($root . '/vendor/composer/installed.json'), true) ?: [];
    $folders = [];
    foreach ($installed['packages'] ?? $installed as $package) {
        $name = $package['name'] ?? '';
        $requires = array_keys($package['require'] ?? []);
        $filament = str_starts_with($name, 'filament/') || array_filter($requires, fn ($r) => str_starts_with($r, 'filament/'));
        if (!$filament || in_array($name, ['filament/upgrade', 'filament/notifications'], true)) {
            continue;
        }
        $base = $root . '/vendor/composer/' . ($package['install-path'] ?? "../$name");
        foreach ($package['autoload']['psr-4'] ?? [] as $prefix => $dirs) {
            foreach ((array) $dirs as $dir) {
                $folders[] = [$prefix, rtrim($base . '/' . $dir, '/'), $name];
            }
        }
    }
    $composer = json_decode((string) @file_get_contents($root . '/composer.json'), true) ?: [];
    foreach ($composer['autoload']['psr-4'] ?? [] as $prefix => $dirs) {
        foreach ((array) $dirs as $dir) {
            if (is_dir($root . '/' . $dir . '/Filament')) {
                $folders[] = [$prefix . 'Filament\\', $root . '/' . rtrim($dir, '/') . '/Filament', 'app'];
            }
        }
    }
    return $folders;
}

/** A parameter's types, each as a name, with `null` when it takes null. */
function typeNames(?ReflectionType $type): array
{
    if ($type === null) {
        return ['mixed'];
    }
    $types = $type instanceof ReflectionNamedType ? [$type] : ($type instanceof ReflectionUnionType || $type instanceof ReflectionIntersectionType ? $type->getTypes() : []);
    $names = [];
    foreach ($types as $t) {
        $names = [...$names, ...($t instanceof ReflectionNamedType ? [$t->getName()] : typeNames($t))];
    }
    if ($type->allowsNull() && !in_array('null', $names, true) && !in_array('mixed', $names, true)) {
        $names[] = 'null';
    }
    return array_values(array_unique($names));
}

/** A parameter for the designers: its name, types, default value as PHP source, and whether it's optional. */
function describeParameter(ReflectionParameter $p): array
{
    $default = null;
    if ($p->isDefaultValueAvailable()) {
        try {
            $default = $p->isDefaultValueConstant() ? '\\' . ltrim((string) $p->getDefaultValueConstantName(), '\\') : var_export($p->getDefaultValue(), true);
            $default = match ($default) { 'NULL' => 'null', 'array (' . "\n" . ')' => '[]', default => $default };
        } catch (Throwable) {
        }
    }
    return array_filter([
        'name' => $p->getName(),
        'types' => typeNames($p->getType()),
        'default' => $default,
        'optional' => $p->isOptional(),
        'variadic' => $p->isVariadic(),
    ], fn ($v) => $v !== null && $v !== false);
}

/** The first paragraph of a docblock, and whether it's deprecated. */
function docSummary(string|false $doc): array
{
    if (!$doc) {
        return [];
    }
    $lines = array_map(fn ($l) => trim(preg_replace('/^\s*\/?\*+\/?/', '', $l)), explode("\n", $doc));
    $summary = [];
    foreach ($lines as $line) {
        if ($line === '' && $summary) {
            break;
        }
        if ($line !== '' && !str_starts_with($line, '@')) {
            $summary[] = $line;
        }
    }
    return array_filter(['doc' => implode(' ', $summary) ?: null, 'deprecated' => str_contains($doc, '@deprecated') ?: null]);
}

/** The traits a class uses, and the traits those use, in order. */
function traitsOf(ReflectionClass $class): array
{
    $out = [];
    foreach ($class->getTraits() as $trait) {
        $out[] = $trait;
        array_push($out, ...traitsOf($trait));
    }
    return $out;
}

/**
 * Where a method is written: the class or trait whose file and lines hold it. A method from a trait reports the
 * class that uses the trait as its declaring class, so the lines tell them apart.
 */
function sourceOf(ReflectionMethod $method): string
{
    $declaring = $method->getDeclaringClass();
    foreach (traitsOf($declaring) as $trait) {
        if ($trait->getFileName() === $method->getFileName() && $trait->getStartLine() <= $method->getStartLine() && $method->getEndLine() <= $trait->getEndLine()) {
            return $trait->getName();
        }
    }
    return $declaring->getName();
}

/** What a component class is for the designers, by the Filament class it extends, or null for other classes. */
function componentKind(string $class): ?string
{
    $kinds = [
        'Filament\\Forms\\Components\\Field' => 'field',
        'Filament\\Infolists\\Components\\Entry' => 'entry',
        'Filament\\Tables\\Columns\\Layout\\Component' => 'columnLayout',
        'Filament\\Tables\\Columns\\Column' => 'column',
        'Filament\\Tables\\Filters\\BaseFilter' => 'filter',
        'Filament\\Actions\\BulkAction' => 'bulkAction',
        'Filament\\Actions\\Action' => 'action',
        'Filament\\Actions\\ActionGroup' => 'actionGroup',
        'Filament\\Schemas\\Components\\Component' => 'layout',
        'Filament\\Widgets\\Widget' => 'widget',
    ];
    foreach ($kinds as $base => $kind) {
        if ($class === $base || is_subclass_of($class, $base)) {
            return $kind;
        }
    }
    return null;
}

/**
 * Filament's components, columns, filters, and actions, with the fluent methods that configure them, grouped by the
 * class or trait that declares them. Plugins' components and the project's own are included.
 */
function filamentCatalog(string $root): array
{
    $classes = [];
    $sources = [];
    foreach (componentFolders($root) as [$prefix, $dir, $package]) {
        if (!is_dir($dir)) {
            continue;
        }
        foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS)) as $file) {
            $path = $file->getPathname();
            if (!str_ends_with($path, '.php') || str_contains($path, '/Testing/') || str_contains($path, '/Commands/')) {
                continue;
            }
            $source = (string) file_get_contents($path);
            // Only concrete classes can be made; reading the source first spares loading traits, enums, and views.
            if (!preg_match('/^\s*(final\s+|readonly\s+)*class\s+\w+/m', $source) || !str_contains($source, 'extends')) {
                continue;
            }
            $class = $prefix . str_replace('/', '\\', substr($path, strlen($dir) + 1, -4));
            try {
                if (!class_exists($class) || !($kind = componentKind($class))) {
                    continue;
                }
                $reflection = new ReflectionClass($class);
                if ($reflection->isAbstract() || !$reflection->hasMethod('make') || !$reflection->getMethod('make')->isStatic()) {
                    continue;
                }
                $order = [];
                foreach ($reflection->getMethods(ReflectionMethod::IS_PUBLIC) as $method) {
                    $name = $method->getName();
                    $returns = $method->getReturnType();
                    if ($method->isStatic() || str_starts_with($name, '__') || !$returns instanceof ReflectionNamedType || !in_array($returns->getName(), ['static', 'self', $method->getDeclaringClass()->getName()], true)) {
                        continue;
                    }
                    $from = sourceOf($method);
                    $order[$from] = true;
                    $sources[$from]['methods'][$name] ??= ['params' => array_map('describeParameter', $method->getParameters())] + docSummary($method->getDocComment());
                }
                $parents = [];
                for ($p = $reflection->getParentClass(); $p; $p = $p->getParentClass()) {
                    $parents[] = $p->getName();
                }
                // Most specific first: the class, its traits, then each parent and its traits, as PHP resolves them.
                $chain = [];
                foreach ([$reflection, ...array_map(fn ($c) => new ReflectionClass($c), $parents)] as $level) {
                    foreach ([$level, ...traitsOf($level)] as $s) {
                        if (isset($order[$s->getName()]) && !in_array($s->getName(), $chain, true)) {
                            $chain[] = $s->getName();
                        }
                    }
                }
                $classes[] = [
                    'class' => $class,
                    'kind' => $kind,
                    'package' => $package,
                    'parents' => $parents,
                    'interfaces' => array_values($reflection->getInterfaceNames()),
                    'make' => array_map('describeParameter', $reflection->getMethod('make')->getParameters()),
                    'sources' => $chain,
                ] + docSummary($reflection->getDocComment());
            } catch (Throwable) {
            }
        }
    }
    foreach ($sources as $name => &$source) {
        $source['label'] = substr($name, strrpos($name, '\\') + 1);
        ksort($source['methods']);
    }
    usort($classes, fn ($a, $b) => strcmp($a['class'], $b['class']));
    // The enums parameters take, such as Alignment, with their cases, for the designers' lists.
    $enums = [];
    foreach ($sources as $source) {
        foreach ($source['methods'] as $method) {
            foreach ($method['params'] as $param) {
                foreach ($param['types'] as $type) {
                    if (!isset($enums[$type]) && enum_exists($type)) {
                        $enums[$type] = array_map(fn ($c) => ['name' => $c->name, 'value' => $c instanceof BackedEnum ? $c->value : null], $type::cases());
                    }
                }
            }
        }
    }
    return [
        'enums' => $enums,
        'version' => packageVersion($root, 'filament/filament'),
        'classes' => $classes,
        'sources' => $sources,
        'resourceProperties' => staticProperties('Filament\\Resources\\Resource'),
        'relationManagerProperties' => staticProperties('Filament\\Resources\\RelationManagers\\RelationManager'),
        'heroicons' => enum_exists('Filament\\Support\\Icons\\Heroicon') ? array_map(fn ($c) => $c->name, Filament\Support\Icons\Heroicon::cases()) : [],
        'heroiconsDir' => heroiconsDir(),
    ];
}

/** A class's static properties, with their types and defaults as PHP source, for the designers' settings. */
function staticProperties(string $class): array
{
    if (!class_exists($class)) {
        return [];
    }
    $out = [];
    foreach ((new ReflectionClass($class))->getProperties(ReflectionProperty::IS_STATIC) as $p) {
        if ($p->isPrivate()) {
            continue;
        }
        $default = $p->hasDefaultValue() ? var_export($p->getDefaultValue(), true) : null;
        $out[$p->getName()] = ['type' => $p->getType() ? (string) $p->getType() : null, 'default' => $default === 'NULL' ? 'null' : $default];
    }
    return $out;
}

/** The folder of Heroicons' SVG files, from blade-heroicons, or null. */
function heroiconsDir(): ?string
{
    if (!class_exists('BladeUI\\Heroicons\\BladeHeroiconsServiceProvider')) {
        return null;
    }
    $dir = dirname((new ReflectionClass('BladeUI\\Heroicons\\BladeHeroiconsServiceProvider'))->getFileName(), 2) . '/resources/svg';
    return is_dir($dir) ? $dir : null;
}

/** A value for JSON: an enum's value, a string, or null for anything else, such as an Htmlable icon. */
function plainValue(mixed $value): mixed
{
    return match (true) {
        $value instanceof BackedEnum => $value->value,
        $value instanceof UnitEnum => $value->name,
        is_scalar($value) || $value === null => $value,
        $value instanceof Stringable => (string) $value,
        default => null,
    };
}

/** Calls a static method and returns its plain value, or null when it fails, as when it needs a request. */
function tryStatic(string $class, string $method): mixed
{
    try {
        return method_exists($class, $method) ? plainValue($class::$method()) : null;
    } catch (Throwable) {
        return null;
    }
}

/** A class's file, relative to the project. */
function relativeFile(string $class, string $root): ?string
{
    try {
        $file = (new ReflectionClass($class))->getFileName();
    } catch (Throwable) {
        return null;
    }
    return $file ? ltrim(str_replace($root, '', $file), '/') : null;
}

/** A resource for the designers: its model, labels, navigation, pages, and relation managers. */
function designerResource(string $resource, string $root): array
{
    $pages = [];
    foreach (($resource::getPages()) as $name => $registration) {
        try {
            $page = $registration->getPage();
            $kind = match (true) {
                is_subclass_of($page, 'Filament\\Resources\\Pages\\ListRecords') => 'list',
                is_subclass_of($page, 'Filament\\Resources\\Pages\\CreateRecord') => 'create',
                is_subclass_of($page, 'Filament\\Resources\\Pages\\EditRecord') => 'edit',
                is_subclass_of($page, 'Filament\\Resources\\Pages\\ViewRecord') => 'view',
                is_subclass_of($page, 'Filament\\Resources\\Pages\\ManageRecords') => 'manage',
                is_subclass_of($page, 'Filament\\Resources\\Pages\\ManageRelatedRecords') => 'related',
                default => 'custom',
            };
            $pages[] = ['name' => $name, 'class' => $page, 'file' => relativeFile($page, $root), 'kind' => $kind];
        } catch (Throwable) {
        }
    }
    $relations = [];
    $managers = [];
    try {
        $managers = $resource::getRelations();
    } catch (Throwable) {
    }
    foreach ($managers as $manager) {
        $group = null;
        if (is_object($manager) && method_exists($manager, 'getManagers')) {
            $group = plainValue($manager->getLabel());
            $list = $manager->getManagers();
        } else {
            $list = [$manager];
        }
        foreach ($list as $m) {
            $m = is_object($m) && method_exists($m, 'getRelationManager') ? $m->getRelationManager() : $m;
            if (!is_string($m) || !class_exists($m)) {
                continue;
            }
            $r = new ReflectionClass($m);
            $relations[] = [
                'class' => $m,
                'file' => relativeFile($m, $root),
                'relationship' => $r->hasProperty('relationship') ? $r->getStaticPropertyValue('relationship', null) : null,
                'title' => tryStatic($m, 'getTitleAttribute') ?? ($r->hasProperty('recordTitleAttribute') ? $r->getStaticPropertyValue('recordTitleAttribute', null) : null),
                'group' => $group,
            ];
        }
    }
    $model = $resource::getModel();
    $cluster = tryStatic($resource, 'getCluster');
    return [
        'class' => $resource,
        'file' => relativeFile($resource, $root),
        'model' => $model,
        'modelFile' => class_exists($model) ? relativeFile($model, $root) : null,
        'label' => tryStatic($resource, 'getModelLabel'),
        'pluralLabel' => tryStatic($resource, 'getPluralModelLabel'),
        'navigationLabel' => tryStatic($resource, 'getNavigationLabel'),
        'navigationGroup' => tryStatic($resource, 'getNavigationGroup'),
        'navigationIcon' => tryStatic($resource, 'getNavigationIcon'),
        'navigationSort' => tryStatic($resource, 'getNavigationSort'),
        'slug' => tryStatic($resource, 'getSlug'),
        'cluster' => is_string($cluster) ? $cluster : null,
        'softDeletes' => class_exists($model) && in_array('Illuminate\\Database\\Eloquent\\SoftDeletes', class_uses_recursive($model), true),
        'pages' => $pages,
        'relations' => $relations,
    ];
}

/** The app's Filament panels, each with its folders, resources, and clusters. Needs the booted app. */
function filamentApp(string $root): array
{
    global $booted, $bootError;
    $out = ['version' => packageVersion($root, 'filament/filament'), 'booted' => $booted, 'bootError' => $bootError, 'panels' => []];
    if (!$booted || !class_exists('Filament\\Facades\\Filament')) {
        // The resource files, read from the source, so they can still be opened.
        $out['files'] = resourceFiles($root);
        return $out;
    }
    // Each panel's provider, so the designers can open it or add a resource folder.
    $providers = [];
    foreach (classesIn($root . '/app/Providers') as $provider) {
        try {
            if (is_subclass_of($provider, 'Filament\\PanelProvider')) {
                $panel = (new $provider(app()))->panel(Filament\Panel::make());
                $providers[$panel->getId()] = ['class' => $provider, 'file' => relativeFile($provider, $root)];
            }
        } catch (Throwable) {
        }
    }
    foreach (Filament\Facades\Filament::getPanels() as $panel) {
        $call = fn (string $method, mixed $fallback = []) => method_exists($panel, $method) ? (function () use ($panel, $method, $fallback) {
            try {
                return $panel->$method();
            } catch (Throwable) {
                return $fallback;
            }
        })() : $fallback;
        $resources = [];
        foreach ($call('getResources') as $resource) {
            try {
                $resources[] = designerResource($resource, $root);
            } catch (Throwable $e) {
                $resources[] = ['class' => $resource, 'file' => relativeFile($resource, $root), 'error' => $e->getMessage()];
            }
        }
        $clusters = [];
        foreach ($call('getClusters') as $cluster) {
            $clusters[] = ['class' => $cluster, 'file' => relativeFile($cluster, $root), 'label' => tryStatic($cluster, 'getClusterBreadcrumb') ?? tryStatic($cluster, 'getNavigationLabel')];
        }
        $relative = fn (array $dirs) => array_values(array_map(fn ($d) => ltrim(str_replace($root, '', $d), '/'), $dirs));
        $out['panels'][] = [
            'id' => $panel->getId(),
            'path' => $panel->getPath(),
            'default' => $panel->isDefault(),
            'provider' => $providers[$panel->getId()] ?? null,
            'resourceDirs' => $relative($call('getResourceDirectories')),
            'resourceNamespaces' => $call('getResourceNamespaces'),
            'clusterDirs' => $relative($call('getClusterDirectories')),
            'clusterNamespaces' => $call('getClusterNamespaces'),
            'widgetDirs' => $relative($call('getWidgetDirectories')),
            'widgetNamespaces' => $call('getWidgetNamespaces'),
            'pageDirs' => $relative($call('getPageDirectories')),
            'pageNamespaces' => $call('getPageNamespaces'),
            'url' => (function () use ($panel) {
                try {
                    return $panel->getUrl();
                } catch (Throwable) {
                    return null;
                }
            })(),
            'resources' => $resources,
            'clusters' => $clusters,
            // Custom pages: not dashboards, which the dashboard view shows, and not the auth pages.
            'pages' => array_values(array_map(fn ($page) => [
                'class' => $page,
                'file' => relativeFile($page, $root),
                'label' => tryStatic($page, 'getNavigationLabel'),
                'navigationIcon' => (function () use ($page) {
                    $icon = tryStatic($page, 'getNavigationIcon');
                    return $icon instanceof BackedEnum ? $icon->name : (is_string($icon) ? $icon : null);
                })(),
                'navigationGroup' => plainValue(tryStatic($page, 'getNavigationGroup')),
                'navigationSort' => tryStatic($page, 'getNavigationSort'),
            ], array_filter($call('getPages'), fn ($page) => !is_a($page, 'Filament\\Pages\\Dashboard', true)))),
        ];
    }
    return $out;
}

/** The app's enums under app/, with their cases and the Filament contracts they implement for labels, colors, and icons. */
function appEnums(string $root): array
{
    $out = [];
    foreach (enumsIn($root . '/app') as $class) {
        try {
            if (!enum_exists($class)) {
                continue;
            }
            $out[] = [
                'class' => $class,
                'file' => relativeFile($class, $root),
                'backed' => is_subclass_of($class, BackedEnum::class),
                'cases' => array_map(fn ($c) => ['name' => $c->name, 'value' => $c instanceof BackedEnum ? $c->value : null], $class::cases()),
                'contracts' => array_values(array_map(fn ($i) => substr($i, strrpos($i, '\\') + 1), array_filter(class_implements($class), fn ($i) => str_starts_with($i, 'Filament\\Support\\Contracts\\')))),
            ];
        } catch (Throwable) {
        }
    }
    return $out;
}

/** Resource files under app/Filament, by class name read from the source, without loading them. */
function resourceFiles(string $root): array
{
    $dir = $root . '/app/Filament';
    $out = [];
    if (!is_dir($dir)) {
        return [];
    }
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS)) as $file) {
        if (!str_ends_with($file->getFilename(), 'Resource.php')) {
            continue;
        }
        $source = (string) file_get_contents($file->getPathname());
        if (preg_match('/^namespace\s+([^;]+);/m', $source, $ns) && preg_match('/^\s*(?:final\s+|abstract\s+)*class\s+(\w+)\s+extends\s+\w*Resource\b/m', $source, $cls)) {
            $out[] = ['class' => $ns[1] . '\\' . $cls[1], 'file' => ltrim(str_replace($root, '', $file->getPathname()), '/')];
        }
    }
    usort($out, fn ($a, $b) => strcmp($a['file'], $b['file']));
    return $out;
}

/** Enums declared in files under $dir, read from the source. */
function enumsIn(string $dir): array
{
    $enums = [];
    if (!is_dir($dir)) {
        return [];
    }
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS)) as $file) {
        if (!str_ends_with($file->getFilename(), '.php')) {
            continue;
        }
        $source = (string) file_get_contents($file->getPathname());
        if (preg_match('/^namespace\s+([^;]+);/m', $source, $ns) && preg_match('/^\s*enum\s+(\w+)/m', $source, $enum)) {
            $enums[] = $ns[1] . '\\' . $enum[1];
        }
    }
    return $enums;
}

/** The migration files, with whether each has run, and whether the database could be read. */
function migrationStatus(string $root): array
{
    global $booted;
    $ran = null;
    if ($booted) {
        try {
            $repository = app('migrator')->getRepository();
            $ran = $repository->repositoryExists() ? $repository->getRan() : [];
        } catch (Throwable) {
        }
    }
    $files = [];
    foreach (glob($root . '/database/migrations/*.php') ?: [] as $file) {
        $name = basename($file, '.php');
        $files[] = ['name' => $name, 'file' => 'database/migrations/' . basename($file), 'ran' => $ran === null ? null : in_array($name, $ran, true)];
    }
    return ['database' => $ran !== null, 'files' => $files];
}

/**
 * One model in full for the model designer: its table's columns with their types, defaults, and indexes, the
 * foreign keys, and what the model declares: fillable, hidden, casts, relationships, soft deletes, and timestamps.
 */
function modelDetails(string $class, string $root): array
{
    global $booted;
    if (!is_a($class, Model::class, true)) {
        throw new InvalidArgumentException("Not a model: $class");
    }
    $model = new $class();
    $table = $model->getTable();
    $columns = null;
    $indexes = [];
    $foreignKeys = [];
    $tableExists = null;
    if ($booted) {
        try {
            $schema = $model->getConnection()->getSchemaBuilder();
            $tableExists = $schema->hasTable($table);
            if ($tableExists) {
                $columns = array_map(fn ($c) => [
                    'name' => $c['name'],
                    'type' => $c['type_name'],
                    'fullType' => $c['type'],
                    'nullable' => $c['nullable'],
                    'default' => $c['default'],
                    'autoIncrement' => $c['auto_increment'],
                    'comment' => $c['comment'] ?? null,
                ], $schema->getColumns($table));
                $indexes = array_map(fn ($i) => ['name' => $i['name'], 'columns' => $i['columns'], 'unique' => $i['unique'], 'primary' => $i['primary']], $schema->getIndexes($table));
                $foreignKeys = array_map(fn ($f) => ['columns' => $f['columns'], 'foreignTable' => $f['foreign_table'], 'foreignColumns' => $f['foreign_columns'], 'onDelete' => $f['on_delete'] ?? null], $schema->getForeignKeys($table));
            }
        } catch (Throwable) {
        }
    }
    return [
        'class' => $class,
        'file' => relativeFile($class, $root),
        'table' => $table,
        'connection' => $booted ? $model->getConnectionName() ?? config('database.default') : null,
        'tableExists' => $tableExists,
        'columns' => $columns,
        'indexes' => $indexes,
        'foreignKeys' => $foreignKeys,
        'keyName' => $model->getKeyName(),
        'keyType' => $model->getKeyType(),
        'incrementing' => $model->getIncrementing(),
        'timestamps' => $model->usesTimestamps(),
        'softDeletes' => in_array('Illuminate\\Database\\Eloquent\\SoftDeletes', class_uses_recursive($model), true),
        'fillable' => $model->getFillable(),
        'guarded' => $model->getGuarded(),
        'hidden' => $model->getHidden(),
        'casts' => $model->getCasts(),
        'relations' => relations($model),
        'factory' => method_exists($model, 'newFactory') || in_array('Illuminate\\Database\\Eloquent\\Factories\\HasFactory', class_uses_recursive($model), true),
    ];
}

/** A model's policy, and spatie/laravel-permission's roles and permissions, for the designer's Access tab. */
function policyInfo(string $model, string $root, ?string $resource = null): array
{
    $policy = null;
    try {
        $found = Illuminate\Support\Facades\Gate::getPolicyFor($model);
        $policy = $found ? get_class($found) : null;
    } catch (Throwable) {
    }
    $spatie = class_exists('Spatie\\Permission\\Models\\Permission');
    $user = config('auth.providers.users.model');
    $out = [
        'policy' => $policy,
        'file' => $policy ? relativeFile($policy, $root) : null,
        'user' => is_string($user) ? $user : null,
        'spatie' => $spatie,
        'hasRoles' => is_string($user) && class_exists($user) && method_exists($user, 'hasRole'),
        'shield' => class_exists('BezhanSalleh\\FilamentShield\\FilamentShield'),
        'roles' => [],
        'permissions' => [],
        'error' => null,
    ];
    // Filament Shield names permissions by its config, or the app's own key builder: ask it for the resource's.
    if ($out['shield']) {
        $config = (array) config('filament-shield.permissions', []);
        $superAdmin = (array) config('filament-shield.super_admin', []);
        $out['shieldFormat'] = ['separator' => (string) ($config['separator'] ?? '_'), 'case' => (string) ($config['case'] ?? 'lower_snake')];
        $out['superAdmin'] = ($superAdmin['enabled'] ?? false) ? ['name' => (string) ($superAdmin['name'] ?? 'super_admin'), 'viaGate' => (bool) ($superAdmin['define_via_gate'] ?? false)] : null;
        $out['shieldKeys'] = null;
        if ($resource && class_exists($resource)) {
            try {
                $methods = (array) config('filament-shield.policies.methods', ['viewAny', 'view', 'create', 'update', 'delete', 'restore', 'forceDelete', 'forceDeleteAny', 'restoreAny', 'replicate', 'reorder']);
                $keys = BezhanSalleh\FilamentShield\Facades\FilamentShield::getDefaultPermissionKeys($resource, $methods);
                $out['shieldKeys'] = array_map(fn ($k) => $k['key'], $keys);
            } catch (Throwable) {
            }
        }
    }
    if ($spatie) {
        try {
            $out['permissions'] = Spatie\Permission\Models\Permission::query()->orderBy('name')->pluck('name')->all();
            $out['roles'] = Spatie\Permission\Models\Role::query()->with('permissions')->orderBy('name')->get()->map(fn ($r) => ['name' => $r->name, 'permissions' => $r->permissions->pluck('name')->all()])->all();
        } catch (Throwable $e) {
            $out['error'] = $e->getMessage();
        }
    }
    return $out;
}

/** The app's own translations: lang/<locale>.json, and lang/<locale>/*.php flattened to `file.key`. */
function appTranslations(string $root): array
{
    $dir = function_exists('lang_path') ? lang_path() : $root . '/lang';
    $out = ['dir' => $dir, 'locale' => (string) config('app.locale', 'en'), 'fallback' => (string) config('app.fallback_locale', 'en'), 'locales' => [], 'json' => new stdClass(), 'php' => new stdClass()];
    $flatten = function (array $values, string $prefix) use (&$flatten): array {
        $flat = [];
        foreach ($values as $key => $value) {
            if (is_array($value)) {
                $flat += $flatten($value, "{$prefix}{$key}.");
            } elseif (is_string($value)) {
                $flat["{$prefix}{$key}"] = $value;
            }
        }
        return $flat;
    };
    foreach (glob($dir . '/*.json') ?: [] as $file) {
        $locale = basename($file, '.json');
        $values = json_decode((string) file_get_contents($file), true);
        $out['json']->{$locale} = is_array($values) ? (object) array_filter($values, 'is_string') : new stdClass();
        $out['locales'][] = $locale;
    }
    foreach (glob($dir . '/*', GLOB_ONLYDIR) ?: [] as $folder) {
        $locale = basename($folder);
        if ($locale === 'vendor') {
            continue;
        }
        $strings = [];
        foreach (glob($folder . '/*.php') ?: [] as $file) {
            try {
                $values = include $file;
            } catch (Throwable) {
                continue;
            }
            if (is_array($values)) {
                $strings += $flatten($values, basename($file, '.php') . '.');
            }
        }
        $out['php']->{$locale} = (object) $strings;
        $out['locales'][] = $locale;
    }
    $out['locales'] = array_values(array_unique([...$out['locales'], $out['locale']]));
    sort($out['locales']);
    return $out;
}

/** Creates a permission or role, or grants or revokes a role's permission, with spatie/laravel-permission. */
function changePermission(string $action, string $name, ?string $permission): array
{
    $roles = 'Spatie\\Permission\\Models\\Role';
    $permissions = 'Spatie\\Permission\\Models\\Permission';
    if (!class_exists($permissions)) {
        throw new RuntimeException('spatie/laravel-permission is not installed.');
    }
    match ($action) {
        'create-permission' => $permissions::findOrCreate($name),
        'create-role' => $roles::findOrCreate($name),
        'grant' => $roles::findOrCreate($name)->givePermissionTo($permissions::findOrCreate((string) $permission)),
        'revoke' => $roles::findByName($name)->revokePermissionTo((string) $permission),
        default => throw new InvalidArgumentException("Unknown permission change: {$action}"),
    };
    app(Spatie\Permission\PermissionRegistrar::class)->forgetCachedPermissions();
    return ['ok' => true];
}

/**
 * A panel's dashboards and widgets: the widgets the panel registers or discovers, in the order a dashboard shows
 * them, each with its kind, sort, column span, and heading; each dashboard page with its columns and, when it lists
 * its own widgets in getWidgets(), those; and widgets in the panel's folders that turned discovery off. Needs the
 * booted app.
 */
function panelWidgets(string $root, string $id): array
{
    $panel = Filament\Facades\Filament::getPanel($id);
    $kinds = [
        'stats' => 'Filament\\Widgets\\StatsOverviewWidget',
        'chart' => 'Filament\\Widgets\\ChartWidget',
        'table' => 'Filament\\Widgets\\TableWidget',
    ];
    $read = function (object $widget, string $property): mixed {
        try {
            $r = new ReflectionProperty($widget, $property);
            return $r->isInitialized($widget) ? plainValue($r->getValue($widget)) : null;
        } catch (Throwable) {
            return null;
        }
    };
    $describe = function (mixed $entry) use ($kinds, $read, $root): ?array {
        $class = is_string($entry) ? $entry : ($entry->widget ?? null);
        if (!is_string($class) || !class_exists($class)) {
            return null;
        }
        $kind = 'other';
        foreach ($kinds as $name => $base) {
            if (is_subclass_of($class, $base)) {
                $kind = $name;
            }
        }
        try {
            $widget = app($class);
        } catch (Throwable) {
            $widget = null;
        }
        return [
            'class' => $class,
            'file' => relativeFile($class, $root),
            'kind' => $kind,
            'sort' => tryStatic($class, 'getSort'),
            'columnSpan' => $widget ? $read($widget, 'columnSpan') : null,
            'heading' => $widget ? $read($widget, 'heading') : null,
            'discovered' => method_exists($class, 'isDiscovered') ? $class::isDiscovered() : true,
        ];
    };
    // The panel's list, sorted as Filament sorts it.
    $widgets = array_values(array_filter(array_map($describe, $panel->getWidgets())));
    $dashboards = [];
    foreach ($panel->getPages() as $page) {
        if (!is_a($page, 'Filament\\Pages\\Dashboard', true)) {
            continue;
        }
        $own = null;
        try {
            $instance = app($page);
            $columns = plainValue($instance->getColumns());
            if ((new ReflectionMethod($page, 'getWidgets'))->getDeclaringClass()->getName() !== 'Filament\\Pages\\Dashboard') {
                $own = array_values(array_filter(array_map($describe, $instance->getWidgets())));
            }
        } catch (Throwable) {
            $columns = 2;
        }
        $dashboards[] = ['class' => $page, 'file' => relativeFile($page, $root), 'title' => tryStatic($page, 'getNavigationLabel'), 'columns' => $columns, 'widgets' => $own];
    }
    $hidden = [];
    foreach ($panel->getWidgetDirectories() as $dir) {
        foreach (classesIn($dir) as $class) {
            try {
                if (is_subclass_of($class, 'Filament\\Widgets\\Widget') && method_exists($class, 'isDiscovered') && !$class::isDiscovered() && !(new ReflectionClass($class))->isAbstract()) {
                    $hidden[] = $describe($class);
                }
            } catch (Throwable) {
            }
        }
    }
    return ['widgets' => $widgets, 'dashboards' => $dashboards, 'hidden' => $hidden];
}

/**
 * A panel's navigation as Filament builds it, without the signed-in user's access checks: its pages, resources, and
 * clusters, and the provider's own navigation items, each with its label, icon, group, sort, parent item, badge, and
 * cluster; whether it registers in the navigation; and which settings a method outside Filament decides, by the file
 * that declares it. Also the panel's navigation groups in order, and whether a builder replaces the navigation.
 */
function panelNavigation(string $root, string $id): array
{
    $panel = Filament\Facades\Filament::getPanel($id);
    Filament\Facades\Filament::setCurrentPanel($panel);
    $call = function (string $class, string $method): mixed {
        try {
            return method_exists($class, $method) ? $class::$method() : null;
        } catch (Throwable) {
            return null;
        }
    };
    $icon = fn (mixed $v) => $v instanceof BackedEnum ? $v->name : (is_string($v) ? $v : null);
    // A group as written: a label, or an enum case with its label.
    $group = function (mixed $g): ?array {
        if ($g instanceof UnitEnum) {
            $label = $g instanceof Filament\Support\Contracts\HasLabel ? $g->getLabel() : $g->name;
            return ['label' => (string) $label, 'enum' => get_class($g), 'case' => $g->name, 'index' => array_search($g, $g::cases(), true)];
        }
        return filled($g) ? ['label' => (string) $g, 'enum' => null, 'case' => null] : null;
    };
    $settings = [
        'navigationLabel' => 'getNavigationLabel',
        'navigationIcon' => 'getNavigationIcon',
        'navigationGroup' => 'getNavigationGroup',
        'navigationSort' => 'getNavigationSort',
        'navigationParentItem' => 'getNavigationParentItem',
        'shouldRegisterNavigation' => 'shouldRegisterNavigation',
        'cluster' => 'getCluster',
    ];
    $describe = function (string $class, string $kind) use ($call, $icon, $group, $settings, $root): array {
        $overrides = [];
        foreach ($settings as $setting => $method) {
            try {
                $declaring = (new ReflectionMethod($class, $method))->getDeclaringClass();
                if (!str_starts_with($declaring->getName(), 'Filament\\')) {
                    $overrides[$setting] = relativeFile($declaring->getName(), $root);
                }
            } catch (Throwable) {
            }
        }
        $badge = $call($class, 'getNavigationBadge');
        return [
            'kind' => $kind,
            'class' => $class,
            'file' => relativeFile($class, $root),
            'label' => plainValue($call($class, 'getNavigationLabel')),
            'icon' => $icon($call($class, 'getNavigationIcon')),
            'group' => $group($call($class, 'getNavigationGroup')),
            'sort' => $call($class, 'getNavigationSort'),
            'parent' => $call($class, 'getNavigationParentItem'),
            'badge' => is_scalar($badge) ? (string) $badge : null,
            'cluster' => $call($class, 'getCluster'),
            // A cluster hides while no one can open what's in it; its own setting is the property.
            'registers' => $kind === 'cluster' && !isset($overrides['shouldRegisterNavigation'])
                ? (bool) (new ReflectionProperty($class, 'shouldRegisterNavigation'))->getValue()
                : (bool) ($call($class, 'shouldRegisterNavigation') ?? true),
            // A resource without a list page has no navigation item.
            'hasItem' => $kind !== 'resource' || $class::hasPage('index'),
            'overrides' => (object) $overrides,
        ];
    };
    $items = [];
    // Filament registers pages, then resources; items with the same sort keep that order.
    $clusters = $panel->getClusters();
    foreach ($panel->getPages() as $page) {
        if (in_array($page, $clusters, true) || !method_exists($page, 'getNavigationItems')) {
            continue;
        }
        $items[] = $describe($page, is_a($page, 'Filament\\Pages\\Dashboard', true) ? 'dashboard' : 'page');
    }
    foreach ($clusters as $cluster) {
        $items[] = $describe($cluster, 'cluster');
    }
    foreach ($panel->getResources() as $resource) {
        try {
            if (!$resource::getParentResourceRegistration()) {
                $items[] = $describe($resource, 'resource');
            }
        } catch (Throwable) {
        }
    }
    // Items the provider adds with navigationItems([...]).
    foreach ($panel->getNavigationItems() as $item) {
        try {
            $items[] = ['kind' => 'link', 'class' => null, 'file' => null, 'label' => plainValue($item->getLabel()), 'icon' => $icon($item->getIcon()), 'group' => $group($item->getGroup()), 'sort' => $item->getSort() === -1 ? null : $item->getSort(), 'parent' => $item->getParentItem(), 'badge' => is_scalar($item->getBadge()) ? (string) $item->getBadge() : null, 'cluster' => null, 'registers' => $item->isVisible(), 'hasItem' => true, 'overrides' => (object) []];
        } catch (Throwable) {
        }
    }
    $groups = [];
    foreach ($panel->getNavigationGroups() as $key => $g) {
        $groups[] = $g instanceof Filament\Navigation\NavigationGroup
            ? ['key' => $key, 'label' => plainValue($g->getLabel()), 'icon' => $icon($g->getIcon()), 'collapsed' => $g->isCollapsed()]
            : ['key' => $key, 'label' => (string) $g, 'icon' => null, 'collapsed' => false];
    }
    $builder = (new ReflectionProperty($panel, 'navigationBuilder'))->getValue($panel);
    return ['items' => $items, 'groups' => $groups, 'custom' => $builder !== true, 'topNavigation' => $panel->hasTopNavigation()];
}

/** What a stats or chart widget shows, from its own code: each stat's label, value, and chart, or the chart's data. */
function widgetData(string $class): array
{
    // Widgets often read the signed-in user, so the preview runs as the first one.
    $as = null;
    try {
        $model = config('auth.providers.users.model');
        if (is_string($model) && ($user = $model::query()->first())) {
            auth()->setUser($user);
            $as = $user->email ?? $user->name ?? (string) $user->getKey();
        }
    } catch (Throwable) {
    }
    $widget = app($class);
    $call = function (string $method) use ($widget): mixed {
        $m = new ReflectionMethod($widget, $method);
        $m->setAccessible(true);
        return $m->invoke($widget);
    };
    $text = fn (mixed $v): ?string => $v === null ? null : ($v instanceof Illuminate\Contracts\Support\Htmlable ? strip_tags($v->toHtml()) : (is_scalar($v) || $v instanceof Stringable ? (string) $v : null));
    if (method_exists($widget, 'getStats')) {
        return ['as' => $as, 'stats' => array_map(fn ($s) => ['label' => $text($s->getLabel()), 'value' => $text($s->getValue()), 'chart' => $s->getChart()], $call('getStats'))];
    }
    $plain = function (mixed $v) use (&$plain): mixed {
        return is_array($v) ? array_map($plain, $v) : ($v instanceof Illuminate\Support\Collection ? $plain($v->all()) : plainValue($v));
    };
    return ['as' => $as, 'chart' => $plain($call('getData')), 'type' => $call('getType')];
}

/**
 * What the panel settings offer: Filament's color palettes (each one's 500 shade, for previews), the Filament
 * plugins installed with Composer, the app's name (the default brand name), and the user model with the contracts
 * a panel's features need.
 */
function panelOptions(string $root): array
{
    $palettes = [];
    if (class_exists('Filament\\Support\\Colors\\Color')) {
        foreach ((new ReflectionClass('Filament\\Support\\Colors\\Color'))->getConstants() as $name => $value) {
            if (is_array($value) && isset($value[500])) {
                $palettes[$name] = $value[500];
            }
        }
    }
    // A package's plugin: a class named *Plugin in its PSR-4 folders that implements Filament's Plugin contract.
    $plugins = [];
    $installed = json_decode((string) @file_get_contents($root . '/vendor/composer/installed.json'), true);
    foreach ($installed['packages'] ?? $installed ?? [] as $package) {
        $name = $package['name'] ?? '';
        if (str_starts_with($name, 'filament/') || !preg_grep('#^filament/#', array_keys($package['require'] ?? []))) {
            continue;
        }
        $dir = $root . '/vendor/' . $name;
        foreach ($package['autoload']['psr-4'] ?? [] as $namespace => $paths) {
            foreach ((array) $paths as $path) {
                $base = rtrim($dir . '/' . $path, '/');
                if (!is_dir($base)) {
                    continue;
                }
                $files = new RegexIterator(new RecursiveIteratorIterator(new RecursiveDirectoryIterator($base, FilesystemIterator::SKIP_DOTS)), '/Plugin\.php$/');
                foreach ($files as $file) {
                    $class = $namespace . str_replace(['/', '.php'], ['\\', ''], substr($file->getPathname(), strlen($base) + 1));
                    try {
                        if (class_exists($class) && is_subclass_of($class, 'Filament\\Contracts\\Plugin') && !(new ReflectionClass($class))->isAbstract()) {
                            $plugins[] = ['class' => $class, 'package' => $name, 'description' => $package['description'] ?? null];
                        }
                    } catch (Throwable) {
                    }
                }
            }
        }
    }
    $user = null;
    try {
        $class = config('auth.providers.users.model');
        if (is_string($class) && class_exists($class)) {
            $table = (new $class())->getTable();
            $has = function (string $column) use ($table): ?bool {
                try {
                    return Illuminate\Support\Facades\Schema::hasColumn($table, $column);
                } catch (Throwable) {
                    return null;
                }
            };
            $user = [
                'class' => $class,
                'file' => relativeFile($class, $root),
                'table' => $table,
                'hasTenants' => is_subclass_of($class, 'Filament\\Models\\Contracts\\HasTenants'),
                'filamentUser' => is_subclass_of($class, 'Filament\\Models\\Contracts\\FilamentUser'),
                // What two-factor sign-in needs from the user model and its table.
                'mfa' => [
                    'app' => is_subclass_of($class, 'Filament\\Auth\\MultiFactor\\App\\Contracts\\HasAppAuthentication'),
                    'recovery' => is_subclass_of($class, 'Filament\\Auth\\MultiFactor\\App\\Contracts\\HasAppAuthenticationRecovery'),
                    'email' => is_subclass_of($class, 'Filament\\Auth\\MultiFactor\\Email\\Contracts\\HasEmailAuthentication'),
                    'columns' => [
                        'app_authentication_secret' => $has('app_authentication_secret'),
                        'app_authentication_recovery_codes' => $has('app_authentication_recovery_codes'),
                        'has_email_authentication' => $has('has_email_authentication'),
                    ],
                ],
                'relations' => array_map(fn ($r) => ['name' => $r['name'], 'type' => $r['type'], 'related' => $r['related']], relations(new $class())),
            ];
        }
    } catch (Throwable) {
    }
    return ['palettes' => $palettes, 'plugins' => $plugins, 'appName' => config('app.name'), 'user' => $user];
}

/**
 * Who can open a custom page or see a widget: the roles and permissions, as for a policy, and with Filament Shield,
 * the permission Shield gives the page or widget.
 */
function entryAccess(string $class, string $root): array
{
    $out = policyInfo($class, $root);
    $out['shieldKey'] = null;
    if ($out['shield']) {
        try {
            $shield = BezhanSalleh\FilamentShield\Facades\FilamentShield::class;
            $entry = is_subclass_of($class, 'Filament\\Widgets\\Widget') ? ($shield::getWidgets()[$class] ?? null) : ($shield::getPages()[$class] ?? null);
            $out['shieldKey'] = $entry ? array_key_first($entry['permissions']) : null;
        } catch (Throwable) {
        }
    }
    return $out;
}

/**
 * The app's importers and exporters with their models, and what imports and exports need: Filament's tables, the
 * job batches and notifications tables, and a queue (anything but `sync` needs a worker).
 */
function porters(string $root): array
{
    $out = ['importers' => [], 'exporters' => [], 'tables' => [], 'queue' => config('queue.default')];
    foreach (classesIn($root . '/app') as $class) {
        try {
            $kind = is_subclass_of($class, 'Filament\\Actions\\Imports\\Importer') ? 'importers' : (is_subclass_of($class, 'Filament\\Actions\\Exports\\Exporter') ? 'exporters' : null);
            if ($kind && !(new ReflectionClass($class))->isAbstract()) {
                $out[$kind][] = ['class' => $class, 'file' => relativeFile($class, $root), 'model' => $class::getModel()];
            }
        } catch (Throwable) {
        }
    }
    foreach (['imports', 'exports', 'failed_import_rows', 'job_batches', 'notifications'] as $table) {
        try {
            $out['tables'][$table] = Illuminate\Support\Facades\Schema::hasTable($table);
        } catch (Throwable) {
            $out['tables'][$table] = null;
        }
    }
    return $out;
}

/** The app's notifications: each class, its file, the record its constructor takes (if any), and its channels. */
function appNotifications(string $root): array
{
    $out = [];
    foreach (classesIn($root . '/app') as $class) {
        try {
            $r = new ReflectionClass($class);
            if (!$r->isSubclassOf('Illuminate\\Notifications\\Notification') || $r->isAbstract()) {
                continue;
            }
            $param = $r->getConstructor()?->getParameters()[0] ?? null;
            $type = $param?->getType();
            $record = $type instanceof ReflectionNamedType && !$type->isBuiltin() ? $type->getName() : null;
            // via() takes the notifiable; most return a fixed list, so ask with a blank user and accept failure.
            $channels = null;
            try {
                $user = config('auth.providers.users.model');
                $instance = $r->newInstanceWithoutConstructor();
                $channels = array_values((array) $instance->via($user ? new $user() : new stdClass()));
            } catch (Throwable) {
            }
            $out[] = ['class' => $class, 'file' => relativeFile($class, $root), 'record' => $record, 'channels' => $channels];
        } catch (Throwable) {
        }
    }
    return $out;
}

/**
 * What the environment settings show beside `.env`: the config values the booted app uses (by config key), each
 * mailer's transport, the queue connections' drivers, the disks, cache stores, and session drivers, whether the
 * tables the database queue, session, and cache drivers need exist, and whether the config is cached.
 */
function envSettings(array $keys): array
{
    $values = [];
    foreach ($keys as $key) {
        $values[$key] = config($key);
    }
    $table = function (?string $name) {
        try {
            return $name ? Illuminate\Support\Facades\Schema::hasTable($name) : null;
        } catch (Throwable) {
            return null;
        }
    };
    $jobs = config('queue.connections.database.table', 'jobs');
    $sessions = config('session.table', 'sessions');
    $cache = config('cache.stores.database.table', 'cache');
    return [
        'values' => $values,
        'mailers' => array_map(fn ($m) => $m['transport'] ?? null, (array) config('mail.mailers', [])),
        'queues' => array_map(fn ($c) => $c['driver'] ?? null, (array) config('queue.connections', [])),
        'disks' => array_map(fn ($d) => $d['driver'] ?? null, (array) config('filesystems.disks', [])),
        'stores' => array_map(fn ($s) => $s['driver'] ?? null, (array) config('cache.stores', [])),
        'tables' => ['jobs' => [$jobs, $table($jobs)], 'sessions' => [$sessions, $table($sessions)], 'cache' => [$cache, $table($cache)]],
        'configCached' => app()->configurationIsCached(),
    ];
}

/**
 * What a model's Automations view needs: the observers the app registers for it (by `#[ObservedBy]` or `observe()`
 * elsewhere), closures listening to its events, the notifications that queue, the user model, the roles, and the queue.
 */
function modelObservers(string $class, string $root): array
{
    if (!is_a($class, Model::class, true)) {
        throw new InvalidArgumentException("Not a model: $class");
    }
    new $class(); // Boots the model, which registers its #[ObservedBy] observers.
    $byAttribute = [];
    foreach ((new ReflectionClass($class))->getAttributes('Illuminate\\Database\\Eloquent\\Attributes\\ObservedBy') as $attribute) {
        foreach ((array) ($attribute->getArguments()[0] ?? []) as $observer) {
            $byAttribute[] = ltrim($observer, '\\');
        }
    }
    $observers = [];
    $closures = [];
    foreach (app('events')->getRawListeners() as $event => $listeners) {
        if (!preg_match('/^eloquent\.(\w+): (.+)$/', $event, $m) || $m[2] !== $class) {
            continue;
        }
        foreach ($listeners as $listener) {
            if (is_string($listener) && str_contains($listener, '@')) {
                $observer = ltrim(explode('@', $listener)[0], '\\');
                $observers[$observer] ??= ['class' => $observer, 'file' => relativeFile($observer, $root), 'attribute' => in_array($observer, $byAttribute, true)];
            } elseif ($listener instanceof Closure) {
                $r = new ReflectionFunction($listener);
                $closures[] = ['event' => $m[1], 'file' => $r->getFileName() ? ltrim(str_replace($root, '', $r->getFileName()), '/') : null, 'line' => $r->getStartLine()];
            }
        }
    }
    $queued = [];
    foreach (classesIn($root . '/app') as $notification) {
        try {
            if (is_subclass_of($notification, 'Illuminate\\Notifications\\Notification') && is_subclass_of($notification, 'Illuminate\\Contracts\\Queue\\ShouldQueue')) {
                $queued[] = $notification;
            }
        } catch (Throwable) {
        }
    }
    $roles = null;
    if (class_exists('Spatie\\Permission\\Models\\Role')) {
        try {
            $roles = Spatie\Permission\Models\Role::query()->pluck('name')->all();
        } catch (Throwable) {
            $roles = [];
        }
    }
    return [
        'observers' => array_values($observers),
        'closures' => $closures,
        'queued' => $queued,
        'user' => config('auth.providers.users.model'),
        'roles' => $roles,
        'queue' => config('queue.default'),
        // Laravel 10.44 added the attribute; older apps register observers with observe() in a provider.
        'attribute' => class_exists('Illuminate\\Database\\Eloquent\\Attributes\\ObservedBy'),
    ];
}

/** What the schedule designer offers: the app's queued jobs, its prunable models, the schedule's time zone, and the user model. */
function scheduleInfo(string $root): array
{
    $jobs = [];
    $prunable = [];
    foreach (classesIn($root . '/app') as $class) {
        try {
            $r = new ReflectionClass($class);
            if ($r->isAbstract()) {
                continue;
            }
            $traits = class_uses_recursive($class);
            if ($r->implementsInterface('Illuminate\\Contracts\\Queue\\ShouldQueue') && in_array('Illuminate\\Foundation\\Bus\\Dispatchable', $traits, true)) {
                $jobs[] = ['class' => $class, 'file' => relativeFile($class, $root), 'needsArgs' => ($r->getConstructor()?->getNumberOfRequiredParameters() ?? 0) > 0];
            }
            if ($r->isSubclassOf(Model::class)) {
                $trait = in_array('Illuminate\\Database\\Eloquent\\MassPrunable', $traits, true) ? 'MassPrunable' : (in_array('Illuminate\\Database\\Eloquent\\Prunable', $traits, true) ? 'Prunable' : null);
                if ($trait) {
                    $prunable[] = ['class' => $class, 'file' => relativeFile($class, $root), 'trait' => $trait];
                }
            }
        } catch (Throwable) {
        }
    }
    return [
        'timezone' => config('app.schedule_timezone') ?? config('app.timezone') ?? 'UTC',
        'user' => config('auth.providers.users.model'),
        'jobs' => $jobs,
        'prunable' => $prunable,
    ];
}

/**
 * What sending notifications needs: the notifications table, a mailer that delivers (not `log` or `array`), the
 * queue for queued ones, the user model, and which panels show the bell (`->databaseNotifications()`). Also the
 * app's name, which emails sign with.
 */
function notificationSetup(): array
{
    $table = null;
    try {
        $table = Illuminate\Support\Facades\Schema::hasTable('notifications');
    } catch (Throwable) {
    }
    $panels = [];
    try {
        foreach (Filament\Facades\Filament::getPanels() as $panel) {
            $panels[$panel->getId()] = $panel->hasDatabaseNotifications();
        }
    } catch (Throwable) {
    }
    return ['app' => config('app.name'), 'table' => $table, 'mailer' => config('mail.default'), 'queue' => config('queue.default'), 'user' => config('auth.providers.users.model'), 'panels' => $panels];
}

/**
 * spatie/laravel-activitylog for the model designer's History: its major version, whether its migration is published
 * and its table exists, and the latest entries for a model's records.
 */
function activityLog(string $class, string $root): array
{
    $version = trait_exists('Spatie\\Activitylog\\Models\\Concerns\\LogsActivity') ? 5 : (trait_exists('Spatie\\Activitylog\\Traits\\LogsActivity') ? 4 : null);
    $out = ['version' => $version, 'published' => (bool) glob($root . '/database/migrations/*_create_activity_log_table.php'), 'table' => null, 'entries' => []];
    if (!$version) {
        return $out;
    }
    try {
        $activity = config('activitylog.activity_model') ?: 'Spatie\\Activitylog\\Models\\Activity';
        $model = new $activity();
        $out['table'] = $model->getConnection()->getSchemaBuilder()->hasTable($model->getTable());
        if ($out['table'] && is_a($class, Model::class, true)) {
            $latest = $activity::query()->where('subject_type', (new $class())->getMorphClass())->with('causer')->latest('id')->limit(10)->get();
            foreach ($latest as $a) {
                $changes = $version === 5 ? $a->attribute_changes : $a->properties;
                $out['entries'][] = [
                    'subject' => $a->subject_id,
                    'event' => $a->event,
                    'description' => $a->description,
                    'causer' => $a->causer ? (string) ($a->causer->name ?? $a->causer->getKey()) : null,
                    'at' => $a->created_at?->toIso8601String(),
                    'attributes' => $changes?->get('attributes'),
                    'old' => $changes?->get('old'),
                ];
            }
        }
    } catch (Throwable $e) {
        $out['error'] = $e->getMessage();
    }
    return $out;
}

try {
    $result = match ($mode) {
        'resource' => describeResource($argv[3], $argv[4] ?? null),
        // Cases with their values; a pure enum's cases have no value.
        'enum' => enum_exists($argv[3])
            ? array_map(fn ($case) => ['name' => $case->name, 'value' => $case instanceof BackedEnum ? $case->value : null], $argv[3]::cases())
            : throw new InvalidArgumentException("Not an enum: {$argv[3]}"),
        'resources' => (function () use ($root) {
            $map = [];
            foreach (resourceClasses($root) as $resource) {
                try {
                    $map[$resource::getModel()][] = ['class' => $resource] + location(new ReflectionClass($resource));
                } catch (Throwable) {
                }
            }
            return $map;
        })(),
        'builder' => builderMethods(),
        'filament-catalog' => filamentCatalog($root),
        'filament-app' => filamentApp($root),
        'enums' => appEnums($root),
        'migrations' => migrationStatus($root),
        'model' => modelDetails($argv[3], $root),
        'policy' => policyInfo($argv[3], $root, $argv[4] ?? null),
        'entry-access' => entryAccess($argv[3], $root),
        'porters' => porters($root),
        'notifications' => appNotifications($root),
        'env-settings' => envSettings(array_slice($argv, 3)),
        'observers' => modelObservers($argv[3], $root),

        'schedule' => scheduleInfo($root),

        'notification-setup' => notificationSetup(),
        'activity' => activityLog($argv[3], $root),
        'translations' => appTranslations($root),
        'panel-options' => panelOptions($root),
        'widgets' => panelWidgets($root, $argv[3]),
        'navigation' => panelNavigation($root, $argv[3]),
        'widget-data' => widgetData($argv[3]),
        'permission' => changePermission($argv[3], $argv[4], $argv[5] ?? null),
        'mago-stubs' => magoStubs($root, $argv[3]),
        'views' => viewNames($root),
        // Root aliases such as `DB` for Illuminate\Support\Facades\DB: Laravel's defaults, config/app.php's, and packages'.
        'aliases' => $booted ? Illuminate\Foundation\AliasLoader::getInstance()->getAliases() : Illuminate\Support\Facades\Facade::defaultAliases()->all(),
        'models' => (function () use ($root) {
            $models = [];
            foreach (classesIn($root . '/app') as $class) {
                try {
                    if (is_a($class, Model::class, true) && !(new ReflectionClass($class))->isAbstract()) {
                        $model = new $class();
                        $models[$class] = ['class' => $class, 'table' => $model->getTable(), 'keyType' => $model->getKeyType(), 'uniqueIds' => method_exists($model, 'uniqueIds') ? $model->uniqueIds() : [], 'ulid' => in_array('Illuminate\\Database\\Eloquent\\Concerns\\HasUlids', class_uses_recursive($model), true), 'columns' => columnDetails($model), 'casts' => $model->getCasts(), 'relations' => array_map(fn ($r) => ['name' => $r['name'], 'type' => $r['type'], 'related' => $r['related']], relations($model)), 'accessors' => accessors($model), 'scopes' => scopes($model)];
                    }
                } catch (Throwable) {
                }
            }
            return $models;
        })(),
        default => throw new InvalidArgumentException("Unknown mode: $mode"),
    };
} catch (Throwable $e) {
    $result = ['error' => $e->getMessage()];
}

echo json_encode($result, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
