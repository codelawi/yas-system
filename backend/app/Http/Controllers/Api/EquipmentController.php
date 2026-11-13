<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\Custody;
use App\Models\Equipment;
use App\Models\EquipmentField;
use App\Models\EquipmentGroup;
use App\Models\Import;
use App\Models\IssueReport;
use App\Models\MaintenanceSchedule;
use App\Models\Setting;
use App\Services\WordTableParser;
use App\Support\EquipmentFilters;
use App\Support\FieldDiff;
use App\Support\PinConfirmation;
use App\Support\QrAddress;
use App\Support\XlsxWriter;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

class EquipmentController extends Controller
{
    /** Deleting more equipment than this at once asks for the PIN again. */
    private const LARGE_DELETE = 5;

    /** Field names (normalized) used as the equipment name when it has none, in order of preference. */
    private const NAME_KEYS = ['الاسم', 'اسم المعده', 'المعده', 'اسم', 'name', 'equipment', 'النوع', 'type'];

    public function index(Request $request)
    {
        $perPage = min(200, max(5, (int) $request->query('per_page', 20)));
        $query = $this->listQuery($request);

        return $query->paginate($perPage)->through(fn (Equipment $e) => [
            'id' => $e->id,
            'serial_number' => $e->serial_number,
            'name' => $e->name,
            'display_name' => $this->displayName($e),
            'row_no' => $e->row_no,
            'category' => $e->category,
            'parent' => $e->parent?->only(['id', 'serial_number', 'name']),
            'group' => $e->group?->only(['id', 'name']),
            'accessories_count' => $e->accessories_count,
            'fields' => $e->fieldList(),
            'updated_at' => $e->updated_at,
        ]);
    }

    /**
     * Groups with how many of their equipment match the list's search / filters,
     * for the grouped list (the equipment itself comes from index with `group_id`).
     */
    public function groupSummary(Request $request)
    {
        $matching = $this->listQuery($request)->reorder()->select('equipment.id');

        return EquipmentGroup::withCount(['equipment as count' => fn ($q) => $q->whereIn('equipment.id', $matching)])
            ->orderBy('name')
            ->get(['id', 'name'])
            ->filter(fn (EquipmentGroup $g) => $g->count > 0)
            ->values();
    }

    /** The equipment list with its search, filters and sorting (shared by the list and the Excel export). */
    private function listQuery(Request $request)
    {
        $q = trim((string) $request->query('q', ''));

        $query = Equipment::query()
            ->with(['fields', 'parent:id,serial_number,name', 'group:id,name'])
            ->withCount('accessories')
            ->when($q !== '', function ($query) use ($q) {
                $like = '%'.str_replace(['%', '_'], ['\%', '\_'], $q).'%';
                $query->where(fn ($w) => $w
                    ->where('serial_number', 'like', $like)
                    ->orWhere('name', 'like', $like)
                    ->orWhere('category', 'like', $like)
                    ->orWhereHas('group', fn ($g) => $g->where('name', 'like', $like))
                    ->orWhereHas('fields', fn ($f) => $f->where('value', 'like', $like)->orWhere('key', 'like', $like)));
            })
            ->when($request->filled('category'), fn ($query) => $request->query('category') === '__none__'
                ? $query->whereNull('category')
                : $query->where('category', $request->query('category')))
            ->when($request->filled('import_id'), fn ($query) => $query->where('import_id', $request->query('import_id')))
            ->when($request->filled('group_id'), fn ($query) => $query->where('group_id', $request->query('group_id')))
            // Grouped list: what is not in a group. Accessories of grouped equipment only show when searched for
            ->when($request->boolean('ungrouped'), fn ($query) => $query->whereNull('group_id')
                ->when($q === '', fn ($list) => $list->where(fn ($w) => $w->whereNull('parent_id')->orWhereHas('parent', fn ($p) => $p->whereNull('group_id')))))
            ->tap(fn ($query) => $this->applyFieldFilters($query, $request))
            ->when($request->query('type') === 'main', fn ($query) => $query->whereNull('parent_id'))
            ->when($request->query('type') === 'accessory', fn ($query) => $query->whereNotNull('parent_id'));

        $sort = $request->query('sort', 'updated_at');
        $dir = $request->query('dir') === 'asc' ? 'asc' : 'desc';
        $sort = in_array($sort, ['serial_number', 'row_no', 'category', 'created_at', 'updated_at']) ? $sort : 'updated_at';
        if ($sort === 'row_no') {
            // Equipment without a «ت» number goes last in both directions
            $query->orderByRaw('row_no is null');
        }

        return $query->orderBy($sort, $dir)->orderBy('id');
    }

