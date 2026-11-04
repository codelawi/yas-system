<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class MaintenanceRecord extends Model
{
    protected $fillable = ['equipment_id', 'schedule_id', 'title', 'done_at', 'notes', 'cost', 'user_id'];

    protected $casts = ['done_at' => 'date:Y-m-d', 'cost' => 'decimal:2'];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
