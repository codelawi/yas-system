<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Custody extends Model
{
    protected $fillable = ['equipment_id', 'holder', 'holder_phone', 'holder_id_number', 'holder_department', 'notes', 'handed_at', 'due_back_at', 'returned_at', 'return_notes', 'handed_by', 'received_by'];

    protected $casts = ['handed_at' => 'datetime', 'due_back_at' => 'date:Y-m-d', 'returned_at' => 'datetime'];

    public function equipment(): BelongsTo
    {
        return $this->belongsTo(Equipment::class);
    }

    public function handedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'handed_by');
    }

    public function receivedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'received_by');
    }

    public function scopeOpen(Builder $query): Builder
    {
        return $query->whereNull('returned_at');
    }
}
