<?php

namespace App\Console\Commands;

use App\Support\PrintStation;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;

#[Signature('repo:print-station {--base=http://127.0.0.1:8000 : Where this PC reaches the system}')]
#[Description('Print the print station address (with its key), where its open requests appear and whether it is open; used by START.bat')]
class PrintStationUrl extends Command
{
    public function handle(): int
    {
        $this->line('Print station: '.PrintStation::url((string) $this->option('base')));
        $this->line('Open requests: '.PrintStation::openRequestFile());
        $this->line('Open now: '.(PrintStation::online() ? 'yes' : 'no'));

        return self::SUCCESS;
    }
}
