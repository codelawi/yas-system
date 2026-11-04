<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class MaintenanceSchedule extends Model
{
    protected $fillable = ['equipment_id', 'title', 'due_date', 'interval_months', 'notes'];

    protected $casts = ['due_date' => 'date:Y-m-d', 'interval_months' => 'integer'];

    public function equipment(): BelongsTo
    {
        return $this->belongsTo(Equipment::class);
    }
}
