<?php

namespace App\Providers;

use App\Services\BackupManager;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\RateLimiter;
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

        // Anyone can report a problem, a few times a minute. Reports made on a phone without a
        // connection all arrive at once when it syncs (sent by someone who entered a PIN)
        RateLimiter::for('issue-reports', fn (Request $request) => $request->hasHeader('X-Offline-Change') && $request->user('sanctum')
            ? Limit::none()
            : Limit::perMinute(10)->by($request->ip()));

        // Automatic daily backup, done after a web response is sent (no scheduled task needed)
        if (! $this->app->runningInConsole() && ! $this->app->runningUnitTests()) {
            $this->app->terminating(fn () => $this->app->make(BackupManager::class)->runIfDue());
        }
    }
}
