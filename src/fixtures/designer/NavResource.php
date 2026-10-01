<?php

namespace App\Filament\Resources\Orders;

use App\Enums\NavGroup;
use App\Filament\Clusters\Shop\ShopCluster;
use BackedEnum;
use Filament\Resources\Resource;
use Filament\Support\Icons\Heroicon;
use UnitEnum;

class OrderResource extends Resource
{
    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedShoppingBag;

    protected static ?int $navigationSort = 3;

    protected static ?string $cluster = ShopCluster::class;

    protected static ?string $navigationParentItem = 'Customers';

    protected static string|UnitEnum|null $navigationGroup = NavGroup::Shop;

    public static function getNavigationLabel(): string
    {
        return __('Orders');
    }

    public static function shouldRegisterNavigation(): bool
    {
        return auth()->user()?->isAdmin() ?? false;
    }
}
