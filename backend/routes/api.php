<?php

use App\Http\Controllers\Api\ActivityController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\BackupController;
use App\Http\Controllers\Api\BoxController;
use App\Http\Controllers\Api\DangerZoneController;
use App\Http\Controllers\Api\EquipmentController;
use App\Http\Controllers\Api\EquipmentGroupController;
use App\Http\Controllers\Api\EquipmentPhotoController;
use App\Http\Controllers\Api\FieldController;
use App\Http\Controllers\Api\ImportController;
use App\Http\Controllers\Api\IssueController;
use App\Http\Controllers\Api\LookupController;
use App\Http\Controllers\Api\MaintenanceController;
use App\Http\Controllers\Api\NetworkController;
use App\Http\Controllers\Api\OfflineController;
use App\Http\Controllers\Api\PrintStationController;
use App\Http\Controllers\Api\ScanDocumentController;
use App\Http\Controllers\Api\ScanFolderController;
use App\Http\Controllers\Api\SettingController;
use App\Http\Controllers\Api\StocktakeController;
use App\Http\Controllers\Api\UserController;
use App\Http\Controllers\Api\VoucherController;
use App\Http\Controllers\Api\VoucherTemplateController;
use Illuminate\Support\Facades\Route;

// Viewing is open to everyone on the network; changes need a PIN.
Route::post('/auth/login', [AuthController::class, 'login'])->middleware('throttle:10,1');

Route::get('/settings', [SettingController::class, 'index']);
Route::get('/stats', [EquipmentController::class, 'stats']);
Route::get('/equipment', [EquipmentController::class, 'index']);
Route::get('/equipment/labels', [EquipmentController::class, 'labels']);
Route::get('/equipment/categories', [EquipmentController::class, 'categories']);
Route::get('/equipment/group-summary', [EquipmentController::class, 'groupSummary']);
Route::get('/groups', [EquipmentGroupController::class, 'index']);
Route::get('/groups/{group}', [EquipmentGroupController::class, 'show'])->whereNumber('group');
Route::get('/equipment/keys', [EquipmentController::class, 'keys']);
Route::get('/equipment/values', [EquipmentController::class, 'values']);
// Every serial number, so the camera's text mode can recognise what it reads
Route::get('/equipment/serial-list', [EquipmentController::class, 'serialList'])->middleware('throttle:60,1');
Route::get('/equipment/serial/{serial}', [EquipmentController::class, 'bySerial'])->where('serial', '.*');
Route::get('/equipment/{equipment}', [EquipmentController::class, 'show'])->whereNumber('equipment');
Route::get('/imports', [ImportController::class, 'index']);
Route::get('/imports/{import}/download', [ImportController::class, 'download']);
Route::get('/network', [NetworkController::class, 'index']);
Route::get('/equipment/{equipment}/photo', [EquipmentPhotoController::class, 'show'])->whereNumber('equipment');

// Boxes: a box label opens /box/<number> on any phone
Route::get('/boxes', [BoxController::class, 'index']);
Route::get('/boxes/labels', [BoxController::class, 'labels']);
Route::get('/boxes/number/{number}', [BoxController::class, 'byNumber'])->where('number', '.*');
Route::get('/boxes/{box}', [BoxController::class, 'show'])->whereNumber('box');

// Scan page: any other code (e.g. a maker's Data Matrix) finds the equipment or box that holds it
Route::get('/lookup', [LookupController::class, 'show']);

// Maintenance dates and damage reports are visible to everyone; anyone can report a problem
Route::get('/equipment/{equipment}/maintenance', [MaintenanceController::class, 'index'])->whereNumber('equipment');
Route::get('/maintenance/due', [MaintenanceController::class, 'due']);
Route::get('/equipment/{equipment}/issues', [IssueController::class, 'equipmentIndex'])->whereNumber('equipment');
Route::post('/equipment/{equipment}/issues', [IssueController::class, 'store'])->whereNumber('equipment')->middleware(['throttle:issue-reports', 'offline']);
Route::get('/issues', [IssueController::class, 'index']);
Route::get('/issues/{issue}/photo', [IssueController::class, 'photo']);
Route::get('/network/ping', [NetworkController::class, 'ping']);
// Phones compare it with the copy they downloaded (App\Support\DataRevision)
Route::get('/offline/revision', [OfflineController::class, 'revision'])->middleware('throttle:60,1');
Route::get('/network/check-address', [NetworkController::class, 'checkAddress'])->middleware('throttle:30,1');
Route::post('/labels/printed', [SettingController::class, 'labelsPrinted'])->middleware('throttle:30,1');

// Scan documents, in folders: anyone can read them; scanning and editing need a PIN
Route::get('/scan-folders', [ScanFolderController::class, 'index']);
Route::get('/scan-folders/revision', [ScanFolderController::class, 'listRevision']);
Route::get('/scan-folders/{scanFolder}', [ScanFolderController::class, 'show'])->whereNumber('scanFolder');
Route::get('/scan-folders/{scanFolder}/revision', [ScanFolderController::class, 'revision'])->whereNumber('scanFolder');
Route::get('/scan-documents/{scanDocument}', [ScanDocumentController::class, 'show'])->whereNumber('scanDocument');
Route::get('/scan-documents/{scanDocument}/revision', [ScanDocumentController::class, 'revision'])->whereNumber('scanDocument');
Route::get('/scan-documents/{scanDocument}/rows/{row}/photo', [ScanDocumentController::class, 'rowPhoto'])->whereNumber(['scanDocument', 'row']);

