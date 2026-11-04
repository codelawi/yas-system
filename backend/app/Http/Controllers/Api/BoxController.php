<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\Box;
use App\Models\Equipment;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

/**
 * Boxes (صناديق): a numbered box with its own QR label (/box/<number>) that holds a group of equipment.
 * Viewing is open to everyone; changes need a PIN. An equipment can be in several boxes,
 * and a main equipment always brings its accessories with it.
 */
class BoxController extends Controller
{
    public function index(Request $request)
    {
        $q = trim((string) $request->query('q', ''));

        return Box::withCount('equipment')
            ->when($q !== '', function ($query) use ($q) {
                $like = '%'.str_replace(['%', '_'], ['\%', '\_'], $q).'%';
                $query->where(fn ($w) => $w->where('number', 'like', $like)->orWhere('name', 'like', $like));
            })
            ->get()
            // Natural order: 2 before 10
            ->sortBy('number', SORT_NATURAL)
            ->values()
            ->map(fn (Box $box) => [
                'id' => $box->id,
                'number' => $box->number,
                'name' => $box->name,
                'weight' => $box->weight,
                'equipment_count' => $box->equipment_count,
                'updated_at' => $box->updated_at,
            ]);
    }

    public function show(Box $box)
    {
        return $this->detail($box);
    }

    /** Opened by phones scanning the box label. */
    public function byNumber(string $number)
    {
        return $this->detail(Box::where('number', $number)->firstOrFail());
    }

    public function store(Request $request)
    {
        $data = $this->validated($request);
        $box = Box::create([...$data, 'created_by' => $request->user()->id, 'updated_by' => $request->user()->id]);

        return $this->detail($box);
    }

    public function update(Request $request, Box $box)
    {
        $data = $this->validated($request, $box);
        $box->update([...$data, 'updated_by' => $request->user()->id]);

        return $this->detail($box);
    }

    /** Deletes the box only; its equipment stays. */
    public function destroy(Box $box)
    {
        DB::transaction(function () use ($box) {
            foreach ($box->equipment as $equipment) {
                ActivityLog::record($equipment, 'box_removed', ['summary' => $this->boxLabel($box)]);
            }
            $box->delete();
        });

        return response()->noContent();
    }

    /** Puts equipment in the box; main equipment bring their accessories. */
    public function attach(Request $request, Box $box)
    {
        $data = $request->validate([
            'ids' => ['required', 'array', 'max:1000'],
            'ids.*' => ['integer'],
        ]);

        $added = DB::transaction(function () use ($box, $data) {
            $already = $box->equipment()->pluck('equipment.id')->all();
            $added = $this->withAccessories(Equipment::whereIn('id', $data['ids'])->get())
                ->reject(fn (Equipment $e) => in_array($e->id, $already));

            $box->equipment()->attach($added->pluck('id')->all());
            foreach ($added as $equipment) {
                ActivityLog::record($equipment, 'box_added', ['summary' => $this->boxLabel($box)]);
            }
            $box->touch();

            return $added->count();
        });

        return ['added' => $added, 'box' => $this->detail($box)];
    }

    /** Takes one equipment out of the box (a main equipment takes its accessories with it). */
    public function detach(Box $box, Equipment $equipment)
    {
        DB::transaction(function () use ($box, $equipment) {
            $inBox = $box->equipment()->pluck('equipment.id')->all();
            $removed = $this->withAccessories(new Collection([$equipment]))
                ->filter(fn (Equipment $e) => in_array($e->id, $inBox));

            $box->equipment()->detach($removed->pluck('id')->all());
            foreach ($removed as $item) {
                ActivityLog::record($item, 'box_removed', ['summary' => $this->boxLabel($box)]);
            }
            $box->touch();
        });

        return $this->detail($box);
    }

    /** Boxes chosen for label printing, with the names of what is inside. */
    public function labels(Request $request)
    {
        $ids = array_filter(array_map('intval', (array) $request->query('ids', [])));

        return Box::with('equipment.fields')
            ->whereIn('id', $ids)
            ->get()
            ->sortBy('number', SORT_NATURAL)
            ->values()
            ->map(fn (Box $box) => [
                'id' => $box->id,
                'number' => $box->number,
                'name' => $box->name,
                'weight' => $box->weight,
                'items' => $this->sortedEquipment($box)
                    ->map(fn (Equipment $e) => EquipmentController::displayName($e) ?: $e->serial_number)
                    ->values(),
            ]);
    }

    /** @param  Collection<int, Equipment>  $equipment */
    private function withAccessories(Collection $equipment): Collection
    {
        $mainIds = $equipment->whereNull('parent_id')->pluck('id');
        $accessories = $mainIds->isEmpty() ? new Collection : Equipment::whereIn('parent_id', $mainIds)->get();

        return $equipment->concat($accessories)->unique('id')->values();
    }

    /** Main equipment first, each followed by its accessories. */
    private function sortedEquipment(Box $box): Collection
    {
        return $box->equipment->sortBy(fn (Equipment $e) => [$e->parent_id ?? $e->id, $e->parent_id === null ? 0 : 1, $e->serial_number])->values();
    }

    private function boxLabel(Box $box): string
    {
        return trim('📦 '.$box->number.($box->name ? ' · '.$box->name : ''));
    }

    private function detail(Box $box): array
    {
        $box->load(['equipment.fields', 'equipment.parent:id,serial_number,name']);

        return [
            'id' => $box->id,
            'number' => $box->number,
            'name' => $box->name,
            'weight' => $box->weight,
            'created_at' => $box->created_at,
            'updated_at' => $box->updated_at,
            'equipment' => $this->sortedEquipment($box)->map(fn (Equipment $e) => [
                'id' => $e->id,
                'serial_number' => $e->serial_number,
                'display_name' => EquipmentController::displayName($e),
                'category' => $e->category,
                'parent' => $e->parent?->only(['id', 'serial_number', 'name']),
                'photo_url' => $e->photoUrl(),
            ])->all(),
        ];
    }

    /** @return array{number: string, name: ?string, weight: ?float} */
    private function validated(Request $request, ?Box $box = null): array
    {
        $request->merge(['number' => trim((string) $request->input('number'))]);

        return $request->validate([
            'number' => ['required', 'string', 'max:50', 'not_regex:#[/\\\\?]#', Rule::unique('boxes', 'number')->ignore($box?->id)],
            'name' => ['nullable', 'string', 'max:191'],
            'weight' => ['nullable', 'numeric', 'min:0', 'max:99999999'],
        ], ['number.unique' => 'box_number_taken', 'number.not_regex' => 'box_number_invalid']);
    }
}
