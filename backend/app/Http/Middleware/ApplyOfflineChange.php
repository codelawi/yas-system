<?php

namespace App\Http\Middleware;

use App\Models\OfflineChange;
use App\Models\User;
use App\Support\OfflineContext;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

/**
 * A change a phone made without a connection, sent when it syncs. The phone sends it to the same
 * API as any change, with:
 *  - X-Offline-Change: a key of its own. A change already saved gets the answer it got then, so a
 *    sync that is cut off can simply start again;
 *  - X-Offline-User: who made it. The phone checked that person's PIN; the person syncing confirms
 *    the whole sync with their own;
 *  - X-Offline-At: when it was made, which the history keeps.
 *
 * A phone with a copy sends a change to the server as it is made when it can, with the key it would
 * keep it under and X-Offline-Live: 1. That is an ordinary request (whoever is signed in, now, with
 * the usual PINs), only saved with its key: when its answer is too slow for the phone, the phone
 * keeps the change and syncs it later, and the server does not do it twice.
 *
 * Runs before route model binding, so a change whose record is gone since still gets its answer.
 */
class ApplyOfflineChange
{
    /** A phone works without a connection for hours: an older time is taken as wrong. */
    private const MAX_AGE_DAYS = 30;

    public function handle(Request $request, Closure $next): Response
    {
        $key = (string) $request->header('X-Offline-Change', '');
        $syncedBy = $request->user('sanctum');
        if ($key === '' || $request->isMethodSafe() || ! $syncedBy) {
            return $next($request);
        }
        abort_if(strlen($key) > 100, 422, 'bad_offline_change');

        $done = OfflineChange::where('key', $key)->first();
        if ($done) {
            return response($done->response ?? '', $done->status, ['Content-Type' => 'application/json', 'X-Offline-Replayed' => '1']);
        }

        if ($request->header('X-Offline-Live') === '1') {
            return $this->saved($request, $key, $syncedBy, now(), fn () => $next($request));
        }

        $actor = User::where('is_active', true)->find((int) $request->header('X-Offline-User')) ?? $syncedBy;
        Auth::guard('sanctum')->setUser($actor);
        $request->setUserResolver(fn () => $actor);
        $doneAt = $this->doneAt($request);

        return $this->saved($request, $key, $actor, $doneAt, fn () => OfflineContext::run($doneAt, fn () => $next($request)), $syncedBy);
    }

    /**
     * The change and its key are saved together, or neither is.
     *
     * @param  Closure(): Response  $work
     */
    private function saved(Request $request, string $key, User $actor, Carbon $doneAt, Closure $work, ?User $syncedBy = null): Response
    {
        DB::beginTransaction();
        try {
            $response = $work();
            if (! $response->isSuccessful()) {
                DB::rollBack();

                return $response;
            }
            OfflineChange::create([
                'key' => $key,
                'user_id' => $actor->id,
                'synced_by' => ($syncedBy ?? $actor)->id,
                'method' => $request->method(),
                'path' => mb_substr($request->path(), 0, 255),
                'status' => $response->getStatusCode(),
                'response' => $response->getContent() ?: null,
                'done_at' => $doneAt,
            ]);
            DB::commit();
        } catch (Throwable $e) {
            DB::rollBack();
            throw $e;
        }
        // Keys from more than a month ago are not sent again
        if (random_int(1, 50) === 1) {
            OfflineChange::where('created_at', '<', now()->subDays(self::MAX_AGE_DAYS))->delete();
        }

        return $response;
    }

    private function doneAt(Request $request): Carbon
    {
        try {
            $at = Carbon::parse((string) $request->header('X-Offline-At'));
        } catch (Throwable) {
            return now();
        }

        return $at->isFuture() || $at->lt(now()->subDays(self::MAX_AGE_DAYS)) ? now() : $at->utc();
    }
}
