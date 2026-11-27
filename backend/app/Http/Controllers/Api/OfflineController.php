<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Box;
use App\Models\Equipment;
use App\Models\EquipmentGroup;
use App\Models\ScanDocument;
use App\Models\ScanFolder;
use App\Models\Setting;
use App\Models\User;
use App\Models\Voucher;
use Illuminate\Database\Eloquent\Collection;

/**
 * Everything a phone needs to open the system's pages without a connection, in one download.
 * The phone's service worker answers the pages from it (frontend/src/offlineData.js): what can
 * be filtered (lists) is sent as items, the rest as the server's own answers.
 *
 * Only for someone who entered a PIN, since it holds vouchers, recipients and recent history.
 * Equipment pages carry no change history.
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
            'version' => 2,
            'generated_at' => now()->toIso8601String(),
            'settings' => Setting::allValues(),
            'equipment' => $equipment->map(fn (Equipment $e) => EquipmentController::present($e))->all(),
            'serials' => (object) $this->serialIndex($equipment),
            'boxes' => $boxes->map(fn (Box $b) => BoxController::present($b))->all(),
            'maintenance' => (object) $maintenance,
            'issues' => (object) $issues,
            'groups' => EquipmentGroup::orderBy('id')->get(),
            'stats' => app(EquipmentController::class)->stats(),
            'vouchers' => $this->vouchers(),
            'scan' => $this->scanDocuments(),
            'users' => $this->users(),
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

    /**
     * Every voucher as the list shows it (the phone filters it), each voucher's page, and what
     * the voucher page asks for besides.
     *
     * @return array{list: Collection<int, Voucher>, next_number: int, pages: object, recipients: mixed, templates: mixed}
     */
    private function vouchers(): array
    {
        $controller = app(VoucherController::class);
        $pages = [];
        foreach (Voucher::orderBy('id')->get() as $voucher) {
            $pages[$voucher->id] = $controller->show($voucher);
        }

        return [
            'list' => VoucherController::listed()->get(),
            'next_number' => Voucher::nextNumber(),
            'pages' => (object) $pages,
            'recipients' => $controller->recipients(),
            'templates' => app(VoucherTemplateController::class)->index(),
        ];
    }

    /**
     * Scan documents: the folder list, each folder and each document, with the revisions that
     * open screens keep asking for.
     *
     * @return array{folders: mixed, revision: string, folder_pages: object, folder_revisions: object, documents: object}
     */
    private function scanDocuments(): array
    {
        $folderController = app(ScanFolderController::class);
        $documentController = app(ScanDocumentController::class);
        $folderPages = [];
        $folderRevisions = [];
        foreach (ScanFolder::orderBy('id')->get() as $folder) {
            $folderPages[$folder->id] = $folderController->show($folder);
            $folderRevisions[$folder->id] = $folderController->revision($folder)['revision'];
        }
        $documents = [];
        foreach (ScanDocument::orderBy('id')->get() as $document) {
            $documents[$document->id] = $documentController->show($document);
        }

        return [
            'folders' => $folderController->index(),
            'revision' => $folderController->listRevision()['revision'],
            'folder_pages' => (object) $folderPages,
            'folder_revisions' => (object) $folderRevisions,
            'documents' => (object) $documents,
        ];
    }

    /**
     * Who can unlock the phone without a connection: active users whose PIN was typed since
     * the phones got this (App\Support\OfflinePin).
     *
     * @return list<array{id: int, name: string, role: string, offline_pin: string}>
     */
    private function users(): array
    {
        return User::where('is_active', true)->whereNotNull('offline_pin')->orderBy('id')->get()
            ->map(fn (User $user) => ['id' => $user->id, 'name' => $user->name, 'role' => $user->role, 'offline_pin' => $user->offline_pin])
            ->all();
    }
}