// Phones download everything once, then open scanned labels without a connection

// The print station on the laptop: no PIN, its own key (see App\Support\PrintStation)
Route::get('/print-station/next', [PrintStationController::class, 'next']);
Route::post('/print-station/jobs/{print}/printed', [PrintStationController::class, 'printed'])->whereNumber('print');
Route::post('/print-station/jobs/{print}/cancel', [PrintStationController::class, 'cancel'])->whereNumber('print');

// Changes need a PIN. A phone that worked without a connection sends its changes here too (see App\Http\Middleware\ApplyOfflineChange)
Route::middleware(['auth:sanctum', 'offline'])->group(function () {
    Route::get('/auth/me', [AuthController::class, 'me']);
    // Everything a phone keeps for working without a connection (it holds vouchers and recipients)
    Route::get('/offline/snapshot', [OfflineController::class, 'snapshot'])->middleware('throttle:10,1');
    Route::post('/offline/done', [OfflineController::class, 'done']);
    Route::get('/activity', [ActivityController::class, 'index']);
    Route::get('/activity/export', [ActivityController::class, 'export']);
    Route::get('/equipment/export', [EquipmentController::class, 'export']);
    Route::post('/auth/logout', [AuthController::class, 'logout']);

    Route::post('/equipment', [EquipmentController::class, 'store']);
    Route::post('/equipment/bulk-delete', [EquipmentController::class, 'bulkDestroy']);
    Route::post('/equipment/bulk-update', [FieldController::class, 'bulkUpdate']);
    Route::put('/equipment/{equipment}', [EquipmentController::class, 'update']);
    Route::delete('/equipment/{equipment}', [EquipmentController::class, 'destroy']);
    // A phone that changed equipment deleted meanwhile can bring it back when it syncs
    Route::post('/equipment/{equipment}/restore', [EquipmentController::class, 'restore'])->whereNumber('equipment')->withTrashed();
    // Equipment and boxes added on a phone without a connection, waiting for their labels
    Route::post('/labels/pending/clear', [SettingController::class, 'clearPendingLabels']);
    Route::post('/equipment/{equipment}/photo', [EquipmentPhotoController::class, 'store']);
    Route::delete('/equipment/{equipment}/photo', [EquipmentPhotoController::class, 'destroy']);

    Route::post('/groups', [EquipmentGroupController::class, 'store']);
    // What an issue voucher (سند صرف) prints for each group: entered in a table or read from Word/Excel
    Route::put('/groups/voucher-codes', [EquipmentGroupController::class, 'saveVoucherCodes']);
    Route::post('/groups/voucher-codes/read', [EquipmentGroupController::class, 'readVoucherFile']);
    Route::put('/groups/{group}', [EquipmentGroupController::class, 'update'])->whereNumber('group');
    Route::delete('/groups/{group}', [EquipmentGroupController::class, 'destroy'])->whereNumber('group');
    Route::post('/groups/assign', [EquipmentGroupController::class, 'assign']);
    Route::get('/groups/suggest', [EquipmentGroupController::class, 'suggest']);
    Route::post('/groups/apply', [EquipmentGroupController::class, 'apply']);

    Route::post('/boxes', [BoxController::class, 'store']);
    Route::put('/boxes/{box}', [BoxController::class, 'update']);
    Route::delete('/boxes/{box}', [BoxController::class, 'destroy']);
    Route::post('/boxes/{box}/equipment', [BoxController::class, 'attach']);
    Route::delete('/boxes/{box}/equipment/{equipment}', [BoxController::class, 'detach']);
    Route::post('/boxes/{box}/equipment/remove', [BoxController::class, 'detachMany']);

    Route::post('/equipment/{equipment}/maintenance', [MaintenanceController::class, 'store']);
    Route::post('/equipment/{equipment}/maintenance-records', [MaintenanceController::class, 'storeRecord']);
    Route::put('/maintenance/{schedule}', [MaintenanceController::class, 'update']);
    Route::delete('/maintenance/{schedule}', [MaintenanceController::class, 'destroy']);
    Route::post('/maintenance/{schedule}/complete', [MaintenanceController::class, 'complete']);

    // Issue vouchers (سند صرف عهدة)
    Route::get('/vouchers', [VoucherController::class, 'index']);
    Route::post('/vouchers', [VoucherController::class, 'store']);
    Route::get('/vouchers/recipients', [VoucherController::class, 'recipients']);
    Route::post('/vouchers/return', [VoucherController::class, 'returnAny']);
    Route::put('/vouchers/next-number', [VoucherController::class, 'setNextNumber']);
    Route::get('/vouchers/{voucher}', [VoucherController::class, 'show'])->whereNumber('voucher');
    Route::get('/vouchers/{voucher}/revision', [VoucherController::class, 'revision'])->whereNumber('voucher');
    Route::put('/vouchers/{voucher}', [VoucherController::class, 'update'])->whereNumber('voucher');
    Route::delete('/vouchers/{voucher}', [VoucherController::class, 'destroy'])->whereNumber('voucher');
    Route::post('/vouchers/{voucher}/items', [VoucherController::class, 'addItems'])->whereNumber('voucher');
    Route::delete('/vouchers/{voucher}/items/{item}', [VoucherController::class, 'removeItem'])->whereNumber(['voucher', 'item']);
    Route::post('/vouchers/{voucher}/issue', [VoucherController::class, 'issue'])->whereNumber('voucher');
    Route::post('/vouchers/{voucher}/return', [VoucherController::class, 'returnItem'])->whereNumber('voucher');
    Route::post('/vouchers/{voucher}/return-all', [VoucherController::class, 'returnAll'])->whereNumber('voucher');
    Route::post('/vouchers/{voucher}/replace', [VoucherController::class, 'replace'])->whereNumber('voucher');
    Route::post('/vouchers/{voucher}/print', [VoucherController::class, 'print'])->whereNumber('voucher');
    Route::get('/print-station', [PrintStationController::class, 'status']);
    Route::post('/print-station/open', [PrintStationController::class, 'open']);
    Route::get('/voucher-templates', [VoucherTemplateController::class, 'index']);
    Route::post('/voucher-templates', [VoucherTemplateController::class, 'store']);
    Route::get('/voucher-templates/{template}', [VoucherTemplateController::class, 'show'])->whereNumber('template');
    Route::put('/voucher-templates/{template}', [VoucherTemplateController::class, 'update'])->whereNumber('template');
    Route::delete('/voucher-templates/{template}', [VoucherTemplateController::class, 'destroy'])->whereNumber('template');
    Route::post('/voucher-templates/{template}/default', [VoucherTemplateController::class, 'makeDefault'])->whereNumber('template');

    Route::post('/issues/{issue}/close', [IssueController::class, 'close']);

    Route::get('/stocktakes', [StocktakeController::class, 'index']);
    Route::post('/stocktakes', [StocktakeController::class, 'store']);
    Route::get('/stocktakes/{stocktake}', [StocktakeController::class, 'show']);
    Route::delete('/stocktakes/{stocktake}', [StocktakeController::class, 'destroy']);
    Route::post('/stocktakes/{stocktake}/scan', [StocktakeController::class, 'scan']);
    Route::delete('/stocktakes/{stocktake}/scans/{scan}', [StocktakeController::class, 'destroyScan']);
    Route::post('/stocktakes/{stocktake}/close', [StocktakeController::class, 'close']);
    Route::get('/stocktakes/{stocktake}/export', [StocktakeController::class, 'export']);

    Route::post('/scan-folders', [ScanFolderController::class, 'store']);
    Route::put('/scan-folders/{scanFolder}', [ScanFolderController::class, 'update']);
    Route::delete('/scan-folders/{scanFolder}', [ScanFolderController::class, 'destroy']);
    Route::post('/scan-documents', [ScanDocumentController::class, 'store']);
    Route::put('/scan-documents/{scanDocument}', [ScanDocumentController::class, 'update']);
    Route::delete('/scan-documents/{scanDocument}', [ScanDocumentController::class, 'destroy']);
    Route::post('/scan-documents/{scanDocument}/scan', [ScanDocumentController::class, 'scan']);
    Route::post('/scan-documents/{scanDocument}/rows', [ScanDocumentController::class, 'storeRow']);
    Route::put('/scan-documents/{scanDocument}/rows/{row}', [ScanDocumentController::class, 'updateRow']);
    Route::delete('/scan-documents/{scanDocument}/rows/{row}', [ScanDocumentController::class, 'destroyRow']);

    Route::post('/imports/preview', [ImportController::class, 'preview']);
    Route::post('/imports/check', [ImportController::class, 'check']);
    Route::post('/imports/commit', [ImportController::class, 'commit']);

    Route::middleware('admin')->group(function () {
        Route::apiResource('users', UserController::class)->except('show');
        Route::put('/settings', [SettingController::class, 'update']);
        Route::put('/network/base-url', [NetworkController::class, 'setBaseUrl']);
        Route::get('/fields/usage', [FieldController::class, 'usage']);
        Route::post('/fields/rename', [FieldController::class, 'rename']);
        Route::get('/backups', [BackupController::class, 'index']);
        Route::post('/backups', [BackupController::class, 'store']);
        Route::get('/backups/{file}', [BackupController::class, 'download'])->where('file', 'backup-[\w.-]+\.zip');
        Route::post('/backups/delete', [DangerZoneController::class, 'deleteBackups']);
        Route::get('/danger', [DangerZoneController::class, 'index']);
        Route::post('/danger/clear', [DangerZoneController::class, 'clear']);
        Route::put('/network/devices/{device}', [NetworkController::class, 'updateDevice']);
        Route::delete('/network/devices/{device}', [NetworkController::class, 'destroyDevice']);
    });
});
