<?php

namespace App\Settings;

use App\Enums\PostStatus;
use Carbon\CarbonImmutable;
use Spatie\LaravelSettings\Settings;

class GeneralSettings extends Settings
{
    public string $site_name;

    public float $tax_rate;

    public bool $open;

    public ?PostStatus $default_status;

    public ?CarbonImmutable $launch_at;

    public array $tags;

    public static function group(): string
    {
        return 'general';
    }
}
