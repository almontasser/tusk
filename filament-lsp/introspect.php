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
 *
 * `resource` prints the resource, its pages and relation managers, and the model that
 * forms and tables in <context class> work with. For a relation manager, that's the
 * related model of its relationship. `resources` maps each model to its resources.
 * `models` describes every model under app/ for AI completion: columns with their
 * database types, casts, and relationships. `enum` lists an enum's cases with their values. `builder` lists the query builder methods models
 * forward static and instance calls to. `aliases` maps root class aliases, such as `DB`, to their classes.
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
