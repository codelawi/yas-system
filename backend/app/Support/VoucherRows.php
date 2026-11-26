<?php

namespace App\Support;

use App\Http\Controllers\Api\EquipmentController;
use App\Models\Equipment;
use App\Models\EquipmentGroup;
use App\Models\VoucherItem;
use Illuminate\Support\Collection;

/**
 * The lines of an issue voucher: one per kind of equipment, in the order they were first scanned.
 * Main equipment counts by its group (printing the group's code and main name); accessories count
 * by their name under each kind of main equipment, with no code.
 */
class VoucherRows
{
    /**
     * @param  Collection<int, VoucherItem>  $items  with equipment (fields, group, parent with fields and group) and custody
     * @return array<int, array{key: string, code: ?string, name: string, accessory: bool, quantity: int, quantity_words: string, returned: int, serials: array<int, string>}>
     */
    public static function for(Collection $items): array
    {
        $rows = [];
        foreach ($items as $item) {
            $equipment = $item->equipment;
            if (! $equipment) {
                continue;
            }
            $key = self::key($equipment);
            $rows[$key] ??= [
                'key' => $key,
                'code' => $equipment->parent_id === null ? $equipment->group?->voucher_code : null,
                'name' => self::name($equipment),
                'accessory' => $equipment->parent_id !== null,
                'quantity' => 0,
                'quantity_words' => '',
                'returned' => 0,
                'serials' => [],
            ];
            $rows[$key]['quantity']++;
            $rows[$key]['serials'][] = $equipment->serial_number;
            if ($item->custody?->returned_at) {
                $rows[$key]['returned']++;
            }
        }

        foreach ($rows as &$row) {
            $row['quantity_words'] = ArabicNumber::words($row['quantity']).' فقط';
        }

        return array_values($rows);
    }

    /** Units with the same key share a line. */
    public static function key(Equipment $equipment): string
    {
        if ($equipment->parent_id === null) {
            return $equipment->group_id ? 'g:'.$equipment->group_id : 'n:'.EquipmentGroup::keyFor(self::name($equipment));
        }
        $parent = $equipment->parent;

        return 'a:'.($parent ? self::key($parent) : 'p:'.$equipment->parent_id).'|'.EquipmentGroup::keyFor(self::name($equipment));
    }

    /** The name a line prints: the group's main name, else the equipment's own name (or serial). */
    public static function name(Equipment $equipment): string
    {
        if ($equipment->parent_id === null && $equipment->group) {
            return $equipment->group->voucherName();
        }

        return trim((string) EquipmentController::displayName($equipment)) ?: (string) $equipment->serial_number;
    }
}
