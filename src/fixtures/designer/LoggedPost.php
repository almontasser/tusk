<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Spatie\Activitylog\LogOptions;
use Spatie\Activitylog\Traits\LogsActivity;

class LoggedPost extends Model
{
    use HasFactory, LogsActivity;

    protected $fillable = ['title', 'slug', 'body'];

    public function getActivitylogOptions(): LogOptions
    {
        return LogOptions::defaults()
            ->logOnly(['title', 'body'])
            ->logOnlyDirty()
            ->useLogName('posts')
            ->setDescriptionForEvent(fn (string $eventName) => "Post {$eventName}")
            ->dontLogIfAttributesChangedOnly(['updated_at']);
    }
}
