<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** One scanned unit of an issue voucher; once issued it has its own custody. */
class VoucherItem extends Model
{
    protected $fillable = ['voucher_id', 'equipment_id', 'custody_id', 'added_by'];

    public function voucher(): BelongsTo
    {
        return $this->belongsTo(Voucher::class);
    }

    /** Deleted equipment still shows on the vouchers it was handed out with. */
    public function equipment(): BelongsTo
    {
        return $this->belongsTo(Equipment::class)->withTrashed();
    }

    public function custody(): BelongsTo
    {
        return $this->belongsTo(Custody::class);
    }
}
