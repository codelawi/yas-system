<?php

namespace App\Models;

use App\Support\OfflineContext;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * Issue voucher (سند صرف عهدة): equipment handed to one recipient together.
 * A draft is filled by scanning; issuing numbers it and makes a custody for every unit.
 */
class Voucher extends Model
{
    public const DRAFT = 'draft';

    public const ISSUED = 'issued';

    /** Every unit came back. */
    public const RETURNED = 'returned';

    protected $fillable = ['number', 'status', 'recipient', 'fields', 'replaces_id', 'template_id', 'layout', 'revision', 'created_by', 'issued_by', 'issued_at', 'returned_at'];

    /** Lists do not need the layout; the voucher's own screen asks for it (printLayout). */
    protected $hidden = ['layout'];

    protected $casts = ['number' => 'integer', 'fields' => 'array', 'layout' => 'array', 'revision' => 'integer', 'issued_at' => 'datetime', 'returned_at' => 'datetime'];

    public function items(): HasMany
    {
        return $this->hasMany(VoucherItem::class)->orderBy('id');
    }

    public function custodies(): HasMany
    {
        return $this->hasMany(Custody::class);
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    public function issuer(): BelongsTo
    {
        return $this->belongsTo(User::class, 'issued_by');
    }

    /** The issued voucher this draft corrects. */
    public function replaces(): BelongsTo
    {
        return $this->belongsTo(self::class, 'replaces_id');
    }

    /** The template chosen for this voucher (none = the default one). */
    public function template(): BelongsTo
    {
        return $this->belongsTo(VoucherTemplate::class, 'template_id');
    }

    public function prints(): HasMany
    {
        return $this->hasMany(VoucherPrint::class);
    }

    /** How it prints: as it was when issued, or (a draft) with its template as it is now. */
    public function printLayout(): array
    {
        return $this->layout ?? VoucherTemplate::current($this->template_id)->layout();
    }

    public function isDraft(): bool
    {
        return $this->status === self::DRAFT;
    }

    /** The number the next issued voucher gets: after the last one, and not below the chosen start. */
    public static function nextNumber(): int
    {
        return max((int) Setting::get('voucher_next_number'), (int) static::max('number') + 1, 1);
    }

    /**
     * After units were added, removed or returned: "returned" once nothing is held any more,
     * "issued" again when something is. Other open screens reload (revision).
     */
    public function syncStatus(): void
    {
        if (! $this->isDraft()) {
            $held = $this->items()->whereHas('custody', fn ($q) => $q->whereNull('returned_at'))->exists();
            $done = ! $held && $this->items()->exists();
            $this->status = $done ? self::RETURNED : self::ISSUED;
            // Brought back on a phone without a connection: when it really was
            $this->returned_at = $done ? ($this->returned_at ?? OfflineContext::at() ?? now()) : null;
        }
        $this->revision++;
        $this->save();
    }
}
