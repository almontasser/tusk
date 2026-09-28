<?php

namespace App\Filament\Pages;

use Filament\Pages\Page;

class SettingsPage extends Page
{
    protected static ?string $title = 'Settings';

    public static function canAccess(): bool
    {
        return false;
    }
}
