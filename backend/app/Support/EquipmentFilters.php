<?php

namespace App\Support;

use Illuminate\Database\Eloquent\Builder;

/** Field filters ({key, value} pairs) used by the equipment list, exports and stocktakes. */
class EquipmentFilters
{
    /** Filter key that means the equipment category instead of a field. */
    public const CATEGORY_KEY = '__category__';

    /**
     * All filters must match. An empty value means "has this field".
     *
     * @param  array<int, array{key?: string, value?: string}>|mixed  $filters
     */
    public static function apply(Builder $query, mixed $filters): Builder
    {
        if (! is_array($filters)) {
            return $query;
        }

        foreach (array_slice($filters, 0, 20) as $filter) {
            $key = isset($filter['key']) ? (string) $filter['key'] : '';
            $value = isset($filter['value']) ? (string) $filter['value'] : '';
            if ($key === '') {
                continue;
            }

            if ($key === self::CATEGORY_KEY) {
                if ($value === '__none__') {
                    $query->whereNull('category');
                } elseif ($value !== '') {
                    $query->where('category', $value);
                } else {
                    $query->whereNotNull('category');
                }

                continue;
            }

            $query->whereHas('fields', fn ($f) => $f
                ->where('key', $key)
                ->when($value !== '', fn ($f) => $f->where('value', $value)));
        }

        return $query;
    }
}
