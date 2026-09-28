<?php

namespace App\Filament\Resources;

use Filament\Actions\EditAction;
use Filament\Resources\Resource;
use Filament\Tables\Table;

class HelperResource extends Resource
{
    public static function table(Table $table): Table
    {
        return self::configureMessageTable($table)
            ->recordActions([
                EditAction::make(),
            ]);
    }

    public static function configureMessageTable(Table $table): Table
    {
        return $table->columns([]);
    }
}
