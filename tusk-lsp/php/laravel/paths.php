<?php

echo json_encode([
    ['key' => 'base_path', 'path' => base_path()],
    ['key' => 'resource_path', 'path' => resource_path()],
    ['key' => 'config_path', 'path' => config_path()],
    ['key' => 'app_path', 'path' => app_path()],
    ['key' => 'database_path', 'path' => database_path()],
    ['key' => 'lang_path', 'path' => lang_path()],
    ['key' => 'public_path', 'path' => public_path()],
    ['key' => 'storage_path', 'path' => storage_path()],
]);
