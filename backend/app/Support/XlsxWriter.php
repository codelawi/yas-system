<?php

namespace App\Support;

use ZipArchive;

/**
 * Minimal .xlsx writer (one sheet, text and numbers, bold header row, frozen
 * header, auto-filter, right-to-left view). No external package needed.
 */
class XlsxWriter
{
    /**
     * @param  array<int, string>  $header
     * @param  iterable<array<int, mixed>>  $rows
     */
    public static function write(string $path, string $sheetName, array $header, iterable $rows, bool $rightToLeft = true): void
    {
        $xmlRows = [self::row(1, $header, true)];
        $widths = array_map(fn ($h) => mb_strlen((string) $h), $header);
        $r = 1;
        foreach ($rows as $row) {
            $r++;
            $xmlRows[] = self::row($r, $row);
            foreach (array_values($row) as $c => $value) {
                $longest = max(array_map('mb_strlen', explode("\n", (string) $value)) ?: [0]);
                $widths[$c] = max($widths[$c] ?? 0, $longest);
            }
        }

        $lastCol = self::column(max(1, count($header)));
        $cols = '';
        foreach ($widths as $c => $w) {
            $n = $c + 1;
            $cols .= '<col min="'.$n.'" max="'.$n.'" width="'.min(60, max(8, $w + 2)).'" customWidth="1"/>';
        }

        $sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            .'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            .'<sheetViews><sheetView workbookViewId="0"'.($rightToLeft ? ' rightToLeft="1"' : '').'>'
            .'<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
            .'<cols>'.$cols.'</cols>'
            .'<sheetData>'.implode('', $xmlRows).'</sheetData>'
            .'<autoFilter ref="A1:'.$lastCol.max(1, $r).'"/>'
            .'</worksheet>';

        $zip = new ZipArchive;
        $zip->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE);
        $zip->addFromString('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>');
        $zip->addFromString('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
        $zip->addFromString('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="'.self::escape(mb_substr($sheetName, 0, 31)).'" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\''.self::escape(mb_substr($sheetName, 0, 31)).'\'!$A$1:$'.$lastCol.'$'.max(1, $r).'</definedName></definedNames></workbook>');
        $zip->addFromString('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
        $zip->addFromString('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E2F3"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs></styleSheet>');
        $zip->addFromString('xl/worksheets/sheet1.xml', $sheet);
        $zip->close();
    }

    private static function row(int $r, array $values, bool $header = false): string
    {
        $cells = '';
        foreach (array_values($values) as $c => $value) {
            if ($value === null || $value === '') {
                continue;
            }
            $ref = self::column($c + 1).$r;
            if (! $header && (is_int($value) || is_float($value))) {
                $cells .= '<c r="'.$ref.'"><v>'.$value.'</v></c>';

                continue;
            }
            $text = (string) $value;
            $style = $header ? 1 : (str_contains($text, "\n") ? 2 : 0);
            $cells .= '<c r="'.$ref.'" t="inlineStr"'.($style ? ' s="'.$style.'"' : '').'><is><t xml:space="preserve">'.self::escape($text).'</t></is></c>';
        }

        return '<row r="'.$r.'">'.$cells.'</row>';
    }

    /** 1 → A, 27 → AA */
    public static function column(int $n): string
    {
        $s = '';
        while ($n > 0) {
            $m = ($n - 1) % 26;
            $s = chr(65 + $m).$s;
            $n = intdiv($n - 1, 26);
        }

        return $s;
    }

    private static function escape(string $text): string
    {
        // Characters XML does not allow
        $text = preg_replace('/[^\x{9}\x{A}\x{D}\x{20}-\x{D7FF}\x{E000}-\x{FFFD}]/u', '', $text) ?? '';

        return htmlspecialchars($text, ENT_XML1 | ENT_QUOTES, 'UTF-8');
    }
}
