<?php

namespace App\Console\Commands;

use App\Models\Setting;
use App\Support\QrAddress;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Validation\ValidationException;

#[Signature('repo:qr-address {url? : e.g. http://repo.company.lan or http://192.168.1.10 (empty = show the current one)} {--force : Save even if the address does not lead to this computer} {--confirm= : Type the new address again when labels were already printed}')]
#[Description('Show or set the address printed inside QR codes')]
class QrAddressCommand extends Command
{
    public function handle(): int
    {
        $current = QrAddress::current();
        $printed = QrAddress::printed()[$current] ?? 0;
        $url = $this->argument('url');

        if ($url === null) {
            $this->line('QR address: '.($current ?: '(not set)').' - status: '.QrAddress::status().($printed ? " - {$printed} labels printed" : ''));

            return self::SUCCESS;
        }

        $url = rtrim(trim($url), '/');
        if (! preg_match('#^https?://[^\s/]+$#i', $url)) {
            $this->error('Invalid address. Example: http://repo.company.lan');

            return self::FAILURE;
        }

        $status = QrAddress::status($url);
        if ($status !== 'ok' && ! $this->option('force')) {
            $this->error("{$url} does not lead to this computer (status: {$status}). Fix the DNS record / IP first, or use --force.");

            return self::FAILURE;
        }

        try {
            QrAddress::guardChange($url, $this->option('confirm'));
        } catch (ValidationException) {
            $this->error("{$printed} labels were printed with {$current}. Changing it breaks them. To really change it add: --confirm={$url}");

            return self::FAILURE;
        }

        Setting::updateOrCreate(['key' => 'base_url'], ['value' => $url]);
        $this->info("QR address set to {$url}");

        return self::SUCCESS;
    }
}
