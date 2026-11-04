<?php

namespace App\Providers;

use App\Services\BackupManager;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        // On the company computer, commands that empty the database are refused
        DB::prohibitDestructiveCommands($this->app->isProduction());

        // Automatic daily backup, done after a web response is sent (no scheduled task needed)
        if (! $this->app->runningInConsole() && ! $this->app->runningUnitTests()) {
            $this->app->terminating(fn () => $this->app->make(BackupManager::class)->runIfDue());
        }
    }
}
