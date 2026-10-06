<?php

namespace App\Settings;

use Spatie\LaravelSettings\Settings;

class SharedSettings extends Settings
{
    public string $site_name, $tagline;

    public bool $active;

    public static function group(): string
    {
        return 'general';
    }
}
