<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\NetworkDevice;
use App\Models\Setting;
use App\Support\QrAddress;
use App\Support\ServerNetwork;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

class NetworkController extends Controller
{
    public function index(Request $request)
    {
        $addresses = ServerNetwork::addresses();
        $baseUrl = Setting::get('base_url');
        $hostname = gethostname() ?: null;

        return [
            'hostname' => $hostname,
            'addresses' => $addresses,
            'base_url' => $baseUrl,
            // Does the address printed in QR labels still lead to this computer?
            'base_url_status' => QrAddress::status($baseUrl),
            'labels_printed' => QrAddress::printed(),
            'os' => PHP_OS_FAMILY,
            'your_ip' => ServerNetwork::clientIp($request),
            'devices' => NetworkDevice::with('lastUser:id,name')->orderByDesc('last_seen_at')->limit(200)->get(),
        ];
    }

    /** Does this address (e.g. a DNS name IT created) lead to this computer? */
    public function checkAddress(Request $request)
    {
        $data = $request->validate(['url' => ['required', 'string', 'max:255', 'regex:#^https?://[^\s/]+$#i']]);

        return ['status' => QrAddress::status(rtrim($data['url'], '/'))];
    }

    public function ping()
    {
        return ['ok' => true, 'time' => now()];
    }

    public function setBaseUrl(Request $request)
    {
        $data = $request->validate([
            'base_url' => ['required', 'string', 'max:255', 'regex:#^https?://[^\s/]+$#i'],
            'confirm_base_url' => ['nullable', 'string', 'max:255'],
        ]);
        QrAddress::guardChange($data['base_url'], $data['confirm_base_url'] ?? null);
        Setting::updateOrCreate(['key' => 'base_url'], ['value' => rtrim($data['base_url'], '/')]);

        return Setting::allValues();
    }

    public function updateDevice(Request $request, NetworkDevice $device)
    {
        $data = $request->validate([
            'name' => ['nullable', 'string', 'max:100'],
            'blocked' => ['boolean'],
        ]);

        if (! empty($data['blocked']) && (ServerNetwork::isServerAddress($device->ip) || $device->ip === ServerNetwork::clientIp($request))) {
            throw ValidationException::withMessages(['blocked' => 'cannot_block_self']);
        }

        $device->update($data);
        NetworkDevice::forgetCache($device->ip);

        return $device->load('lastUser:id,name');
    }

    public function destroyDevice(NetworkDevice $device)
    {
        $device->delete();
        NetworkDevice::forgetCache($device->ip);

        return response()->noContent();
    }
}
