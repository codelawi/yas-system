<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\Equipment;
use App\Models\EquipmentField;
use App\Models\Setting;
use App\Support\FieldDiff;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/** Bulk changes to the flexible fields: edit many equipment, rename / merge field names. */
class FieldController extends Controller
{
    /** Every field name with how many equipment use it. */
    public function usage()
    {
        return EquipmentField::query()
            ->join('equipment', 'equipment.id', '=', 'equipment_fields.equipment_id')
            ->whereNull('equipment.deleted_at')
            ->select('equipment_fields.key', DB::raw('count(distinct equipment_fields.equipment_id) as uses'))
            ->groupBy('equipment_fields.key')
            ->orderByDesc('uses')
            ->get();
    }

    /** Set or remove one field on many equipment, or set their category. */
    public function bulkUpdate(Request $request)
    {
        $data = $request->validate([
            'ids' => ['required', 'array', 'max:2000'],
            'ids.*' => ['integer'],
            'action' => ['required', 'in:set,remove,category'],
            'key' => ['required_unless:action,category', 'nullable', 'string', 'max:255'],
            'value' => ['nullable', 'string', 'max:10000'],
            'category' => ['nullable', 'string', 'max:191'],
        ]);
        $key = trim((string) ($data['key'] ?? ''));
        $userId = $request->user()->id;

        $updated = DB::transaction(function () use ($data, $key, $userId) {
            $count = 0;
            foreach (Equipment::with('fields')->whereIn('id', $data['ids'])->get() as $equipment) {
                $before = $equipment->fieldList();
                $extraBefore = $equipment->only(['category']);

                if ($data['action'] === 'category') {
                    $equipment->category = ($data['category'] ?? null) ?: null;
                } else {
                    $fields = array_values(array_filter($before, fn ($f) => $f['key'] !== $key));
                    if ($data['action'] === 'set') {
                        // Keep the field where it was, or add it at the end
                        $position = array_search($key, array_column($before, 'key'), true);
                        array_splice($fields, $position === false ? count($fields) : $position, 0, [['key' => $key, 'value' => $data['value'] ?? '']]);
                    }
                    $equipment->syncFields($fields);
                }

                $changes = FieldDiff::make($before, $equipment->fieldList(), $extraBefore, $equipment->only(['category']));
                if ($changes) {
                    $equipment->updated_by = $userId;
                    $equipment->save();
                    $equipment->touch();
                    ActivityLog::record($equipment, 'updated', $changes + ['bulk' => true], $userId);
                    $count++;
                }
            }

            return $count;
        });

        return ['updated' => $updated];
    }

    /**
     * Rename one or more field names to one name (merging them). When an equipment
     * has several of them, the first non-empty value wins; the target's own value comes first.
     */
    public function rename(Request $request)
    {
        $data = $request->validate([
            'from' => ['required', 'array', 'min:1', 'max:50'],
            'from.*' => ['string', 'max:255'],
            'to' => ['required', 'string', 'max:255'],
        ]);
        $to = trim($data['to']);
        $from = array_values(array_diff(array_unique(array_map('trim', $data['from'])), [$to]));
        $userId = $request->user()->id;

        $updated = DB::transaction(function () use ($from, $to, $userId) {
            $count = 0;
            $ids = EquipmentField::whereIn('key', $from)->distinct()->pluck('equipment_id');
            foreach (Equipment::with('fields')->whereIn('id', $ids)->get() as $equipment) {
                $before = $equipment->fieldList();
                $merged = [];
                $value = null;
                $position = null;
                foreach ($before as $i => $f) {
                    if ($f['key'] === $to || in_array($f['key'], $from, true)) {
                        $position ??= count($merged);
                        // The target's own value wins, then the first non-empty one
                        if ($f['key'] === $to && trim((string) $f['value']) !== '') {
                            $value = $f['value'];
                        } elseif ($value === null && trim((string) $f['value']) !== '') {
                            $value = $f['value'];
                        }

                        continue;
                    }
                    $merged[] = $f;
                }
                array_splice($merged, $position ?? count($merged), 0, [['key' => $to, 'value' => $value ?? '']]);
                $equipment->syncFields($merged);
                $changes = FieldDiff::make($before, $equipment->fieldList());
                ActivityLog::record($equipment, 'updated', ($changes ?? []) + ['summary' => implode('، ', $from).' → '.$to], $userId);
                $count++;
            }

            // Labels that show a renamed field keep working
            $template = json_decode((string) Setting::get('label_template'), true);
            if (is_array($template['elements'] ?? null)) {
                foreach ($template['elements'] as &$element) {
                    if (in_array(substr((string) ($element['source'] ?? ''), 6), $from, true) && str_starts_with((string) $element['source'], 'field:')) {
                        $element['source'] = 'field:'.$to;
                    }
                }
                unset($element);
                Setting::updateOrCreate(['key' => 'label_template'], ['value' => json_encode($template, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)]);
            }

            return $count;
        });

        return ['updated' => $updated];
    }
}
