<?php

use App\Http\Middleware\EnsureAdmin;
use App\Http\Middleware\TrackDevice;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->alias(['admin' => EnsureAdmin::class]);
        // API only: never redirect guests to a login page, just answer 401
        $middleware->redirectGuestsTo(fn () => null);
        $middleware->appendToGroup('api', TrackDevice::class);
        // The Vite dev server (and a local web server) forward the real device IP
        $middleware->trustProxies(at: ['127.0.0.1', '::1']);
        // Custody form designs keep their spaces (e.g. a prefix like «المكان: »)
        $middleware->trimStrings(except: ['layout.*']);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })->create();
