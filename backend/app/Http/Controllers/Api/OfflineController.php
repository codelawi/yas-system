<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Box;
use App\Models\Equipment;
use App\Models\Setting;
use Illuminate\Database\Eloquent\Collection;

/**
 * Everything a phone needs to open equipment and box pages without a connection, in one
 * download (the phone's service worker answers the scan pages from it). Only what anyone
 * can already see without a PIN: no change history and no custody holders.
 */
class OfflineController extends Controller
{
    /** The same limits as the equipment page's own lists. */
    private const MAINTENANCE_RECORDS = 50;

    private const ISSUES = 30;

    public function snapshot(): array
    {
        $equipment = Equipment::with([
            ...EquipmentController::DETAIL_RELATIONS,
            'schedules',
            'maintenanceRecords.user:id,name',
            'issues.closedBy:id,name',
        ])->orderBy('id')->get();
        $boxes = Box::with(BoxController::DETAIL_RELATIONS)->orderBy('id')->get();

        $maintenance = [];
        $issues = [];
        foreach ($equipment as $e) {
            if ($e->schedules->isNotEmpty() || $e->maintenanceRecords->isNotEmpty()) {
                $maintenance[$e->id] = ['schedules' => $e->schedules, 'records' => $e->maintenanceRecords->take(self::MAINTENANCE_RECORDS)->values()];
            }
            if ($e->issues->isNotEmpty()) {
                $issues[$e->id] = $e->issues->take(self::ISSUES)->values();
            }
        }

        return [
            'generated_at' => now()->toIso8601String(),
            'settings' => Setting::allValues(),
            'equipment' => $equipment->map(fn (Equipment $e) => EquipmentController::present($e))->all(),
            'serials' => (object) $this->serialIndex($equipment),
            'boxes' => $boxes->map(fn (Box $b) => BoxController::present($b))->all(),
            'maintenance' => (object) $maintenance,
            'issues' => (object) $issues,
        ];
    }

    /**
     * The equipment each serial number opens, as Equipment::forSerial picks it: a main
     * equipment before an accessory with the same serial, then the oldest.
     *
     * @param  Collection<int, Equipment>  $equipment  ordered by id
     * @return array<string, int>
     */
    private function serialIndex(Collection $equipment): array
    {
        $index = [];
        foreach ($equipment->sortBy(fn (Equipment $e) => $e->isAccessory() ? 1 : 0) as $e) {
            if ((string) $e->serial_number !== '') {
                $index[$e->serial_number] ??= $e->id;
            }
        }

        return $index;
    }
}
