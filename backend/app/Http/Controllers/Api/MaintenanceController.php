<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\Equipment;
use App\Models\MaintenanceRecord;
use App\Models\MaintenanceSchedule;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/** Dates to keep (inspection, warranty, expiry...) and the maintenance log. */
class MaintenanceController extends Controller
{
    public function index(Equipment $equipment)
    {
        return [
            'schedules' => $equipment->schedules()->get(),
            'records' => $equipment->maintenanceRecords()->with('user:id,name')->limit(50)->get(),
        ];
    }

    /** Overdue and upcoming dates across all equipment (home page). */
    public function due(Request $request)
    {
        $days = min(365, max(1, (int) $request->query('days', 30)));

        return MaintenanceSchedule::with('equipment:id,serial_number,name')
            ->whereHas('equipment')
            ->where('due_date', '<=', now()->addDays($days)->toDateString())
            ->orderBy('due_date')
            ->limit(100)
            ->get();
    }

    public function store(Request $request, Equipment $equipment)
    {
        $schedule = $equipment->schedules()->create($this->validated($request));
        ActivityLog::record($equipment, 'updated', ['summary' => "+ {$schedule->title}: {$schedule->due_date->toDateString()}"]);

        return $schedule;
    }

    public function update(Request $request, MaintenanceSchedule $schedule)
    {
        $schedule->update($this->validated($request));

        return $schedule;
    }

    public function destroy(MaintenanceSchedule $schedule)
    {
        $schedule->delete();

        return response()->noContent();
    }

    /**
     * The work was done: log it, then move a repeating date forward (from the
     * day it was done) or remove a one-time date.
     */
    public function complete(Request $request, MaintenanceSchedule $schedule)
    {
        $data = $request->validate([
            'done_at' => ['nullable', 'date'],
            'notes' => ['nullable', 'string', 'max:5000'],
            'cost' => ['nullable', 'numeric', 'min:0', 'max:999999999'],
        ]);
        $doneAt = Carbon::parse($data['done_at'] ?? now()->toDateString());

        $record = DB::transaction(function () use ($schedule, $data, $doneAt, $request) {
            $record = MaintenanceRecord::create([
                'equipment_id' => $schedule->equipment_id,
                'schedule_id' => $schedule->interval_months ? $schedule->id : null,
                'title' => $schedule->title,
                'done_at' => $doneAt->toDateString(),
                'notes' => $data['notes'] ?? null,
                'cost' => $data['cost'] ?? null,
                'user_id' => $request->user()->id,
            ]);
            if ($schedule->interval_months) {
                $schedule->update(['due_date' => $doneAt->copy()->addMonthsNoOverflow($schedule->interval_months)->toDateString()]);
            } else {
                $schedule->delete();
            }
            ActivityLog::record($schedule->equipment, 'maintenance_done', ['summary' => trim("{$record->title} ".($record->notes ?? ''))]);

            return $record;
        });

        return ['record' => $record, 'schedule' => $schedule->exists ? $schedule->fresh() : null];
    }

    /** Log work that was not planned. */
    public function storeRecord(Request $request, Equipment $equipment)
    {
        $data = $request->validate([
            'title' => ['required', 'string', 'max:191'],
            'done_at' => ['required', 'date'],
            'notes' => ['nullable', 'string', 'max:5000'],
            'cost' => ['nullable', 'numeric', 'min:0', 'max:999999999'],
        ]);
        $record = $equipment->maintenanceRecords()->create($data + ['user_id' => $request->user()->id]);
        ActivityLog::record($equipment, 'maintenance_done', ['summary' => trim("{$record->title} ".($record->notes ?? ''))]);

        return $record;
    }

    private function validated(Request $request): array
    {
        return $request->validate([
            'title' => ['required', 'string', 'max:191'],
            'due_date' => ['required', 'date'],
            'interval_months' => ['nullable', 'integer', 'min:1', 'max:240'],
            'notes' => ['nullable', 'string', 'max:5000'],
        ]);
    }
}
