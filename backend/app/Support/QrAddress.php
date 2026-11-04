<?php

namespace App\Support;

use App\Models\Setting;
use Illuminate\Validation\ValidationException;

/**
 * The address printed inside QR codes. Once labels are printed with it, it must
 * not change by accident: every printed label would stop opening the system.
 */
class QrAddress
{
    public static function current(): string
    {
        return (string) Setting::get('base_url');
    }

    /** ok | not_set | localhost | mismatch */
    public static function status(?string $url = null): string
    {
        $url ??= self::current();
        if ($url === '') {
            return 'not_set';
        }
        $host = (string) parse_url($url, PHP_URL_HOST);
        if (in_array(strtolower($host), ['localhost', '127.0.0.1'], true)) {
            return 'localhost';
        }

        return ServerNetwork::hostResolvesHere($host) ? 'ok' : 'mismatch';
    }

    /** @return array<string, int> QR address => number of labels printed with it */
    public static function printed(): array
    {
        $printed = json_decode((string) Setting::get('labels_printed'), true);

        return is_array($printed) ? $printed : [];
    }

    public static function recordPrinted(string $url, int $count): void
    {
        $printed = self::printed();
        $url = rtrim($url, '/');
        $printed[$url] = ($printed[$url] ?? 0) + $count;
        Setting::updateOrCreate(['key' => 'labels_printed'], ['value' => json_encode($printed, JSON_UNESCAPED_SLASHES)]);
    }

    /**
     * Changing the address after labels were printed with it needs the new
     * address typed again as confirmation.
     */
    public static function guardChange(string $newUrl, ?string $confirmation): void
    {
        $current = self::current();
        $newUrl = rtrim($newUrl, '/');
        if ($current === '' || $newUrl === $current) {
            return;
        }
        $count = self::printed()[$current] ?? 0;
        if ($count > 0 && rtrim((string) $confirmation, '/') !== $newUrl) {
            throw ValidationException::withMessages(['base_url' => 'qr_address_locked:'.$count]);
        }
    }
}
