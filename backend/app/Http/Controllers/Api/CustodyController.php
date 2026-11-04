<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\Custody;
use App\Models\Equipment;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/** Custody (عهدة): hand equipment over to a person and take it back. */
class CustodyController extends Controller
{
    /** Who holds what right now (overdue first). */
    public function index(Request $request)
    {
        $query = Custody::open()
            ->with(['equipment' => fn ($q) => $q->select('id', 'serial_number', 'name', 'parent_id')->with('parent:id,serial_number'), 'handedBy:id,name'])
            ->whereHas('equipment')
            ->when($request->query('holder'), fn ($q, $holder) => $q->where('holder', $holder))
            ->orderByRaw('due_back_at is null')
            ->orderBy('due_back_at')
            ->orderBy('handed_at');

        return [
            'open' => $query->get(),
            'holders' => Custody::open()->select('holder')->distinct()->orderBy('holder')->pluck('holder'),
        ];
    }

    /** Current and past custody of one equipment. */
    public function equipmentIndex(Equipment $equipment)
    {
        return $equipment->custodies()->with(['handedBy:id,name', 'receivedBy:id,name'])->limit(50)->get();
    }

    /** Names used before (for autocomplete). */
    public function holders()
    {
        return Custody::select('holder')->distinct()->orderBy('holder')->limit(500)->pluck('holder');
    }

    public function handOver(Request $request, Equipment $equipment)
    {
        $data = $request->validate([
            'holder' => ['required', 'string', 'max:191'],
            'holder_phone' => ['nullable', 'string', 'max:50'],
            'holder_id_number' => ['nullable', 'string', 'max:100'],
            'holder_department' => ['nullable', 'string', 'max:191'],
            'due_back_at' => ['nullable', 'date'],
            'notes' => ['nullable', 'string', 'max:5000'],
            'include_accessories' => ['boolean'],
        ]);

        if (Custody::open()->where('equipment_id', $equipment->id)->exists()) {
            throw ValidationException::withMessages(['holder' => 'already_in_custody']);
        }

        $items = collect([$equipment]);
        if ($data['include_accessories'] ?? false) {
            $busy = Custody::open()->pluck('equipment_id');
            $items = $items->merge($equipment->accessories()->whereNotIn('id', $busy)->get());
        }

        $main = DB::transaction(function () use ($items, $data, $request) {
            $created = null;
            $now = now(); // one time for the whole hand-over: the printed form finds its accessories by it
            foreach ($items as $item) {
                $custody = Custody::create([
                    'equipment_id' => $item->id,
                    'holder' => trim($data['holder']),
                    'holder_phone' => $data['holder_phone'] ?? null,
                    'holder_id_number' => $data['holder_id_number'] ?? null,
                    'holder_department' => $data['holder_department'] ?? null,
                    'due_back_at' => $data['due_back_at'] ?? null,
                    'notes' => $data['notes'] ?? null,
                    'handed_at' => $now,
                    'handed_by' => $request->user()->id,
                ]);
                $created ??= $custody;
                ActivityLog::record($item, 'custody_out', ['summary' => trim($data['holder']).($data['due_back_at'] ?? null ? ' ← '.$data['due_back_at'] : '')]);
            }

            return $created;
        });

        return ['handed_over' => $items->count(), 'custody_id' => $main->id];
    }

    /** Take it back (with the accessories that were handed over with it). */
    public function receive(Request $request, Equipment $equipment)
    {
        $data = $request->validate([
            'return_notes' => ['nullable', 'string', 'max:5000'],
            'include_accessories' => ['boolean'],
        ]);

        $ids = collect([$equipment->id]);
        if ($data['include_accessories'] ?? true) {
            $ids = $ids->merge($equipment->accessories()->pluck('id'));
        }
        $open = Custody::open()->with('equipment')->whereIn('equipment_id', $ids)->get();
        if ($open->isEmpty()) {
            throw ValidationException::withMessages(['holder' => 'not_in_custody']);
        }

        DB::transaction(function () use ($open, $data, $request) {
            foreach ($open as $custody) {
                $custody->update(['returned_at' => now(), 'return_notes' => $data['return_notes'] ?? null, 'received_by' => $request->user()->id]);
                ActivityLog::record($custody->equipment, 'custody_in', ['summary' => trim($custody->holder.' '.($data['return_notes'] ?? ''))]);
            }
        });

        return ['received' => $open->count()];
    }
}
