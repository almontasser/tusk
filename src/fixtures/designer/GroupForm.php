<?php

namespace App\Filament\Resources\Senders\Schemas;

use Filament\Schemas\Schema;

class GroupForm
{
    public static function configure(Schema $schema): Schema
    {
        return $schema
            ->components([
                \Filament\Schemas\Components\Group::make([
                    \Filament\Schemas\Components\Section::make('')->schema([
                        \Filament\Forms\Components\TextInput::make('sender'),
                    ]),
                ])->columnSpan(2),
            ]);
    }
}
