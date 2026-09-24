<?php

/*
 * Describes a Laravel project's Filament resources and models as JSON.
 *
 *   php introspect.php <project root> resource <Resource class> [<context class>]
 *   php introspect.php <project root> resources
 *
 * `resource` prints the resource, its pages and relation managers, and the model that
 * forms and tables in <context class> work with. For a relation manager, that's the
 * related model of its relationship. `resources` maps each model to its resources.
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
    return ['class' => $class] + location(new ReflectionClass($class)) + ['columns' => columns($model), 'relations' => $relations];
}

/** Resource classes declared under app/Filament, found by file name. */
function resourceClasses(string $root): array
{
    $classes = [];
    $dir = $root . '/app/Filament';
    if (!is_dir($dir)) {
        return [];
    }
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir)) as $file) {
        if (!str_ends_with($file->getFilename(), 'Resource.php')) {
            continue;
        }
        $source = file_get_contents($file->getPathname());
        if (preg_match('/^namespace\s+([^;]+);/m', $source, $ns) && preg_match('/^\s*(?:final\s+|abstract\s+)*class\s+(\w+)/m', $source, $cls)) {
            $classes[] = $ns[1] . '\\' . $cls[1];
        }
    }
    return $classes;
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
        default => throw new InvalidArgumentException("Unknown mode: $mode"),
    };
} catch (Throwable $e) {
    $result = ['error' => $e->getMessage()];
}

echo json_encode($result, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
