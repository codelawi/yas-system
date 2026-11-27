<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * How an issue voucher is printed on A5 paper. The header and footer are HTML from the editor and
 * repeat on every page; placeholders are `<span data-field="...">`: recipient, number, date, page,
 * pages, or `f:<key>` for one of the template's own fields (typed on each voucher).
 * Between them, the table of equipment: fixed columns whose titles and widths can change.
 */
class VoucherTemplate extends Model
{
    /** The table's columns, in order. */
    public const COLUMNS = ['code', 'name', 'quantity', 'quantity_words'];

    protected $fillable = ['name', 'is_default', 'header', 'footer', 'item_table', 'fields', 'style'];

    protected $casts = ['is_default' => 'boolean', 'item_table' => 'array', 'fields' => 'array', 'style' => 'array'];

    public function vouchers(): HasMany
    {
        return $this->hasMany(Voucher::class, 'template_id');
    }

    /** The template a voucher uses: its own, else the default one (made from the paper voucher if there is none). */
    public static function current(?int $id = null): self
    {
        return ($id ? static::find($id) : null)
            ?? static::where('is_default', true)->orderBy('id')->first()
            ?? static::orderBy('id')->first()
            ?? static::create(['is_default' => true] + self::builtIn());
    }

    /** What is printed: kept on the voucher when it is issued. */
    public function layout(): array
    {
        return [
            'template_id' => $this->id,
            'name' => $this->name,
            'header' => (string) $this->header,
            'footer' => (string) $this->footer,
            'item_table' => $this->item_table,
            'fields' => $this->fields ?? [],
            'style' => $this->style,
        ];
    }

    /**
     * The paper voucher (سند صرف فرعي) as a template: title, recipient and numbers above the
     * table, two signatories below it.
     *
     * @return array{name: string, header: string, footer: string, item_table: array<string, mixed>, fields: array<int, array{key: string, label: string}>, style: array<string, int>}
     */
    public static function builtIn(): array
    {
        $field = fn (string $key, string $label) => '<span data-field="'.$key.'">'.$label.'</span>';

        return [
            'name' => 'سند صرف فرعي',
            'header' => '<table data-borders="none"><tbody><tr>'
                .'<td><p><strong><u>سند صرف فرعي</u></strong></p>'
                .'<p>الى / <strong>'.$field('recipient', 'المستلم').'</strong></p>'
                .'<p>بواسطة الموقعين ادناه</p></td>'
                .'<td><p>رقم السند: '.$field('number', 'رقم السند').'</p>'
                .'<p>رقم الصفحة: '.$field('page', 'رقم الصفحة').'</p>'
                .'<p>عدد صفحات السند: '.$field('pages', 'عدد الصفحات').'</p>'
                .'<p>التاريخ: '.$field('date', 'التاريخ').' م</p></td>'
                .'</tr></tbody></table>',
            'footer' => '<table data-borders="none"><tbody><tr>'
                .'<td><p style="text-align: center"><strong>أمين المستودع</strong></p>'
                .'<p style="text-align: center">'.$field('f:storekeeper', 'اسم أمين المستودع').'</p>'
                .'<p style="text-align: center">التوقيع: ................</p></td>'
                .'<td><p style="text-align: center"><strong>المستلم</strong></p>'
                .'<p style="text-align: center">'.$field('f:receiver', 'اسم المستلم').'</p>'
                .'<p style="text-align: center">التوقيع: ................</p></td>'
                .'</tr></tbody></table>',
            'item_table' => self::defaultTable(),
            'fields' => [
                ['key' => 'storekeeper', 'label' => 'اسم أمين المستودع'],
                ['key' => 'receiver', 'label' => 'اسم المستلم'],
            ],
            'style' => self::defaultStyle(),
        ];
    }

    /** @return array{columns: array<int, array{key: string, title: string, width: int, show: bool}>, quantity_group: string, no_code: string} */
    public static function defaultTable(): array
    {
        return [
            'columns' => [
                ['key' => 'code', 'title' => 'الحرف والرقم', 'width' => 24, 'show' => true],
                ['key' => 'name', 'title' => 'النوع', 'width' => 46, 'show' => true],
                ['key' => 'quantity', 'title' => 'رقماً', 'width' => 10, 'show' => true],
                ['key' => 'quantity_words', 'title' => 'كتابةً', 'width' => 20, 'show' => true],
            ],
            // Over the two quantity columns ('' = no title row above them)
            'quantity_group' => 'الكمية',
            // Main equipment whose group has no code yet
            'no_code' => 'بلا',
        ];
    }

    /** Font size (pt), height of an empty row and page margin (mm). */
    public static function defaultStyle(): array
    {
        return ['font_size' => 11, 'row_height' => 8, 'margin' => 8];
    }
}
