<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** A print of an issue voucher waiting for the print station on the laptop (or done, or cancelled there). */
class VoucherPrint extends Model
{
    public const PENDING = 'pending';

    public const PRINTED = 'printed';

    public const CANCELLED = 'cancelled';

    protected $fillable = ['voucher_id', 'copies', 'status', 'requested_by', 'finished_at'];

    protected $casts = ['copies' => 'integer', 'finished_at' => 'datetime'];

    public function voucher(): BelongsTo
    {
        return $this->belongsTo(Voucher::class);
    }

    /** @return array{id: int, copies: int, status: string, created_at: mixed, finished_at: mixed} */
    public function brief(): array
    {
        return $this->only(['id', 'copies', 'status', 'created_at', 'finished_at']);
    }
}
