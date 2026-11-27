<?php

namespace App\Support;

use Closure;
use Illuminate\Support\Carbon;

/**
 * A change a phone made without a connection, being saved now that the phone syncs
 * (App\Http\Middleware\ApplyOfflineChange): the history keeps when it was really made and marks
 * it, the PIN was already checked on the phone, and what it adds still needs a label.
 */
class OfflineContext
{
    private static ?Carbon $at = null;

    /**
     * @template T
     *
     * @param  Closure(): T  $work
     * @return T
     */
    public static function run(Carbon $at, Closure $work): mixed
    {
        $previous = self::$at;
        self::$at = $at;
        try {
            return $work();
        } finally {
            self::$at = $previous;
        }
    }

    public static function active(): bool
    {
        return self::$at !== null;
    }

    /** When the change being saved was made on the phone, or null for an ordinary request. */
    public static function at(): ?Carbon
    {
        return self::$at?->copy();
    }
}
