<?php

namespace App\Filament\Pages;

use App\Enums\PostStatus;
use App\Settings\GeneralSettings;
use BackedEnum;
use Filament\Forms\Components\DateTimePicker;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Pages\SettingsPage;
use Filament\Schemas\Schema;
use Filament\Support\Icons\Heroicon;

class ManageGeneral extends SettingsPage
{
    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedCog6Tooth;

    protected static string $settings = GeneralSettings::class;

    public function form(Schema $schema): Schema
    {
        return $schema
            ->components([
                TextInput::make('site_name')
                    ->required(),
                TextInput::make('tax_rate')
                    ->numeric()
                    ->required(),
                Toggle::make('open')
                    ->required(),
                Select::make('default_status')
                    ->options(PostStatus::class),
                DateTimePicker::make('launch_at'),
                TextInput::make('tags')
                    ->required(),
            ]);
    }
}
