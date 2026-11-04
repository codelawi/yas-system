<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class ActivityLog extends Model
{
    public const UPDATED_AT = null;

    protected $fillable = ['user_id', 'equipment_id', 'serial_number', 'action', 'changes'];

    protected $casts = ['changes' => 'array'];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public static function record(Equipment $equipment, string $action, ?array $changes = null, ?int $userId = null): void
    {
        static::create([
            'user_id' => $userId ?? auth()->id(),
            'equipment_id' => $equipment->id,
            'serial_number' => $equipment->serial_number,
            'action' => $action,
            'changes' => $changes,
        ]);
    }
}
