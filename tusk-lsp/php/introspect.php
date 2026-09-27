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
 * The language server runs this in a separate process, so edited classes are always
 * loaded fresh.
 */

declare(strict_types=1);

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\Relation;

[, $root, $mode] = $argv + [null, null, null];
$root = realpath((string) $root) ?: exit(1);
chdir($root);
require $root . '/vendor/autoload.php';

// Boot the app so models can read their table columns from the database.
$booted = false;
try {
    $app = require $root . '/bootstrap/app.php';
    $app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
    $booted = true;
} catch (Throwable) {
    // Without a booted app, columns fall back to what the model declares.
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
                        $models[$class] = ['class' => $class, 'table' => $model->getTable(), 'columns' => columnDetails($model), 'casts' => $model->getCasts(), 'relations' => array_map(fn ($r) => ['name' => $r['name'], 'type' => $r['type'], 'related' => $r['related']], relations($model)), 'accessors' => accessors($model), 'scopes' => scopes($model)];
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
