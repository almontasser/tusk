<?php

// The icon sets blade-icons knows: each set's prefix, its SVG folders, and what makes a missing icon render
// anyway (a fallback icon, or a disk that may not be local).

$sets = [];

if (class_exists(BladeUI\Icons\Factory::class)) {
    $globalFallback = (string) config('blade-icons.fallback', '');

    foreach (app(BladeUI\Icons\Factory::class)->all() as $name => $set) {
        $sets[] = [
            'name'     => $name,
            'prefix'   => (string) ($set['prefix'] ?? ''),
            'paths'    => array_values(array_map('strval', (array) ($set['paths'] ?? []))),
            'disk'     => ! empty($set['disk']),
            'fallback' => ($set['fallback'] ?? '') !== '' || $globalFallback !== '',
        ];
    }
}

echo json_encode(['sets' => $sets]);
