<?php

namespace App\Console\Commands;

use App\Services\BackupManager;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;

#[Signature('repo:backup {--reason=manual : Word added to the file name}')]
#[Description('Back up the database and the original Word files into the backup folder')]
class BackupCommand extends Command
{
    public function handle(BackupManager $backups): int
    {
        $backup = $backups->create($this->option('reason'));
        $this->info("Backup created: {$backups->folder()}/{$backup['file']} (".round($backup['size'] / 1024).' KB)');

        return self::SUCCESS;
    }
}
