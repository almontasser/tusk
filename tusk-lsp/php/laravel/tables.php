<?php

/*
 * The default connection's tables with their columns, for the `exists` and `unique` validation rules, and each
 * model's table. `live` says whether the tables come from the database. When it can't be read, each model's table
 * stands in, with the columns its fillable, casts, key, and timestamps name.
 */

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;

$tables = [];
$live = false;

try {
    $connection = DB::connection();
    $prefix = $connection->getTablePrefix();
    $schema = $connection->getSchemaBuilder();
    // Every schema's tables, not only the current one's: a rule may name a table on the search path.
    $names = method_exists($schema, 'getTables')
        ? array_column($schema->getTables(), 'name')
        : array_map(fn ($t) => array_values((array) $t)[0], $schema->getAllTables());
    foreach ($names as $name) {
        $name = $prefix !== '' && str_starts_with($name, $prefix) ? substr($name, strlen($prefix)) : $name;
        $tables[$name] = array_values($schema->getColumnListing($name));
    }
    $live = true;
} catch (Throwable $e) {
    $tables = [];
}

$models = [];
if (File::isDirectory(base_path('app/Models'))) {
    foreach (File::allFiles(base_path('app/Models')) as $file) {
        if ($file->getExtension() === 'php') {
            try {
                include_once $file->getPathname();
            } catch (Throwable $e) {
            }
        }
    }
}
foreach (get_declared_classes() as $class) {
    try {
        if (!is_subclass_of($class, Model::class) || (new ReflectionClass($class))->isAbstract() || !str_starts_with($class, 'App\\')) {
            continue;
        }
        $model = new $class();
        $table = $model->getTable();
        $models[$class] = $table;
        if (!$live && !isset($tables[$table])) {
            $columns = [$model->getKeyName(), ...$model->getFillable(), ...array_keys($model->getCasts())];
            if ($model->usesTimestamps()) {
                array_push($columns, $model->getCreatedAtColumn(), $model->getUpdatedAtColumn());
            }
            $tables[$table] = array_values(array_unique(array_filter($columns, 'is_string')));
        }
    } catch (Throwable $e) {
    }
}

echo json_encode(['live' => $live, 'tables' => (object) $tables, 'models' => (object) $models]);