    /** Excel file of the equipment list, with the same search / filters as the list. One column per field. */
    public function export(Request $request)
    {
        $items = $this->listQuery($request)->limit(20000)->get();

        // Field columns, most used first
        $keys = $items->flatMap(fn (Equipment $e) => $e->fields->pluck('key'))->countBy()->sortDesc()->keys()->all();
        $header = array_merge(['ت', 'الرقم التسلسلي', 'الاسم', 'المجموعة', 'التصنيف', 'تابع لـ (ملحق)', 'عدد الملحقات'], $keys, ['تاريخ الإضافة', 'آخر تحديث']);

        $rows = $items->map(function (Equipment $e) use ($keys) {
            $values = $e->fields->pluck('value', 'key');

            return array_merge(
                [$e->row_no, $e->serial_number, $this->displayName($e), $e->group?->name, $e->category, $e->parent?->serial_number, $e->accessories_count ?: null],
                array_map(fn ($k) => $values[$k] ?? null, $keys),
                [$e->created_at?->format('Y-m-d H:i'), $e->updated_at?->format('Y-m-d H:i')],
            );
        });

        $path = tempnam(sys_get_temp_dir(), 'xlsx');
        XlsxWriter::write($path, 'المعدات', $header, $rows);

        return response()->download($path, 'equipment-'.now()->format('Y-m-d').'.xlsx', [
            'Content-Type' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ])->deleteFileAfterSend();
    }

    public function show(Equipment $equipment)
    {
        return $this->detail($equipment);
    }

    public function bySerial(string $serial)
    {
        $equipment = Equipment::forSerial($serial)->firstOrFail();

        return $this->detail($equipment);
    }

    public function store(Request $request)
    {
        $data = $this->validated($request);

        $equipment = DB::transaction(function () use ($data, $request) {
            $parent = isset($data['parent_id']) ? Equipment::find($data['parent_id']) : null;
            $equipment = Equipment::create([
                'parent_id' => $parent?->id,
                'serial_number' => $data['serial_number'],
                'name' => $data['name'] ?? null,
                'row_no' => $data['row_no'] ?? null,
                'category' => ($data['category'] ?? null) ?: $parent?->category,
                // Accessories stay with their main equipment and are never grouped
                'group_id' => $parent ? null : ($data['group_id'] ?? null),
                'created_by' => $request->user()->id,
                'updated_by' => $request->user()->id,
            ]);
            $equipment->syncFields($data['fields'] ?? []);
            ActivityLog::record($equipment, 'created', ['added' => $equipment->fieldList()]);
            if ($equipment->group_id) {
                ActivityLog::record($equipment, 'group_changed', ['summary' => '→ '.$equipment->group->name]);
            } else {
                EquipmentGroup::joinByName($equipment);
            }
            if ($parent) {
                ActivityLog::record($parent, 'accessory_added', ['accessory' => $equipment->only(['id', 'serial_number', 'name'])]);
                // An accessory goes wherever its main equipment is
                $equipment->boxes()->attach($parent->boxes()->pluck('boxes.id')->all());
            }

            return $equipment;
        });

        return $this->detail($equipment);
    }

