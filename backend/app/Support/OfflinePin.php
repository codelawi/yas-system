<?php

namespace App\Support;

/**
 * The hash a phone checks a PIN against when it cannot reach the server: PBKDF2-SHA256, which
 * browsers compute natively (Web Crypto), unlike the bcrypt hash the server keeps.
 * Format: `pbkdf2_sha256$<iterations>$<salt, base64>$<hash, base64>`; the phone reads the same
 * format (frontend/src/offlineData.js).
 *
 * PINs are short, so this only keeps the PIN from being read at a glance: someone who copies the
 * phone's data can still try every PIN.
 */
class OfflinePin
{
    private const ITERATIONS = 20000;

    private const PREFIX = 'pbkdf2_sha256';

    public static function make(string $pin): string
    {
        $salt = random_bytes(16);

        return implode('$', [self::PREFIX, self::ITERATIONS, base64_encode($salt), base64_encode(self::derive($pin, $salt, self::ITERATIONS))]);
    }

    public static function matches(string $pin, ?string $hash): bool
    {
        $parts = explode('$', (string) $hash);
        if (count($parts) !== 4 || $parts[0] !== self::PREFIX || (int) $parts[1] < 1) {
            return false;
        }
        $salt = base64_decode($parts[2], true);
        $expected = base64_decode($parts[3], true);
        if ($salt === false || $expected === false) {
            return false;
        }

        return hash_equals($expected, self::derive($pin, $salt, (int) $parts[1]));
    }

    private static function derive(string $pin, string $salt, int $iterations): string
    {
        return hash_pbkdf2('sha256', $pin, $salt, $iterations, 32, true);
    }
}
