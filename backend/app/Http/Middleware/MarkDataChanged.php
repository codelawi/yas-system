<?php

namespace App\Http\Middleware;

use App\Support\DataRevision;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Something was written on the system: the copies phones downloaded before are now out of date (App\Support\DataRevision). */
class MarkDataChanged
{
    /** Writes that change nothing a phone's copy holds. */
    private const IGNORED = [
        'api/auth/*',
        'api/offline/*',
        'api/print-station/*',
        'api/backups',
        'api/backups/*',
        'api/stocktakes',
        'api/stocktakes/*',
        'api/imports/preview',
        'api/imports/check',
        'api/groups/voucher-codes/read',
        'api/network/devices/*',
    ];

    /**
     * @param  Closure(Request): (Response)  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);

        // A change a phone sends again when it syncs was counted the first time
        if (! $request->isMethodSafe() && $response->isSuccessful() && ! $response->headers->has('X-Offline-Replayed') && ! $request->is(...self::IGNORED)) {
            DataRevision::bump();
        }

        return $response;
    }
}
