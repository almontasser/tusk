<?php

namespace App\Filament\Widgets;

use App\Models\Order;
use Filament\Support\Icons\Heroicon;
use Filament\Widgets\StatsOverviewWidget;
use Filament\Widgets\StatsOverviewWidget\Stat;
use Illuminate\Support\Number;

class OrderStatsWidget extends StatsOverviewWidget
{
    protected function getStats(): array
    {
        return [
            Stat::make('Open orders', Order::query()->where('status', 'new')->count())
                ->description('Waiting for us')
                ->descriptionIcon(Heroicon::OutlinedClock)
                ->color('warning')
                ->chart(collect(range(6, 0))->map(fn (int $days) => Order::query()->where('status', 'new')->whereDate('created_at', now()->subDays($days))->count())->all()),
            Stat::make('Revenue', Number::currency(
                Order::query()
                    ->where('created_at', '>=', now()->subDays(30))
                    ->sum('total_price'),
                in: 'USD',
            )),
            Stat::make('Custom', $this->custom()),
        ];
    }
}
