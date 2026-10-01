<?php

use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Application;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        commands: __DIR__.'/../routes/console.php',
    )
    ->withSchedule(function (Schedule $schedule) {
        //
    })
    ->create();
