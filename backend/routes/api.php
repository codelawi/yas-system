<?php

use App\Http\Controllers\Api\ActivityController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\BackupController;
use App\Http\Controllers\Api\CustodyController;
use App\Http\Controllers\Api\CustodyFormController;
use App\Http\Controllers\Api\DangerZoneController;
use App\Http\Controllers\Api\EquipmentController;
use App\Http\Controllers\Api\FieldController;
use App\Http\Controllers\Api\ImportController;
use App\Http\Controllers\Api\IssueController;
use App\Http\Controllers\Api\MaintenanceController;
use App\Http\Controllers\Api\NetworkController;
use App\Http\Controllers\Api\SettingController;
use App\Http\Controllers\Api\StocktakeController;
use App\Http\Controllers\Api\UserController;
use Illuminate\Support\Facades\Route;

// Viewing is open to everyone on the network; changes need a PIN.
Route::post('/auth/login', [AuthController::class, 'login'])->middleware('throttle:10,1');

Route::get('/settings', [SettingController::class, 'index']);
Route::get('/stats', [EquipmentController::class, 'stats']);
Route::get('/equipment', [EquipmentController::class, 'index']);
Route::get('/equipment/labels', [EquipmentController::class, 'labels']);
Route::get('/equipment/categories', [EquipmentController::class, 'categories']);
Route::get('/equipment/keys', [EquipmentController::class, 'keys']);
Route::get('/equipment/values', [EquipmentController::class, 'values']);
Route::get('/equipment/serial/{serial}', [EquipmentController::class, 'bySerial'])->where('serial', '.*');
Route::get('/equipment/{equipment}', [EquipmentController::class, 'show'])->whereNumber('equipment');
Route::get('/imports', [ImportController::class, 'index']);
Route::get('/imports/{import}/download', [ImportController::class, 'download']);
Route::get('/network', [NetworkController::class, 'index']);

// Maintenance dates and damage reports are visible to everyone; anyone can report a problem
Route::get('/equipment/{equipment}/maintenance', [MaintenanceController::class, 'index'])->whereNumber('equipment');
Route::get('/maintenance/due', [MaintenanceController::class, 'due']);
Route::get('/equipment/{equipment}/issues', [IssueController::class, 'equipmentIndex'])->whereNumber('equipment');
Route::post('/equipment/{equipment}/issues', [IssueController::class, 'store'])->whereNumber('equipment')->middleware('throttle:10,1');
Route::get('/issues', [IssueController::class, 'index']);
Route::get('/issues/{issue}/photo', [IssueController::class, 'photo']);
Route::get('/network/ping', [NetworkController::class, 'ping']);
Route::get('/network/check-address', [NetworkController::class, 'checkAddress'])->middleware('throttle:30,1');
Route::post('/labels/printed', [SettingController::class, 'labelsPrinted'])->middleware('throttle:30,1');

Route::middleware('auth:sanctum')->group(function () {
    Route::get('/auth/me', [AuthController::class, 'me']);
    Route::get('/activity', [ActivityController::class, 'index']);
    Route::get('/activity/export', [ActivityController::class, 'export']);
    Route::get('/equipment/export', [EquipmentController::class, 'export']);
    Route::post('/auth/logout', [AuthController::class, 'logout']);

    Route::post('/equipment', [EquipmentController::class, 'store']);
    Route::post('/equipment/bulk-delete', [EquipmentController::class, 'bulkDestroy']);
    Route::post('/equipment/bulk-update', [FieldController::class, 'bulkUpdate']);
    Route::put('/equipment/{equipment}', [EquipmentController::class, 'update']);
    Route::delete('/equipment/{equipment}', [EquipmentController::class, 'destroy']);

    Route::post('/equipment/{equipment}/maintenance', [MaintenanceController::class, 'store']);
    Route::post('/equipment/{equipment}/maintenance-records', [MaintenanceController::class, 'storeRecord']);
    Route::put('/maintenance/{schedule}', [MaintenanceController::class, 'update']);
    Route::delete('/maintenance/{schedule}', [MaintenanceController::class, 'destroy']);
    Route::post('/maintenance/{schedule}/complete', [MaintenanceController::class, 'complete']);

    Route::get('/custody', [CustodyController::class, 'index']);
    Route::get('/custody/holders', [CustodyController::class, 'holders']);
    Route::get('/equipment/{equipment}/custody', [CustodyController::class, 'equipmentIndex']);
    Route::post('/equipment/{equipment}/custody', [CustodyController::class, 'handOver']);
    Route::post('/equipment/{equipment}/custody/return', [CustodyController::class, 'receive']);
    Route::get('/custody-forms', [CustodyFormController::class, 'index']);
    Route::get('/custody-forms/{form}/file', [CustodyFormController::class, 'file']);
    Route::get('/custody-forms/{form}/tags', [CustodyFormController::class, 'tags']);
    Route::get('/custody-forms/{form}/fill/{custody}', [CustodyFormController::class, 'fill']);
    Route::get('/custodies/{custody}/form-data', [CustodyFormController::class, 'data']);

    Route::post('/issues/{issue}/close', [IssueController::class, 'close']);

    Route::get('/stocktakes', [StocktakeController::class, 'index']);
    Route::post('/stocktakes', [StocktakeController::class, 'store']);
    Route::get('/stocktakes/{stocktake}', [StocktakeController::class, 'show']);
    Route::delete('/stocktakes/{stocktake}', [StocktakeController::class, 'destroy']);
    Route::post('/stocktakes/{stocktake}/scan', [StocktakeController::class, 'scan']);
    Route::delete('/stocktakes/{stocktake}/scans/{scan}', [StocktakeController::class, 'destroyScan']);
    Route::post('/stocktakes/{stocktake}/close', [StocktakeController::class, 'close']);
    Route::get('/stocktakes/{stocktake}/export', [StocktakeController::class, 'export']);

    Route::post('/imports/preview', [ImportController::class, 'preview']);
    Route::post('/imports/check', [ImportController::class, 'check']);
    Route::post('/imports/commit', [ImportController::class, 'commit']);

    Route::middleware('admin')->group(function () {
        Route::apiResource('users', UserController::class)->except('show');
        Route::put('/settings', [SettingController::class, 'update']);
        Route::post('/custody-forms', [CustodyFormController::class, 'store']);
        Route::put('/custody-forms/{form}', [CustodyFormController::class, 'update']);
        Route::delete('/custody-forms/{form}', [CustodyFormController::class, 'destroy']);
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
