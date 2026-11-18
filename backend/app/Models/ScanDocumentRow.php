<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class ScanDocumentRow extends Model
{
    protected $fillable = ['scan_document_id', 'position', 'code', 'cells', 'scanned_at', 'scanned_by'];

    protected $casts = ['cells' => 'array', 'scanned_at' => 'datetime'];

    public function document(): BelongsTo
    {
        return $this->belongsTo(ScanDocument::class, 'scan_document_id');
    }

    public function scannedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'scanned_by');
    }
}