    public function update(Request $request, Equipment $equipment)
    {
        $data = $this->validated($request, $equipment);

        DB::transaction(function () use ($data, $request, $equipment) {
            $before = $equipment->fieldList();
            $extraBefore = $equipment->only(['serial_number', 'name', 'row_no', 'category']);

            // parent_id is fixed after creation and is never changed here
            $equipment->update([
                'serial_number' => $data['serial_number'],
                'name' => $data['name'] ?? null,
                'row_no' => array_key_exists('row_no', $data) ? $data['row_no'] : $equipment->row_no,
                'category' => array_key_exists('category', $data) ? $data['category'] : $equipment->category,
                'updated_by' => $request->user()->id,
            ]);
            if (array_key_exists('group_id', $data) && ! $equipment->parent_id && (int) $data['group_id'] !== (int) $equipment->group_id) {
                $old = $equipment->group?->name;
                $equipment->update(['group_id' => $data['group_id']]);
                $equipment->unsetRelation('group');
                ActivityLog::record($equipment, 'group_changed', ['summary' => $equipment->group ? '→ '.$equipment->group->name : '✕ '.$old]);
            }
            $equipment->syncFields($data['fields'] ?? []);

            $changes = FieldDiff::make($before, $equipment->fieldList(), $extraBefore, $equipment->only(['serial_number', 'name', 'row_no', 'category']));
            if ($changes) {
                ActivityLog::record($equipment, 'updated', $changes);
            }
        });

        return $this->detail($equipment->fresh());
    }

    public function destroy(Request $request, Equipment $equipment)
    {
        $this->confirmLargeDelete($request, 1 + $equipment->accessories()->count());
        DB::transaction(fn () => $this->deleteWithAccessories($equipment));

        return response()->noContent();
    }

    /** Deletes several equipment at once (each one with its accessories). */
    public function bulkDestroy(Request $request)
    {
        $data = $request->validate([
            'ids' => ['required', 'array', 'max:1000'],
            'ids.*' => ['integer'],
        ]);

        // Selected equipment + the accessories that would go with them
        $this->confirmLargeDelete($request, Equipment::whereIn('id', $data['ids'])->count()
            + Equipment::whereIn('parent_id', $data['ids'])->whereNotIn('id', $data['ids'])->count());

        $deleted = DB::transaction(function () use ($data) {
            $count = 0;
            foreach (Equipment::with(['accessories', 'parent'])->whereIn('id', $data['ids'])->get() as $equipment) {
                // An accessory may already be gone together with its main equipment in this batch
                if ($equipment->fresh()?->trashed() === false) {
                    $count += $this->deleteWithAccessories($equipment);
                }
            }

            return $count;
        });

        return ['deleted' => $deleted];
    }

    /**
     * Deleting more than LARGE_DELETE equipment needs the person's PIN again,
     * even when they are already unlocked.
     */
    private function confirmLargeDelete(Request $request, int $count): void
    {
        if ($count <= self::LARGE_DELETE) {
            return;
        }

        PinConfirmation::check($request, 'pin_required:'.$count);
    }

    /** @return int number of equipment deleted (the equipment and its accessories) */
    private function deleteWithAccessories(Equipment $equipment): int
    {
        $count = 0;
        foreach ($equipment->accessories as $accessory) {
            ActivityLog::record($accessory, 'deleted');
            $accessory->delete();
            $count++;
        }
        if ($equipment->parent) {
            ActivityLog::record($equipment->parent, 'accessory_removed', ['accessory' => $equipment->only(['id', 'serial_number', 'name'])]);
        }
        ActivityLog::record($equipment, 'deleted');
        $equipment->delete();

        return $count + 1;
    }

    /**
     * The equipment's name, or else the value of a name-like field (most items only have fields),
     * or else the name of its group.
     */
    public static function displayName(Equipment $equipment): ?string
    {
        if ($equipment->name) {
            return $equipment->name;
        }

        $fields = collect($equipment->fieldList())
            ->filter(fn (array $f) => trim((string) $f['value']) !== '')
            ->keyBy(fn (array $f) => WordTableParser::normalize($f['key']));
        foreach (self::NAME_KEYS as $key) {
            if ($fields->has($key)) {
                return strtok($fields[$key]['value'], "\n");
            }
        }

        return $equipment->group?->name;
    }

    /**
     * A few details to show under the equipment's name in short lists (e.g. a box's contents):
     * the first filled fields, without the name and the serial number.
     *
     * @return array<int, array{key: string, value: string}>
     */
    public static function summaryFields(Equipment $equipment, int $limit = 3): array
    {
        $name = trim((string) self::displayName($equipment));

        return collect($equipment->fieldList())
            ->map(fn (array $f) => ['key' => trim($f['key']), 'value' => trim((string) strtok((string) $f['value'], "\n"))])
            ->filter(fn (array $f) => $f['value'] !== ''
                && ! in_array(WordTableParser::normalize($f['key']), self::NAME_KEYS, true)
                && $f['value'] !== $name
                && $f['value'] !== $equipment->serial_number)
            ->take($limit)
            ->map(fn (array $f) => ['key' => $f['key'], 'value' => mb_strimwidth($f['value'], 0, 60, '…')])
            ->values()
            ->all();
    }

