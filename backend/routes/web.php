<?php

use Illuminate\Support\Facades\Route;

// Serve the built React dashboard for every non-API URL (e.g. /eq/SN-123 from a QR code).
Route::get('/{any?}', function () {
    $index = public_path('app/index.html');
    abort_unless(file_exists($index), 503, 'Frontend not built. Run "npm run build" in the frontend folder.');

    return response()->file($index, ['Cache-Control' => 'no-cache']);
})->where('any', '^(?!api/|app/|storage/|up$).*$');
