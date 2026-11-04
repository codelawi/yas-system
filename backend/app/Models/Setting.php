<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Setting extends Model
{
    public $timestamps = false;

    public $incrementing = false;

    protected $primaryKey = 'key';

    protected $keyType = 'string';

    protected $fillable = ['key', 'value'];

    public const DEFAULTS = [
        // Base URL printed inside QR codes, e.g. http://192.168.1.10
        'base_url' => '',
        'label_width_mm' => '50',
        'label_height_mm' => '30',
        // Header names that mean "serial number" in Word tables (one per line)
        'serial_aliases' => "الرقم التسلسلي\nالرقم التسلسلى\nرقم تسلسلي\nSerial Number\nSerial No\nSerial\nSN\nS/N",
        // Header names of the row-number column («ت») in Word tables (one per line)
        'row_no_aliases' => "ت\nم\nتسلسل\nالتسلسل\nمسلسل\n#\nNo\nNo.",
        'company_name' => '',
        // Words that mark equipment as "needs attention" on the home page (one per line)
        'attention_words' => "يحتاج صيانة\nتالف\nمعطل\nمفقود\nعطل",
        // What is printed on a label next to the QR ('1' / '0')
        'label_show_company' => '1',
        'label_show_name' => '1',
        'label_show_parent' => '1',
        'label_show_row_no' => '1',
        // JSON label design from the QR page designer ('' = built-in default design)
        'label_template' => '',
        // Backups: folder (empty = storage/app/backups), how many to keep, last run
        'backup_path' => '',
        'backup_keep' => '30',
        'last_backup_at' => '',
        // JSON {QR address: labels printed with it} — written when labels are printed
        'labels_printed' => '{}',
    ];

    public static function allValues(): array
    {
        $stored = static::query()->pluck('value', 'key')->all();

        return array_merge(self::DEFAULTS, array_intersect_key($stored, self::DEFAULTS));
    }

    public static function get(string $key): ?string
    {
        return static::find($key)?->value ?? (self::DEFAULTS[$key] ?? null);
    }
}
