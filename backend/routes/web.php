<?php

use Illuminate\Support\Facades\Route;

// The service worker that lets phones open scanned labels without a connection.
// Served from the root so it can answer every page, never cached so updates reach phones.
Route::get('/sw.js', function () {
    $worker = public_path('app/sw.js');
    abort_unless(file_exists($worker), 404);

    return response()->file($worker, ['Content-Type' => 'text/javascript; charset=utf-8', 'Cache-Control' => 'no-cache']);
});

// Serve the built React dashboard for every non-API URL (e.g. /eq/SN-123 from a QR code).
Route::get('/{any?}', function () {
    $index = public_path('app/index.html');
    abort_unless(file_exists($index), 503, 'Frontend not built. Run "npm run build" in the frontend folder.');

    return response()->file($index, ['Cache-Control' => 'no-cache']);
})->where('any', '^(?!api/|app/|storage/|up$).*$');
