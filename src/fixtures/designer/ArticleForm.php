<?php

namespace App\Filament\Resources\Articles\Schemas;

use App\Enums\ArticleStatus;
use Filament\Forms\Components\DatePicker;
use Filament\Forms\Components\FileUpload;
use Filament\Forms\Components\Hidden;
use Filament\Forms\Components\Repeater;
use Filament\Forms\Components\RichEditor;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Schemas\Components\Section;
use Filament\Schemas\Schema;

class ArticleForm
{
    public static function configure(Schema $schema): Schema
    {
        return $schema
            ->components([
                Section::make('Content')
                    ->schema([
                        TextInput::make('title')
                            ->required()
                            ->maxLength(255),
                        TextInput::make('slug')
                            ->required()
                            ->unique(ignoreRecord: true),
                        TextInput::make('contact')
                            ->email(),
                        TextInput::make('price')
                            ->numeric()
                            ->required(),
                        RichEditor::make('body'),
                    ]),
                Select::make('category_id')
                    ->relationship('category', 'name')
                    ->required(),
                Select::make('status')
                    ->options(ArticleStatus::class)
                    ->required(),
                Select::make('kind')
                    ->options(['news' => 'News', 'blog' => 'Blog']),
                Select::make('tags')
                    ->relationship('tags', 'name')
                    ->multiple(),
                Toggle::make('featured')
                    ->required(),
                DatePicker::make('published_on'),
                TextInput::make('secret')
                    ->required()
                    ->visibleOn('create'),
                FileUpload::make('cover')
                    ->required(),
                Hidden::make('token'),
                Repeater::make('links')
                    ->schema([
                        TextInput::make('url')->required(),
                    ]),
                Section::make('Author')
                    ->relationship('author')
                    ->schema([
                        TextInput::make('name')->required(),
                    ]),
            ]);
    }
}
