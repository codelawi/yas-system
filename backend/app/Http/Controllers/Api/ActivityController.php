<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\User;
use App\Support\XlsxWriter;
use Illuminate\Http\Request;

/** The full change history. Only for people who entered their PIN. */
class ActivityController extends Controller
{
    public function index(Request $request)
    {
        $logs = $this->query($request)->paginate((int) $request->query('per_page', 50));

        return $logs->toArray() + ['users' => User::orderBy('name')->get(['id', 'name'])];
    }

    /** Excel file of the history (same filters as the History tab). */
    public function export(Request $request)
    {
        $logs = $this->query($request)->limit(50000)->get();
        $rows = $logs->map(fn (ActivityLog $log) => [
            $log->created_at?->format('Y-m-d H:i'),
            trans()->has('activity.'.$log->action, 'ar') ? trans('activity.'.$log->action, [], 'ar') : $log->action,
            $log->serial_number,
            $log->user?->name,
            self::summary($log->changes),
        ]);

        $path = tempnam(sys_get_temp_dir(), 'xlsx');
        XlsxWriter::write($path, 'سجل التغييرات', ['التاريخ', 'الإجراء', 'الرقم التسلسلي', 'بواسطة', 'التفاصيل'], $rows);

        return response()->download($path, 'history-'.now()->format('Y-m-d').'.xlsx', [
            'Content-Type' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ])->deleteFileAfterSend();
    }

    /** One readable line for a change set. */
    private static function summary(?array $changes): ?string
    {
        if (! $changes) {
            return null;
        }
        if (isset($changes['summary'])) {
            return $changes['summary'];
        }
        if (isset($changes['accessory'])) {
            return trim(($changes['accessory']['name'] ?? '').' '.$changes['accessory']['serial_number']);
        }
        $lines = [];
        foreach ($changes['changed'] ?? [] as $c) {
            $lines[] = "{$c['key']}: {$c['from']} ← {$c['to']}";
        }
        foreach ($changes['added'] ?? [] as $c) {
            $lines[] = "+ {$c['key']}: {$c['value']}";
        }
        foreach ($changes['removed'] ?? [] as $c) {
            $lines[] = "- {$c['key']}: {$c['value']}";
        }

        return implode("\n", $lines) ?: null;
    }

    private function query(Request $request)
    {
        $data = $request->validate([
            'q' => ['nullable', 'string', 'max:191'],
            'action' => ['nullable', 'string', 'max:50'],
            'user_id' => ['nullable', 'integer'],
            'from' => ['nullable', 'date'],
            'to' => ['nullable', 'date'],
            'per_page' => ['nullable', 'integer', 'min:5', 'max:200'],
        ]);

        return ActivityLog::with('user:id,name')
            ->when($data['q'] ?? null, fn ($query, $q) => $query->where('serial_number', 'like', '%'.str_replace(['%', '_'], ['\%', '\_'], $q).'%'))
            ->when($data['action'] ?? null, fn ($query, $action) => $query->where('action', $action))
            ->when($data['user_id'] ?? null, fn ($query, $userId) => $query->where('user_id', $userId))
            ->when($data['from'] ?? null, fn ($query, $from) => $query->where('created_at', '>=', $from.' 00:00:00'))
            ->when($data['to'] ?? null, fn ($query, $to) => $query->where('created_at', '<=', $to.' 23:59:59'))
            ->latest('created_at')
            ->latest('id');
    }
}
