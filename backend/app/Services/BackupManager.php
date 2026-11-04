<?php

namespace App\Services;

use App\Models\Setting;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use RuntimeException;
use Throwable;
use ZipArchive;

/**
 * Backups = one zip per backup with the full database (database.sql), the
 * original Word files (imports/) and a manifest. Kept in the backup folder
 * from the settings; the oldest are removed beyond the "keep" limit.
 */
class BackupManager
{
    /** Hours between automatic backups. */
    public const AUTO_EVERY_HOURS = 24;

    public function __construct(private SqlDumper $dumper) {}

    public function folder(): string
    {
        $folder = trim((string) Setting::get('backup_path'));

        return rtrim($folder !== '' ? $folder : storage_path('app/backups'), '/\\');
    }

    /**
     * @return array{file: string, size: int, tables: int, created_at: string}
     */
    public function create(string $reason = 'manual'): array
    {
        $folder = $this->folder();
        if (! is_dir($folder) && ! @mkdir($folder, 0775, true) && ! is_dir($folder)) {
            throw new RuntimeException('backup_folder_not_writable');
        }
        if (! is_writable($folder)) {
            throw new RuntimeException('backup_folder_not_writable');
        }

        $name = 'backup-'.now()->format('Y-m-d_His').'-'.Str::slug($reason).'.zip';
        $sqlFile = tempnam(sys_get_temp_dir(), 'repo-sql');
        $tables = $this->dumper->dump($sqlFile);

        $zip = new ZipArchive;
        $tmpZip = $folder.DIRECTORY_SEPARATOR.$name.'.part';
        if ($zip->open($tmpZip, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            @unlink($sqlFile);
            throw new RuntimeException('backup_folder_not_writable');
        }
        $zip->addFile($sqlFile, 'database.sql');
        $files = 0; // Word files + damage-report photos + custody form templates + equipment photos
        foreach ([...Storage::files('imports'), ...Storage::files('issues'), ...Storage::files('custody_forms'), ...Storage::files('equipment_photos')] as $file) {
            $zip->addFile(Storage::path($file), $file);
            $files++;
        }
        $zip->addFromString('manifest.json', json_encode([
            'app' => 'equipment-repository',
            'created_at' => now()->toIso8601String(),
            'reason' => $reason,
            'tables' => $tables,
            'word_files' => $files,
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
        $zip->close();
        @unlink($sqlFile);
        // Renamed only when complete, so a half-written zip is never listed
        rename($tmpZip, $folder.DIRECTORY_SEPARATOR.$name);

        Setting::updateOrCreate(['key' => 'last_backup_at'], ['value' => now()->toIso8601String()]);
        $this->prune();

        return ['file' => $name, 'size' => filesize($folder.DIRECTORY_SEPARATOR.$name), 'tables' => $tables, 'created_at' => now()->toIso8601String()];
    }

    /** @return array<int, array{file: string, size: int, created_at: string}> newest first */
    public function list(): array
    {
        $files = glob($this->folder().DIRECTORY_SEPARATOR.'backup-*.zip') ?: [];
        usort($files, fn ($a, $b) => filemtime($b) <=> filemtime($a));

        return array_map(fn ($f) => [
            'file' => basename($f),
            'size' => filesize($f),
            'created_at' => date(DATE_ATOM, filemtime($f)),
        ], $files);
    }

    /** Full path of a backup, refusing anything outside the backup folder. */
    public function path(string $file): string
    {
        if (! preg_match('/^backup-[\w.-]+\.zip$/', $file)) {
            throw new RuntimeException('backup_not_found');
        }
        $path = $this->folder().DIRECTORY_SEPARATOR.$file;
        if (! is_file($path)) {
            throw new RuntimeException('backup_not_found');
        }

        return $path;
    }

    /**
     * Restores a backup. A safety backup of the current state is made first,
     * so a restore itself can never lose data. Returns that safety backup's name.
     */
    public function restore(string $zipPath): string
    {
        $zip = new ZipArchive;
        if ($zip->open($zipPath) !== true || $zip->locateName('database.sql') === false) {
            throw new RuntimeException('invalid_backup');
        }

        $safety = $this->create('before-restore')['file'];

        $sqlFile = tempnam(sys_get_temp_dir(), 'repo-restore');
        file_put_contents($sqlFile, $zip->getFromName('database.sql'));
        $this->dumper->restore($sqlFile);
        @unlink($sqlFile);

        // Word files: add back the ones from the backup (current files are kept)
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $name = $zip->getNameIndex($i);
            if (preg_match('#^(imports|issues|custody_forms|equipment_photos)/[^/]+$#', $name) && ! Storage::exists($name)) {
                Storage::put($name, $zip->getFromIndex($i));
            }
        }
        $zip->close();
        Cache::flush();

        return $safety;
    }

    /** Runs the automatic backup when the last one is older than AUTO_EVERY_HOURS. */
    public function runIfDue(): void
    {
        $last = Setting::get('last_backup_at');
        if ($last && now()->diffInHours($last, true) < self::AUTO_EVERY_HOURS) {
            return;
        }
        // Only one request does it
        $lock = Cache::lock('auto-backup', 600);
        if (! $lock->get()) {
            return;
        }
        try {
            $this->create('auto');
        } catch (Throwable $e) {
            report($e);
        } finally {
            $lock->release();
        }
    }

    private function prune(): void
    {
        $keep = max(1, (int) Setting::get('backup_keep'));
        foreach (array_slice($this->list(), $keep) as $old) {
            @unlink($this->folder().DIRECTORY_SEPARATOR.$old['file']);
        }
    }
}
