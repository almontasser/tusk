<?php

// The colors Filament knows by name, with each one's shade 500 as Filament writes it: its defaults, those
// registered with `FilamentColor::register()`, and each panel's `->colors()`. `unsure` says a panel's colors
// couldn't be read, so a name missing here may still exist.

$colors = [];
$unsure = false;

$shade = fn ($color) => match (true) {
    is_array($color)  => is_string($color[500] ?? null) ? $color[500] : null,
    is_string($color) => $color,
    default           => null,
};

if (class_exists(Filament\Facades\Filament::class)) {
    foreach (Filament\Facades\Filament::getPanels() as $panel) {
        try {
            foreach ($panel->getColors() as $name => $color) {
                $colors[$name] = $shade($color);
            }
        } catch (Throwable $e) {
            $unsure = true;
        }
    }
}

if (class_exists(Filament\Support\Facades\FilamentColor::class)) {
    try {
        foreach (Filament\Support\Facades\FilamentColor::getColors() as $name => $color) {
            $colors[$name] ??= $shade($color);
        }
    } catch (Throwable $e) {
        $unsure = true;
    }
}

echo json_encode(['colors' => (object) $colors, 'unsure' => $unsure]);
