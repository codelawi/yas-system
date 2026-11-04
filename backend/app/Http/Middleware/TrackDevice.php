<?php

namespace App\Http\Middleware;

use App\Models\NetworkDevice;
use App\Support\ServerNetwork;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Symfony\Component\HttpFoundation\Response;

/** Records which devices use the system and refuses blocked ones. */
class TrackDevice
{
    /** Seconds between two "last seen" updates for the same device. */
    private const UPDATE_EVERY = 60;

    public function handle(Request $request, Closure $next): Response
    {
        $ip = ServerNetwork::clientIp($request);

        if (NetworkDevice::isBlocked($ip) && ! ServerNetwork::isServerAddress($ip)) {
            abort(403, 'device_blocked');
        }

        $response = $next($request);

        if ($ip !== '' && Cache::add('device-seen:'.$ip, true, self::UPDATE_EVERY)) {
            $device = NetworkDevice::firstOrNew(['ip' => $ip]);
            $device->first_seen_at ??= now();
            $device->fill([
                'user_agent' => mb_substr((string) $request->userAgent(), 0, 1000),
                'last_user_id' => $request->user('sanctum')?->id ?? $device->last_user_id,
                'hits' => $device->hits + 1,
                'last_seen_at' => now(),
            ])->save();
        }

        return $response;
    }
}
