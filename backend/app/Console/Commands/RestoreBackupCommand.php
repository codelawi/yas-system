<?php

namespace App\Console\Commands;

use App\Services\BackupManager;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;

#[Signature('repo:restore {file? : Backup zip name (in the backup folder) or full path} {--force : Do not ask for confirmation}')]
#[Description('Restore a backup (a safety backup of the current data is made first)')]
class RestoreBackupCommand extends Command
{
    public function handle(BackupManager $backups): int
    {
        $list = $backups->list();
        $file = $this->argument('file') ?? ($list ? $this->choice('Which backup?', array_column($list, 'file'), 0) : null);
        if (! $file) {
            $this->error('No backups found in '.$backups->folder());

            return self::FAILURE;
        }
        $path = is_file($file) ? $file : $backups->path($file);

        if (! $this->option('force') && ! $this->confirm("Replace ALL current data with {$file}? (a safety backup is made first)")) {
            return self::FAILURE;
        }

        $safety = $backups->restore($path);
        $this->info("Restored {$file}. The data from before the restore is in {$safety}.");

        return self::SUCCESS;
    }
}
