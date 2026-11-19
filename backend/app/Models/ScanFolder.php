<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasManyThrough;

/** A folder of scan documents. Deleting it deletes its documents and their rows. */
class ScanFolder extends Model
{
    protected $fillable = ['name', 'created_by', 'updated_by'];

    protected $casts = ['revision' => 'integer'];

    public function documents(): HasMany
    {
        return $this->hasMany(ScanDocument::class);
    }

    /** Every row of every document in the folder. */
    public function rows(): HasManyThrough
    {
        return $this->hasManyThrough(ScanDocumentRow::class, ScanDocument::class);
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }
}
