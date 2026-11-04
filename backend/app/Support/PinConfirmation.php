<?php

namespace App\Support;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Validation\ValidationException;

/** Dangerous actions need the person's PIN again, even when they are already unlocked. */
class PinConfirmation
{
    /** @param string $askWith error sent when no PIN was given (the client then asks for it) */
    public static function check(Request $request, string $askWith = 'pin_required'): void
    {
        $pin = (string) $request->input('pin', '');
        if ($pin === '') {
            throw ValidationException::withMessages(['pin' => $askWith]);
        }

        $key = 'large-delete-pin:'.$request->user()->id;
        if (RateLimiter::tooManyAttempts($key, 5)) {
            throw ValidationException::withMessages(['pin' => 'too_many_attempts']);
        }
        if (! Hash::check($pin, $request->user()->pin)) {
            RateLimiter::hit($key, 60);
            throw ValidationException::withMessages(['pin' => 'wrong_pin']);
        }
        RateLimiter::clear($key);
    }
}
