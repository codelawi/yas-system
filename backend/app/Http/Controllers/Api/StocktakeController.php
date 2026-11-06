<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Equipment;
use App\Models\Stocktake;
use App\Models\StocktakeScan;
use App\Support\XlsxWriter;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

/** Stocktake (جرد): scan labels, then see what is missing, misplaced or unknown. */
class StocktakeController extends Controller
{
    public function index()
    {
        return Stocktake::with('startedBy:id,name')->withCount('scans')->latest('id')->limit(50)->get()
            ->map(fn (Stocktake $s) => $s->toArray() + ['expected_count' => $s->expectedQuery()->count()]);
    }

    public function store(Request $request)
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:191'],
            'filters' => ['nullable', 'array', 'max:10'],
            'filters.*.key' => ['required', 'string', 'max:255'],
            'filters.*.value' => ['nullable', 'string', 'max:500'],
            'include_accessories' => ['boolean'],
        ]);

        return Stocktake::create($data + ['started_by' => $request->user()->id, 'status' => 'open']);
    }

    public function show(Stocktake $stocktake)
    {
        return $this->report($stocktake);
    }

    /** Record one scanned label. `code` may be the serial or the whole QR link. */
    public function scan(Request $request, Stocktake $stocktake)
    {
        $data = $request->validate(['code' => ['required', 'string', 'max:500']]);
        if ($stocktake->status !== 'open') {
            throw ValidationException::withMessages(['code' => 'stocktake_closed']);
        }

        $serial = self::serialFromCode($data['code']);
        $existing = $stocktake->scans()->where('serial_number', $serial)->first();
        if ($existing) {
            return ['status' => 'already', 'scan' => $this->withEquipmentName($existing), 'counts' => $this->counts($stocktake)];
        }

        $equipment = Equipment::forSerial($serial)->first();
        $result = match (true) {
            ! $equipment => 'unknown',
            $stocktake->expectedQuery()->whereKey($equipment->id)->exists() => 'found',
            default => 'unexpected',
        };
        $scan = $stocktake->scans()->create([
            'serial_number' => $serial,
            'equipment_id' => $equipment?->id,
            'result' => $result,
            'scanned_by' => $request->user()->id,
        ]);

        return ['status' => $result, 'scan' => $this->withEquipmentName($scan), 'counts' => $this->counts($stocktake)];
    }

    /** An unknown label has no equipment. */
    private function withEquipmentName(StocktakeScan $scan): StocktakeScan
    {
        $scan->load(Equipment::NAME_RELATIONS)->equipment?->withDisplayName();

        return $scan;
    }

    public function destroyScan(Stocktake $stocktake, StocktakeScan $scan)
    {
        abort_unless($scan->stocktake_id === $stocktake->id, 404);
        $scan->delete();

        return ['counts' => $this->counts($stocktake)];
    }

    public function close(Stocktake $stocktake)
    {
        $stocktake->update(['status' => 'closed', 'closed_at' => now()]);

        return $this->report($stocktake);
    }

    /** Deletes the stocktake and its scans only — equipment is untouched. */
    public function destroy(Stocktake $stocktake)
    {
        $stocktake->delete();

        return response()->noContent();
    }

    public function export(Stocktake $stocktake)
    {
        $report = $this->report($stocktake);
        $rows = [];
        foreach (['found' => 'موجودة', 'missing' => 'مفقودة', 'unexpected' => 'في غير مكانها', 'unknown' => 'غير معروفة'] as $group => $label) {
            foreach ($report[$group] as $item) {
                $rows[] = [$label, $item['serial_number'], $item['name'] ?? null, $item['location'] ?? null, $item['scanned_at'] ?? null];
            }
        }

        $path = tempnam(sys_get_temp_dir(), 'xlsx');
        XlsxWriter::write($path, 'الجرد', ['النتيجة', 'الرقم التسلسلي', 'الاسم', 'المكان المسجل', 'وقت المسح'], $rows);

        return response()->download($path, 'stocktake-'.$stocktake->id.'.xlsx', [
            'Content-Type' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ])->deleteFileAfterSend();
    }

    /** "http://repo.local/eq/ABC-1" → "ABC-1"; plain text stays as it is. */
    public static function serialFromCode(string $code): string
    {
        $code = trim($code);
        if (preg_match('#/eq/([^/?\#]+)#', $code, $m)) {
            return rawurldecode($m[1]);
        }

        return $code;
    }

    private function counts(Stocktake $stocktake): array
    {
        $byResult = $stocktake->scans()->selectRaw('result, count(*) as n')->groupBy('result')->pluck('n', 'result');
        $expected = $stocktake->expectedQuery()->count();
        $found = (int) ($byResult['found'] ?? 0);

        return [
            'expected' => $expected,
            'found' => $found,
            'missing' => max(0, $expected - $found),
            'unexpected' => (int) ($byResult['unexpected'] ?? 0),
            'unknown' => (int) ($byResult['unknown'] ?? 0),
        ];
    }

    private function report(Stocktake $stocktake): array
    {
        $scans = $stocktake->scans()->with(['equipment.fields', 'equipment.group:id,name', 'scannedBy:id,name'])->latest('id')->get();
        $foundIds = $scans->where('result', 'found')->pluck('equipment_id')->filter()->all();
        $describe = fn (?Equipment $e) => $e ? [
            'id' => $e->id,
            'serial_number' => $e->serial_number,
            'name' => EquipmentController::displayName($e),
            'location' => $e->fields->first(fn ($f) => in_array($f->key, ['المكان', 'الموقع', 'Location'], true))?->value,
        ] : [];

        $missing = $stocktake->expectedQuery()->with(['fields', 'group:id,name'])->whereNotIn('id', $foundIds)->orderBy('serial_number')->limit(2000)->get()
            ->map(fn (Equipment $e) => $describe($e))->values();
        $mapScan = fn (StocktakeScan $s) => $describe($s->equipment) + [
            'scan_id' => $s->id,
            'serial_number' => $s->serial_number,
            'scanned_at' => $s->created_at?->format('Y-m-d H:i'),
            'scanned_by' => $s->scannedBy?->name,
        ];

        return [
            'stocktake' => $stocktake->load('startedBy:id,name'),
            'counts' => $this->counts($stocktake),
            'found' => $scans->where('result', 'found')->map($mapScan)->values(),
            'missing' => $missing,
            'unexpected' => $scans->where('result', 'unexpected')->map($mapScan)->values(),
            'unknown' => $scans->where('result', 'unknown')->map($mapScan)->values(),
        ];
    }
}
