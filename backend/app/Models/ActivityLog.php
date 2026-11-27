<?php

namespace App\Models;

use App\Support\OfflineContext;
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

    /** A change made on a phone without a connection keeps the time it was made, marked `offline`. */
    public static function record(Equipment $equipment, string $action, ?array $changes = null, ?int $userId = null): void
    {
        $offlineAt = OfflineContext::at();
        $log = new static([
            'user_id' => $userId ?? auth()->id(),
            'equipment_id' => $equipment->id,
            'serial_number' => $equipment->serial_number,
            'action' => $action,
            'changes' => $offlineAt ? ($changes ?? []) + ['offline' => true] : $changes,
        ]);
        if ($offlineAt) {
            $log->created_at = $offlineAt;
        }
        $log->save();
    }
}
