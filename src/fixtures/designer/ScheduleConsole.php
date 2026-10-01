<?php

use App\Jobs\Heartbeat;
use App\Models\User;
use App\Notifications\WeeklyReport;
use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Notification;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

Schedule::command('reports:send --weekly')->weeklyOn(1, '8:00')->timezone('Europe/Berlin')->withoutOverlapping();

Schedule::job(new Heartbeat, 'heartbeats')
    ->everyFiveMinutes()
    ->onOneServer();

Schedule::call(function () {
    Notification::send(User::all(), new WeeklyReport());
})->name('Send WeeklyReport')->weekdays()->at('17:00');

Schedule::command('model:prune');

Schedule::exec('node /home/forge/script.js')->daily()->when(fn () => true);
