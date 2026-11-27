<?php

namespace App\Support;

use App\Models\Setting;
use Illuminate\Support\Str;

/**
 * A value that changes whenever something is written on the system (App\Http\Middleware\MarkDataChanged).
 * A phone keeps the value its copy was made with and asks for it while connected: a different value
 * means its copy is out of date.
 */
class DataRevision
{
    private const KEY = 'data_revision';

    public static function current(): string
    {
        $value = Setting::find(self::KEY)?->value;

        return $value === null || $value === '' ? self::bump() : $value;
    }

    public static function bump(): string
    {
        $value = Str::random(20);
        Setting::updateOrCreate(['key' => self::KEY], ['value' => $value]);

        return $value;
    }
}