    /** Equipment chosen for label printing (may span several pages of the list). */
    public function labels(Request $request)
    {
        $ids = array_filter(array_map('intval', (array) $request->query('ids', [])));

        // An accessory without a serial has no QR link, so no label
        return Equipment::with(['parent:id,serial_number', 'fields', 'group:id,name'])
            ->whereIn('id', $ids)
            ->whereNotNull('serial_number')
            ->orderByRaw('coalesce(parent_id, id), parent_id is not null, serial_number')
            ->get()
            ->map(fn (Equipment $e) => [
                'id' => $e->id,
                'serial_number' => $e->serial_number,
                'name' => $e->name,
                'display_name' => $this->displayName($e),
                'row_no' => $e->row_no,
                'category' => $e->category,
                'parent_serial' => $e->parent?->serial_number,
                // Any Word field can be placed on the label by the designer
                'fields' => $e->fieldList(),
            ]);
    }

    public function categories()
    {
        return Equipment::whereNotNull('category')->distinct()->orderBy('category')->pluck('category');
    }

    public function keys()
    {
        return $this->activeFields()
            ->select('equipment_fields.key', DB::raw('count(*) as uses'))
            ->groupBy('equipment_fields.key')
            ->orderByDesc('uses')
            ->limit(500)
            ->pluck('key');
    }

    /** Distinct values stored for one field (or for the category), most used first. */
    public function values(Request $request)
    {
        $key = (string) $request->query('key', '');

        if ($key === EquipmentFilters::CATEGORY_KEY) {
            return Equipment::whereNotNull('category')
                ->select('category as value', DB::raw('count(*) as uses'))
                ->groupBy('category')
                ->orderByDesc('uses')
                ->get();
        }

        return $this->activeFields()
            ->where('equipment_fields.key', $key)
            ->whereNotNull('equipment_fields.value')
            ->where('equipment_fields.value', '!=', '')
            ->select('equipment_fields.value', DB::raw('count(*) as uses'))
            ->groupBy('equipment_fields.value')
            ->orderByDesc('uses')
            ->limit(300)
            ->get();
    }

    /** Fields of equipment that is not deleted. */
    private function activeFields()
    {
        return EquipmentField::query()
            ->join('equipment', 'equipment.id', '=', 'equipment_fields.equipment_id')
            ->whereNull('equipment.deleted_at');
    }

    /** `filters` is a JSON list of {key, value} (see EquipmentFilters). */
    private function applyFieldFilters($query, Request $request): void
    {
        EquipmentFilters::apply($query, json_decode((string) $request->query('filters', '[]'), true));
    }

