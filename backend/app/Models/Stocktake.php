<?php

namespace App\Models;

use App\Support\EquipmentFilters;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Stocktake extends Model
{
    protected $fillable = ['name', 'filters', 'include_accessories', 'status', 'started_by', 'closed_at'];

    protected $casts = ['filters' => 'array', 'include_accessories' => 'boolean', 'closed_at' => 'datetime'];

    public function scans(): HasMany
    {
        return $this->hasMany(StocktakeScan::class);
    }

    public function startedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'started_by');
    }

    /** The equipment this stocktake expects to find. */
    public function expectedQuery(): Builder
    {
        $query = EquipmentFilters::apply(Equipment::query(), $this->filters ?? []);
        if (! $this->include_accessories) {
            $query->whereNull('parent_id');
        }

        return $query;
    }
}
