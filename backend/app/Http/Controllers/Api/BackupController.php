<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Setting;
use App\Services\BackupManager;
use Illuminate\Validation\ValidationException;
use RuntimeException;

class BackupController extends Controller
{
    public function index(BackupManager $backups)
    {
        return [
            'folder' => $backups->folder(),
            'folder_writable' => is_dir($backups->folder()) ? is_writable($backups->folder()) : is_writable(dirname($backups->folder())),
            'last_backup_at' => Setting::get('last_backup_at'),
            'backups' => $backups->list(),
        ];
    }

    public function store(BackupManager $backups)
    {
        try {
            return $backups->create('manual');
        } catch (RuntimeException $e) {
            throw ValidationException::withMessages(['backup' => $e->getMessage()]);
        }
    }

    public function download(BackupManager $backups, string $file)
    {
        try {
            return response()->download($backups->path($file));
        } catch (RuntimeException) {
            abort(404);
        }
    }
}