    public function stats()
    {
        $withPin = auth('sanctum')->check();
        $printed = QrAddress::printed();

        return [
            'total' => Equipment::count(),
            'main' => Equipment::whereNull('parent_id')->count(),
            'accessories' => Equipment::whereNotNull('parent_id')->count(),
            'without_data' => Equipment::whereNull('parent_id')->doesntHave('fields')->count(),
            'categories' => Equipment::select('category', DB::raw('count(*) as total'))
                ->groupBy('category')->orderByDesc('total')->get(),
            'imports' => Import::whereNotNull('committed_at')->count(),
            'added_this_month' => Equipment::where('created_at', '>=', now()->startOfMonth())->count(),
            'labels_printed' => array_sum($printed),
            'health' => [
                'qr_address' => QrAddress::current(),
                'qr_status' => QrAddress::status(),
                'labels_printed_here' => $printed[QrAddress::current()] ?? 0,
                'last_backup_at' => Setting::get('last_backup_at') ?: null,
            ],
            'attention' => $this->needsAttention(),
            'maintenance' => [
                'overdue' => MaintenanceSchedule::whereHas('equipment')->where('due_date', '<', now()->toDateString())->count(),
                'soon' => MaintenanceSchedule::whereHas('equipment')->whereBetween('due_date', [now()->toDateString(), now()->addDays(7)->toDateString()])->count(),
                'items' => MaintenanceSchedule::with(Equipment::NAME_RELATIONS)->whereHas('equipment')->orderBy('due_date')->limit(6)->get()
                    ->each(fn (MaintenanceSchedule $schedule) => $schedule->equipment->withDisplayName()),
            ],
            'issues' => [
                'open' => IssueReport::whereHas('equipment')->where('status', 'open')->count(),
                'items' => IssueReport::with(Equipment::NAME_RELATIONS)->whereHas('equipment')->where('status', 'open')->latest('id')->limit(5)->get()
                    ->each(fn (IssueReport $issue) => $issue->equipment->withDisplayName()),
            ],
            'custody' => [
                'open' => Custody::open()->whereHas('equipment')->count(),
                'overdue' => Custody::open()->whereHas('equipment')->where('due_back_at', '<', now()->toDateString())->count(),
                // Names of people only with a PIN
                'items' => $withPin
                    ? Custody::open()->with(Equipment::NAME_RELATIONS)->whereHas('equipment')->whereNotNull('due_back_at')->orderBy('due_back_at')->limit(5)->get()
                        ->each(fn (Custody $custody) => $custody->equipment->withDisplayName())
                    : null,
            ],
            'recent_equipment' => Equipment::with(['fields', 'group:id,name'])->withCount('accessories')->whereNull('parent_id')->latest('created_at')->latest('id')->limit(6)->get()
                ->map(fn (Equipment $e) => [
                    'id' => $e->id,
                    'serial_number' => $e->serial_number,
                    'display_name' => $this->displayName($e),
                    'accessories_count' => $e->accessories_count,
                    'created_at' => $e->created_at,
                ]),
            'recent_imports' => Import::with('user:id,name')->whereNotNull('committed_at')->latest('committed_at')->limit(5)->get()
                ->map(fn (Import $i) => [
                    'id' => $i->id,
                    'original_name' => $i->original_name,
                    'created_count' => $i->created_count,
                    'updated_count' => $i->updated_count,
                    'committed_at' => $i->committed_at,
                    // Who did it is part of the history: only with a PIN
                    'user' => $withPin ? $i->user?->name : null,
                ]),
            // History is private: only sent to people who entered their PIN
            'recent_activity' => $withPin
                ? ActivityLog::with('user:id,name')->latest('created_at')->limit(10)->get()
                : null,
            'activity_by_day' => $withPin ? $this->activityByDay(30) : null,
        ];
    }

    /**
     * Equipment whose data contains one of the "attention" words from the settings
     * (e.g. يحتاج صيانة / تالف / مفقود).
     *
     * @return array{words: array<int, string>, total: int, items: array<int, array<string, mixed>>}
     */
    private function needsAttention(): array
    {
        $words = array_values(array_filter(array_map('trim', preg_split('/\r?\n/', (string) Setting::get('attention_words')))));
        if (! $words) {
            return ['words' => [], 'total' => 0, 'items' => []];
        }

        $matches = EquipmentField::query()
            ->join('equipment', 'equipment.id', '=', 'equipment_fields.equipment_id')
            ->whereNull('equipment.deleted_at')
            ->where(function ($q) use ($words) {
                foreach ($words as $word) {
                    $q->orWhere('equipment_fields.value', 'like', '%'.str_replace(['%', '_'], ['\%', '\_'], $word).'%');
                }
            })
            ->orderByDesc('equipment.updated_at')
            ->get(['equipment.id', 'equipment.serial_number', 'equipment.name', 'equipment_fields.key', 'equipment_fields.value'])
            ->unique('id');

        return [
            'words' => $words,
            'total' => $matches->count(),
            'items' => $matches->take(8)->map(fn ($m) => [
                'id' => $m->id,
                'serial_number' => $m->serial_number,
                'key' => $m->key,
                'value' => strtok((string) $m->value, "\n"),
            ])->values()->all(),
        ];
    }

