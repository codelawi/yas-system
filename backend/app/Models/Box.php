<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

/** A numbered box with its own QR label, holding a group of equipment. */
class Box extends Model
{
    protected $fillable = ['number', 'name', 'weight', 'created_by', 'updated_by'];

    protected $casts = ['weight' => 'float'];

    public function equipment(): BelongsToMany
    {
        return $this->belongsToMany(Equipment::class)->withTimestamps();
    }
}
