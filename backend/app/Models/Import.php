<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Import extends Model
{
    protected $fillable = [
        'original_name', 'stored_path', 'user_id',
        'created_count', 'updated_count', 'skipped_count', 'committed_at',
    ];

    protected $casts = ['committed_at' => 'datetime'];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