    /** @return array<int, array{date: string, count: int}> one entry per day, oldest first */
    private function activityByDay(int $days): array
    {
        $from = now()->subDays($days - 1)->startOfDay();
        $counts = ActivityLog::where('created_at', '>=', $from)
            ->get(['created_at'])
            ->countBy(fn ($log) => $log->created_at->toDateString());

        return collect(range(0, $days - 1))
            ->map(fn ($i) => $from->copy()->addDays($i)->toDateString())
            ->map(fn ($date) => ['date' => $date, 'count' => $counts[$date] ?? 0])
            ->all();
    }

    private function detail(Equipment $equipment): array
    {
        $equipment->load(self::DETAIL_RELATIONS);

        return [
            ...self::present($equipment),
            'logs' => auth('sanctum')->check() ? $equipment->logs()->with('user:id,name')->limit(100)->get() : null,
        ];
    }

    /** The relations present() reads. */
    public const DETAIL_RELATIONS = ['fields', 'import', 'creator:id,name', 'updater:id,name', 'parent:id,serial_number,name,category,group_id', 'parent.fields', 'parent.group:id,name', 'accessories.fields', 'boxes', 'group:id,name'];

    /**
     * An equipment's page, without its history. The DETAIL_RELATIONS must be loaded.
     * Also used for the copy that phones keep for working without a connection.
     *
     * @return array<string, mixed>
     */
    public static function present(Equipment $equipment): array
    {
        return [
            'id' => $equipment->id,
            'serial_number' => $equipment->serial_number,
            'name' => $equipment->name,
            'display_name' => self::displayName($equipment),
            'row_no' => $equipment->row_no,
            'category' => $equipment->category,
            'parent' => $equipment->parent?->only(['id', 'serial_number', 'name', 'display_name', 'category']),
            'group' => $equipment->group?->only(['id', 'name']),
            'accessories' => $equipment->accessories->map(fn (Equipment $a) => [
                'id' => $a->id,
                'serial_number' => $a->serial_number,
                'name' => $a->name,
                'fields' => $a->fieldList(),
            ])->all(),
            'fields' => $equipment->fieldList(),
            'photo_url' => $equipment->photoUrl(),
            'boxes' => $equipment->boxes->map(fn ($box) => $box->only(['id', 'number', 'name']))->all(),
            'import' => $equipment->import ? [
                'id' => $equipment->import->id,
                'original_name' => $equipment->import->original_name,
            ] : null,
            'created_by' => $equipment->creator?->name,
            'updated_by' => $equipment->updater?->name,
            'created_at' => $equipment->created_at,
            'updated_at' => $equipment->updated_at,
        ];
    }

    private function validated(Request $request, ?Equipment $equipment = null): array
    {
        $request->merge(['serial_number' => trim((string) $request->input('serial_number'))]);
        // Only main equipment needs a unique serial; an accessory's may repeat or be empty
        $isAccessory = $equipment ? $equipment->isAccessory() : $request->filled('parent_id');
        if (! $isAccessory) {
            Equipment::purgeTrashedSerial($request->input('serial_number'));
        }

        $data = $request->validate([
            'serial_number' => $isAccessory
                ? ['nullable', 'string', 'max:191']
                : ['required', 'string', 'max:191', Rule::unique('equipment', 'serial_number')->whereNull('parent_id')->ignore($equipment?->id)],
            'name' => ['nullable', 'string', 'max:191'],
            'row_no' => ['nullable', 'integer', 'min:0', 'max:999999999'],
            'category' => ['nullable', 'string', 'max:191'],
            // Only on create, and only under a main equipment (accessories have one level)
            'parent_id' => [$equipment ? 'prohibited' : 'nullable', 'integer', Rule::exists('equipment', 'id')->whereNull('parent_id')->whereNull('deleted_at')],
            'group_id' => ['nullable', 'integer', 'exists:equipment_groups,id'],
            'fields' => ['array', 'max:500'],
            'fields.*.key' => ['required', 'string', 'max:255'],
            'fields.*.value' => ['nullable', 'string', 'max:10000'],
        ], ['serial_number.unique' => 'serial_taken']);

        $data['serial_number'] = ($data['serial_number'] ?? '') ?: null;
        $data['fields'] = array_values(array_map(fn ($f) => [
            'key' => trim($f['key']),
            'value' => isset($f['value']) ? trim($f['value']) : null,
        ], $data['fields'] ?? []));

        return $data;
    }
}
