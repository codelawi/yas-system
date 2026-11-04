<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class IssueReport extends Model
{
    protected $fillable = ['equipment_id', 'description', 'reporter', 'photo_path', 'status', 'resolution', 'closed_by', 'closed_at', 'ip'];

    protected $casts = ['closed_at' => 'datetime'];

    protected $hidden = ['photo_path', 'ip'];

    protected $appends = ['has_photo'];

    public function getHasPhotoAttribute(): bool
    {
        return (bool) $this->photo_path;
    }

    public function equipment(): BelongsTo
    {
        return $this->belongsTo(Equipment::class);
    }

    public function closedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'closed_by');
    }
}
