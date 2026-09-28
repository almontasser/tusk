<?php

namespace App\Filament\Widgets;

use App\Models\Order;
use Filament\Widgets\ChartWidget;

class OrdersChartWidget extends ChartWidget
{
    protected ?string $heading = 'Orders';

    protected function getData(): array
    {
        return [
            'datasets' => [
                [
                    'label' => 'Orders',
                    'data' => collect(range(11, 0))->map(fn (int $i) => Order::query()->whereBetween('created_at', [now()->subMonths($i)->startOfMonth(), now()->subMonths($i)->endOfMonth()])->count())->all(),
                    'borderColor' => '#22c55e',
                ],
            ],
            'labels' => collect(range(11, 0))->map(fn (int $i) => now()->subMonths($i)->format('M Y'))->all(),
        ];
    }

    protected function getType(): string
    {
        return 'line';
    }
}
