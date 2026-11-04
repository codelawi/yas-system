<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Setting;
use App\Support\QrAddress;
use Illuminate\Http\Request;

class SettingController extends Controller
{
    public function index()
    {
        return Setting::allValues();
    }

    /** Called by the print page after the print dialog: counts labels printed per QR address. */
    public function labelsPrinted(Request $request)
    {
        $data = $request->validate([
            'url' => ['required', 'string', 'max:255', 'regex:#^https?://[^\s/]+/?$#i'],
            'count' => ['required', 'integer', 'min:1', 'max:5000'],
        ]);
        QrAddress::recordPrinted($data['url'], $data['count']);

        return ['printed' => QrAddress::printed()];
    }

    /** Partial update: the QR page and the Settings page each send only their own keys. */
    public function update(Request $request)
    {
        $data = $request->validate([
            'base_url' => ['sometimes', 'nullable', 'string', 'max:255', 'regex:#^(https?://[^\s/]+)?/?$#i'],
            'label_width_mm' => ['sometimes', 'required', 'numeric', 'min:10', 'max:300'],
            'label_height_mm' => ['sometimes', 'required', 'numeric', 'min:10', 'max:300'],
            'serial_aliases' => ['sometimes', 'required', 'string', 'max:2000'],
            'row_no_aliases' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'attention_words' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'company_name' => ['sometimes', 'nullable', 'string', 'max:255'],
            'label_show_company' => ['sometimes', 'boolean'],
            'label_show_name' => ['sometimes', 'boolean'],
            'label_show_parent' => ['sometimes', 'boolean'],
            'label_show_row_no' => ['sometimes', 'boolean'],
            'label_template' => ['sometimes', 'nullable', 'string', 'max:30000', 'json'],
            'confirm_base_url' => ['nullable', 'string', 'max:255'],
            'backup_path' => ['sometimes', 'nullable', 'string', 'max:500'],
            'backup_keep' => ['sometimes', 'required', 'integer', 'min:3', 'max:365'],
        ]);
        if (array_key_exists('base_url', $data)) {
            $data['base_url'] = rtrim((string) $data['base_url'], '/');
            QrAddress::guardChange($data['base_url'], $data['confirm_base_url'] ?? null);
        }
        unset($data['confirm_base_url']);

        foreach ($data as $key => $value) {
            Setting::updateOrCreate(['key' => $key], ['value' => is_bool($value) ? ($value ? '1' : '0') : (string) $value]);
        }

        return Setting::allValues();
    }
}
