<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\Equipment;
use App\Models\EquipmentGroup;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Groups (مجموعات): a kind of equipment, e.g. «وحدة الفتح والقص», holding every unit of that kind.
 * Each unit keeps its own serial number and details. Only main equipment is grouped; accessories stay under it.
 */
class EquipmentGroupController extends Controller
{
    public function index(Request $request)
    {
        $q = trim((string) $request->query('q', ''));

        return EquipmentGroup::withCount('equipment')
            ->when($q !== '', fn ($query) => $query->where('name', 'like', '%'.str_replace(['%', '_'], ['\%', '\_'], $q).'%'))
            ->orderBy('name')
            ->get(['id', 'name', 'updated_at']);
    }

    public function show(EquipmentGroup $group)
    {
        $items = $group->equipment()->with('fields')->withCount('accessories')->orderBy('row_no')->orderBy('serial_number')->get();

        return [
            'id' => $group->id,
            'name' => $group->name,
            'equipment' => $items->map(fn (Equipment $e) => [
                'id' => $e->id,
                'serial_number' => $e->serial_number,
                'display_name' => EquipmentController::displayName($e),
                'row_no' => $e->row_no,
                'category' => $e->category,
                'accessories_count' => $e->accessories_count,
                'photo_url' => $e->photoUrl(),
            ])->all(),
        ];
    }

    public function store(Request $request)
    {
        $name = $this->validatedName($request);
        $group = EquipmentGroup::create(['name' => $name, 'created_by' => $request->user()->id]);

        return $this->show($group);
    }

    public function update(Request $request, EquipmentGroup $group)
    {
        $group->update(['name' => $this->validatedName($request, $group)]);

        return $this->show($group);
    }

    /** Deletes the group only; its equipment stays, without a group. */
    public function destroy(EquipmentGroup $group)
    {
        DB::transaction(function () use ($group) {
            foreach ($group->equipment as $equipment) {
                ActivityLog::record($equipment, 'group_changed', ['summary' => '✕ '.$group->name]);
            }
            $group->equipment()->update(['group_id' => null]);
            $group->delete();
        });

        return response()->noContent();
    }

    /** Puts equipment in a group (`group_id`), or takes it out of its group (`group_id` = null). */
    public function assign(Request $request)
    {
        $data = $request->validate([
            'ids' => ['required', 'array', 'max:2000'],
            'ids.*' => ['integer'],
            'group_id' => ['nullable', 'integer', 'exists:equipment_groups,id'],
        ]);
        $group = isset($data['group_id']) ? EquipmentGroup::find($data['group_id']) : null;

        $changed = DB::transaction(function () use ($data, $group) {
            // Accessories always stay with their main equipment
            $items = Equipment::with('group:id,name')->whereIn('id', $data['ids'])->whereNull('parent_id')
                ->get()
                ->filter(fn (Equipment $e) => $e->group_id !== $group?->id);

            foreach ($items as $equipment) {
                $summary = $group ? '→ '.$group->name : '✕ '.$equipment->group?->name;
                $equipment->update(['group_id' => $group?->id]);
                ActivityLog::record($equipment, 'group_changed', ['summary' => $summary]);
            }

            return $items->count();
        });

        return ['changed' => $changed];
    }

    /**
     * Suggested groups: main equipment without a group that share a name.
     * A name that already has a group is suggested for its single items too.
     *
     * @return array<int, array{key: string, name: string, count: int, group_id: ?int, serials: array<int, string>}>
     */
    public function suggest()
    {
        $groups = EquipmentGroup::pluck('id', 'name_key');

        return $this->ungroupedByName()
            ->filter(fn (Collection $items, string $key) => $items->count() >= 2 || $groups->has($key))
            ->map(fn (Collection $items, string $key) => [
                'key' => $key,
                // The way most of them write it
                'name' => $items->map(fn (Equipment $e) => trim((string) EquipmentController::displayName($e)))->countBy()->sortDesc()->keys()->first(),
                'count' => $items->count(),
                'group_id' => $groups[$key] ?? null,
                'serials' => $items->pluck('serial_number')->take(5)->values()->all(),
            ])
            ->sortByDesc('count')
            ->values()
            ->all();
    }

    /** Makes the chosen suggested groups (or adds to the existing ones). */
    public function apply(Request $request)
    {
        $data = $request->validate([
            'groups' => ['required', 'array', 'max:1000'],
            'groups.*.key' => ['required', 'string', 'max:191'],
            'groups.*.name' => ['required', 'string', 'max:191'],
        ]);
        $userId = $request->user()->id;

        return DB::transaction(function () use ($data, $userId) {
            $byName = $this->ungroupedByName();
            $created = 0;
            $grouped = 0;

            foreach ($data['groups'] as $choice) {
                $items = $byName->get($choice['key']);
                if (! $items) {
                    continue;
                }
                $group = EquipmentGroup::where('name_key', $choice['key'])->first();
                if (! $group) {
                    $group = EquipmentGroup::create(['name' => trim($choice['name']), 'created_by' => $userId]);
                    $created++;
                }
                foreach ($items as $equipment) {
                    $equipment->update(['group_id' => $group->id]);
                    ActivityLog::record($equipment, 'group_changed', ['summary' => '→ '.$group->name], $userId);
                    $grouped++;
                }
            }

            return ['created' => $created, 'grouped' => $grouped];
        });
    }

    /** @return Collection<string, Collection<int, Equipment>> main equipment without a group, by normalized name */
    private function ungroupedByName(): Collection
    {
        return Equipment::with('fields')
            ->whereNull('parent_id')
            ->whereNull('group_id')
            ->orderBy('row_no')
            ->orderBy('serial_number')
            ->get()
            ->groupBy(fn (Equipment $e) => EquipmentGroup::keyFor(EquipmentController::displayName($e)))
            ->forget('');
    }

    private function validatedName(Request $request, ?EquipmentGroup $group = null): string
    {
        $name = trim((string) $request->validate(['name' => ['required', 'string', 'max:191']])['name']);
        $taken = EquipmentGroup::where('name_key', EquipmentGroup::keyFor($name))->when($group, fn ($q) => $q->whereKeyNot($group->id))->exists();
        if ($taken || EquipmentGroup::keyFor($name) === '') {
            throw ValidationException::withMessages(['name' => $taken ? 'group_name_taken' : 'group_name_invalid']);
        }

        return $name;
    }
}
