<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Support\Facades\Hash;
use Laravel\Sanctum\HasApiTokens;

#[Fillable(['name', 'pin', 'role', 'is_active'])]
#[Hidden(['pin'])]
class User extends Authenticatable
{
    use HasApiTokens, HasFactory;

    protected function casts(): array
    {
        return [
            'pin' => 'hashed',
            'is_active' => 'boolean',
        ];
    }

    public function isAdmin(): bool
    {
        return $this->role === 'admin';
    }

    /**
     * PINs are hashed, so we can't look them up directly. The number of
     * users is small, so checking each active user is fine.
     */
    public static function findByPin(string $pin, ?int $exceptId = null): ?self
    {
        return static::query()
            ->when($exceptId, fn ($q) => $q->where('id', '!=', $exceptId))
            ->get()
            ->first(fn (self $user) => Hash::check($pin, $user->pin));
    }
}
