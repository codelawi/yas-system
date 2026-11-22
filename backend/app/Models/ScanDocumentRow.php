<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\Relation;
use Illuminate\Support\Facades\Storage;

class ScanDocumentRow extends Model
{
    /** Where photos of lines read by the camera's text mode are kept (included in backups). */
    public const PHOTO_FOLDER = 'scan_photos';

    protected $fillable = ['scan_document_id', 'position', 'code', 'cells', 'photo_path', 'scanned_at', 'scanned_by'];

    protected $casts = ['cells' => 'array', 'scanned_at' => 'datetime'];

    protected $hidden = ['photo_path'];

    protected $appends = ['photo_url'];

    public function document(): BelongsTo
    {
        return $this->belongsTo(ScanDocument::class, 'scan_document_id');
    }

    public function scannedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'scanned_by');
    }

    /** The photo of the line read (text mode), or null. The URL changes with the photo, so it can be cached. */
    public function getPhotoUrlAttribute(): ?string
    {
        return $this->photo_path
            ? '/api/scan-documents/'.$this->scan_document_id.'/rows/'.$this->id.'/photo?v='.substr(md5($this->photo_path), 0, 8)
            : null;
    }

    /**
     * Deletes the photo files of these rows (before the rows go: the database removes a document's
     * or folder's rows by itself, without deleting files).
     *
     * @param  Builder<ScanDocumentRow>|Relation<ScanDocumentRow, *, *>  $rows
     */
    public static function deletePhotoFiles(Builder|Relation $rows): void
    {
        $paths = $rows->whereNotNull('photo_path')->pluck('photo_path')->all();
        if ($paths) {
            Storage::delete($paths);
        }
    }
}
