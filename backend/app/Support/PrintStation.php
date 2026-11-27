<?php

namespace App\Support;

use App\Models\Setting;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;

/**
 * The print station: a page open on the laptop (Edge, started by START.bat with silent printing)
 * that prints issued vouchers on the default printer. It asks for work every second or two, which
 * also tells phones it is open. It has no PIN: it proves itself with a key only START.bat gives it.
 */
class PrintStation
{
    /** Seconds after its last call during which the station counts as open. */
    public const ONLINE_FOR = 8;

    private const SEEN = 'print_station_seen_at';

    private const WINDOW = 'print_station_window';

    /** The station's key, made the first time it is needed. */
    public static function key(): string
    {
        $key = (string) Setting::get('print_station_key');
        if ($key === '') {
            $key = Str::random(40);
            Setting::updateOrCreate(['key' => 'print_station_key'], ['value' => $key]);
        }

        return $key;
    }

    public static function checks(?string $key): bool
    {
        return is_string($key) && $key !== '' && hash_equals(self::key(), $key);
    }

    /** The address START.bat opens (on this PC, without Apache in between). */
    public static function url(string $base = 'http://127.0.0.1:8000'): string
    {
        return rtrim($base, '/').'/print-station?key='.self::key();
    }

    /**
     * A station window asks for work. Only one window prints: another one opened while it is still
     * asking (a second START.bat, a window left open) waits, and takes over once the first is closed.
     */
    public static function seen(string $window): bool
    {
        $current = Cache::get(self::WINDOW);
        if ($current !== null && $current !== $window && self::online()) {
            return false;
        }
        Cache::put(self::WINDOW, $window, 3600);
        Cache::put(self::SEEN, now()->timestamp, 3600);

        return true;
    }

    public static function online(): bool
    {
        $seen = Cache::get(self::SEEN);

        return $seen !== null && now()->timestamp - (int) $seen <= self::ONLINE_FOR;
    }

    /** @return array{online: bool, seen_at: ?int} */
    public static function state(): array
    {
        return ['online' => self::online(), 'seen_at' => Cache::get(self::SEEN)];
    }

    /**
     * Asks START.bat's window to open the station: it looks for this file every second. The server
     * itself cannot open a window on the laptop's screen reliably, START.bat runs as the user.
     */
    public static function requestOpen(): void
    {
        File::ensureDirectoryExists(dirname(self::openRequestFile()));
        File::put(self::openRequestFile(), (string) now()->timestamp);
    }

    public static function openRequestFile(): string
    {
        return storage_path('app/print-station/open');
    }
}
