<?php

namespace App\Support;

use App\Http\Controllers\Api\EquipmentController;
use App\Models\Custody;
use App\Models\EquipmentField;
use App\Models\Setting;
use RuntimeException;
use ZipArchive;

/**
 * Values printed on a custody form, and filling {{tags}} inside Word/Excel templates.
 * Built-in values have an id (used by the visual designer) and an Arabic tag (used in Word/Excel);
 * any equipment field name also works as a tag, e.g. {{مضخة يدوية}}.
 */
class CustodyFormData
{
    public const TAGS = [
        'serial_number' => 'الرقم التسلسلي',
        'display_name' => 'اسم المعدة',
        'category' => 'الفئة',
        'row_no' => 'ت',
        'parent_serial' => 'المعدة الأم',
        'accessories' => 'الملحقات',
        'holder' => 'المستلم',
        'holder_phone' => 'هاتف المستلم',
        'holder_id_number' => 'رقم هوية المستلم',
        'holder_department' => 'جهة المستلم',
        'handed_at' => 'تاريخ التسليم',
        'due_back_at' => 'تاريخ الإرجاع',
        'custody_notes' => 'ملاحظات',
        'handed_by' => 'المسلم',
        'custody_no' => 'رقم السند',
        'company' => 'الشركة',
        'today' => 'التاريخ',
    ];

    /** Files inside a .docx / .xlsx that may hold tags. */
    private const PARTS = [
        'docx' => '#^word/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$#',
        'xlsx' => '#^xl/(sharedStrings|worksheets/sheet\d+)\.xml$#',
    ];

    /** XML tags that may sit inside a {{tag}} when Word splits it into pieces (never across paragraphs/cells). */
    private const INNER_XML = '<(?!/?(?:w:p|w:tc|si|c|row)[\s>\/])[^>]*>';

    /**
     * @return array{values: array<string, string>, fields: array<string, string>, serial_number: string}
     */
    public static function for(Custody $custody): array
    {
        $custody->loadMissing(['equipment.fields', 'equipment.parent:id,serial_number', 'handedBy:id,name']);
        $equipment = $custody->equipment;

        // Accessories handed over together with it (same hand-over)
        $accessoryIds = $equipment->accessories()->pluck('id');
        $accessories = $accessoryIds->isEmpty() ? collect() : Custody::with('equipment.fields')
            ->whereIn('equipment_id', $accessoryIds)
            ->where('holder', $custody->holder)
            ->where('handed_at', $custody->handed_at)
            ->get()
            ->map(fn (Custody $c) => trim($c->equipment->serial_number.' — '.EquipmentController::displayName($c->equipment), ' —'));

        $values = [
            'serial_number' => $equipment->serial_number,
            'display_name' => EquipmentController::displayName($equipment),
            'category' => $equipment->category,
            'row_no' => $equipment->row_no,
            'parent_serial' => $equipment->parent?->serial_number,
            'accessories' => $accessories->implode("\n"),
            'holder' => $custody->holder,
            'holder_phone' => $custody->holder_phone,
            'holder_id_number' => $custody->holder_id_number,
            'holder_department' => $custody->holder_department,
            'handed_at' => $custody->handed_at?->format('Y-m-d'),
            'due_back_at' => $custody->due_back_at?->format('Y-m-d'),
            'custody_notes' => $custody->notes,
            'handed_by' => $custody->handedBy?->name,
            'custody_no' => (string) $custody->id,
            'company' => Setting::get('company_name'),
            'today' => now()->format('Y-m-d'),
        ];

        return [
            'values' => array_map(fn ($v) => (string) ($v ?? ''), $values),
            'fields' => collect($equipment->fieldList())->mapWithKeys(fn (array $f) => [$f['key'] => (string) $f['value']])->all(),
            'serial_number' => $equipment->serial_number,
        ];
    }

    /**
     * Tags written in a Word/Excel template, and whether the system knows them.
     *
     * @return array<int, array{tag: string, known: string}> known: builtin | field | unknown
     */
    public static function tagsIn(string $path, string $kind): array
    {
        $found = [];
        self::eachPart($path, $kind, function (string $xml) use (&$found) {
            preg_match_all(self::pattern(), $xml, $matches);
            foreach ($matches[1] as $inner) {
                $found[self::tagName($inner)] = true;
            }

            return null;
        });

        $builtin = array_flip(array_map([self::class, 'normalize'], self::TAGS));
        $fieldKeys = EquipmentField::query()->distinct()->pluck('key')->map([self::class, 'normalize'])->flip();

        return collect(array_keys($found))->filter()->map(fn (string $tag) => [
            'tag' => $tag,
            'known' => isset($builtin[self::normalize($tag)]) ? 'builtin' : ($fieldKeys->has(self::normalize($tag)) ? 'field' : 'unknown'),
        ])->values()->all();
    }

    /**
     * Copy of the template with every {{tag}} replaced (unknown tags become empty).
     *
     * @param  array{values: array<string, string>, fields: array<string, string>}  $data
     */
    public static function fill(string $path, string $kind, array $data): string
    {
        $lookup = [];
        foreach ($data['fields'] as $key => $value) {
            $lookup[self::normalize($key)] = $value;
        }
        foreach (self::TAGS as $id => $tag) {
            $lookup[self::normalize($tag)] = $data['values'][$id] ?? '';
        }

        $out = tempnam(sys_get_temp_dir(), 'form');
        copy($path, $out);
        self::eachPart($out, $kind, fn (string $xml) => preg_replace_callback(self::pattern(), function (array $m) use ($lookup, $kind) {
            $value = htmlspecialchars($lookup[self::normalize(self::tagName($m[1]))] ?? '', ENT_XML1 | ENT_QUOTES, 'UTF-8');

            return $kind === 'docx'
                ? str_replace("\n", '</w:t><w:br/><w:t xml:space="preserve">', $value)
                : $value;
        }, $xml));

        return $out;
    }

    /** Runs $callback on each XML part; a string result replaces the part. */
    private static function eachPart(string $path, string $kind, callable $callback): void
    {
        $zip = new ZipArchive;
        if ($zip->open($path) !== true) {
            throw new RuntimeException('form_bad_file');
        }
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $name = $zip->getNameIndex($i);
            if (! preg_match(self::PARTS[$kind], $name)) {
                continue;
            }
            $result = $callback($zip->getFromIndex($i));
            if (is_string($result)) {
                $zip->addFromString($name, $result);
            }
        }
        $zip->close();
    }

    /** {{ … }} — the braces and the name may be split over several Word/Excel text runs. */
    private static function pattern(): string
    {
        $x = self::INNER_XML;

        return "~\\{(?:$x)*\\{((?:[^{}<]|$x)*?)\\}(?:$x)*\\}~u";
    }

    private static function tagName(string $inner): string
    {
        return trim(html_entity_decode(strip_tags($inner), ENT_QUOTES | ENT_XML1, 'UTF-8'));
    }

    public static function normalize(string $text): string
    {
        return mb_strtolower(preg_replace('/[\s_]+/u', ' ', trim($text)));
    }
}
