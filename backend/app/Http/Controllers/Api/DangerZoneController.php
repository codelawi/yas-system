<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\Custody;
use App\Models\Equipment;
use App\Models\Import;
use App\Models\IssueReport;
use App\Models\MaintenanceRecord;
use App\Models\MaintenanceSchedule;
use App\Models\ScanDocumentRow;
use App\Models\Stocktake;
use App\Services\BackupManager;
use App\Support\PinConfirmation;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\ValidationException;
use RuntimeException;

/**
 * Settings → danger zone (admin only): clear data, delete backups.
 * Every action needs the PIN again; clearing data always makes a safety backup first.
 * Users, settings, label design and custody forms are never touched.
 */
class DangerZoneController extends Controller
{
    public const TARGETS = ['history', 'stocktakes', 'custody', 'issues', 'maintenance', 'equipment', 'all'];

    /** How many records each action would delete. */
    public function index(BackupManager $backups)
    {
        return [
            'history' => ActivityLog::count(),
            'stocktakes' => Stocktake::count(),
            'custody' => Custody::count(),
            'issues' => IssueReport::count(),
            'maintenance' => MaintenanceSchedule::count() + MaintenanceRecord::count(),
            'equipment' => Equipment::withTrashed()->count(),
            'backups' => count($backups->list()),
        ];
    }

    public function clear(Request $request, BackupManager $backups)
    {
        $data = $request->validate(['target' => ['required', 'in:'.implode(',', self::TARGETS)]]);
        PinConfirmation::check($request);

        // Never clear anything without a way back
        try {
            $safety = $backups->create('before-clear-'.$data['target']);
        } catch (RuntimeException $e) {
            throw ValidationException::withMessages(['target' => $e->getMessage()]);
        }

        $deleted = DB::transaction(fn () => match ($data['target']) {
            'history' => ActivityLog::query()->delete(),
            'stocktakes' => Stocktake::query()->delete(),
            'custody' => Custody::query()->delete(),
            'issues' => IssueReport::query()->delete(),
            'maintenance' => MaintenanceRecord::query()->delete() + MaintenanceSchedule::query()->delete(),
            'equipment' => $this->clearEquipment(),
            'all' => $this->clearEquipment() + ActivityLog::query()->delete() + Stocktake::query()->delete(),
        });
        $this->deleteOrphanFiles();

        Log::warning("Danger zone: cleared {$data['target']} ({$deleted} rows) by user {$request->user()->id}, safety backup {$safety['file']}");

        return ['deleted' => $deleted, 'safety_backup' => $safety['file']];
    }

    /** One backup (`file`) or all of them. */
    public function deleteBackups(Request $request, BackupManager $backups)
    {
        $data = $request->validate(['file' => ['nullable', 'string', 'max:255']]);
        PinConfirmation::check($request);

        try {
            $paths = isset($data['file'])
                ? [$backups->path($data['file'])]
                : array_map(fn (array $b) => $backups->path($b['file']), $backups->list());
        } catch (RuntimeException $e) {
            throw ValidationException::withMessages(['file' => $e->getMessage()]);
        }

        $deleted = 0;
        foreach ($paths as $path) {
            $deleted += (int) @unlink($path);
        }
        Log::warning("Danger zone: deleted {$deleted} backup(s) by user {$request->user()->id}");

        return ['deleted' => $deleted];
    }

    /** All equipment (also previously deleted ones) and what belongs to them, plus imports. */
    private function clearEquipment(): int
    {
        // Accessories first: they point at their main equipment
        $count = Equipment::withTrashed()->whereNotNull('parent_id')->forceDelete()
            + Equipment::withTrashed()->forceDelete();
        Import::query()->delete();

        return $count;
    }

    /** Word files, damage photos, equipment photos and scanned text photos whose records are gone. */
    private function deleteOrphanFiles(): void
    {
        $keep = [
            'imports' => Import::pluck('stored_path')->filter()->all(),
            'issues' => IssueReport::pluck('photo_path')->filter()->all(),
            'equipment_photos' => Equipment::withTrashed()->pluck('photo_path')->filter()->all(),
            'scan_photos' => ScanDocumentRow::pluck('photo_path')->filter()->all(),
        ];
        foreach ($keep as $folder => $used) {
            foreach (array_diff(Storage::files($folder), $used) as $file) {
                Storage::delete($file);
            }
        }
    }
}
