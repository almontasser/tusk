<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Prunable;

class Order extends Model
{
    use Prunable;

    public function prunable(): Builder
    {
        return static::where('status', 'cancelled')
            ->where('created_at', '<=', now()->subDays(90));
    }
}
