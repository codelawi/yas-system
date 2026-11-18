<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** A document whose table fills itself with scanned QR / Data Matrix codes. */
class ScanDocument extends Model
{
    /** Columns every document starts with. `no` (ت) and `scanned_at` are filled by the system. */
    public const BUILT_IN_COLUMNS = ['no', 'code', 'scanned_at', 'notes'];

    protected $fillable = ['title', 'columns', 'created_by', 'updated_by'];

    protected $casts = ['columns' => 'array'];

    /** @return list<array{key: string, label: string}> */
    public static function defaultColumns(): array
    {
        return [
            ['key' => 'no', 'label' => 'ت'],
            ['key' => 'code', 'label' => 'النص الممسوح'],
            ['key' => 'scanned_at', 'label' => 'وقت المسح'],
            ['key' => 'notes', 'label' => 'ملاحظات'],
        ];
    }

    /** Keys of the columns whose cells are typed by hand (stored in a row's `cells`). */
    public function cellKeys(): array
    {
        return collect($this->columns)
            ->pluck('key')
            ->reject(fn (string $key) => in_array($key, ['no', 'code', 'scanned_at'], true))
            ->values()
            ->all();
    }

    public function rows(): HasMany
    {
        return $this->hasMany(ScanDocumentRow::class)->orderBy('position')->orderBy('id');
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }
}
