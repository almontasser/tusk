<?php

namespace App\Filament\Pages;

use Filament\Pages\Page;

class Reports extends Page
{
    protected static ?string $navigationGroup = 'Content';

    // Pinned under the content items.
    protected static ?int $navigationSort = config('nav.reports');

    public static function getNavigationGroup(): ?string
    {
        return __('Content');
    }
}
