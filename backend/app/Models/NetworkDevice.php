<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\Cache;

class NetworkDevice extends Model
{
    public $timestamps = false;

    protected $fillable = ['ip', 'name', 'user_agent', 'last_user_id', 'hits', 'blocked', 'first_seen_at', 'last_seen_at'];

    protected $casts = [
        'blocked' => 'boolean',
        'first_seen_at' => 'datetime',
        'last_seen_at' => 'datetime',
    ];

    public function lastUser(): BelongsTo
    {
        return $this->belongsTo(User::class, 'last_user_id');
    }

    public static function isBlocked(string $ip): bool
    {
        return Cache::remember(self::cacheKey($ip), 30, fn () => (bool) static::where('ip', $ip)->value('blocked'));
    }

    public static function forgetCache(string $ip): void
    {
        Cache::forget(self::cacheKey($ip));
    }

    private static function cacheKey(string $ip): string
    {
        return 'device-blocked:'.$ip;
    }
}
