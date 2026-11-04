<?php

namespace App\Services;

use DOMDocument;
use DOMElement;
use DOMXPath;
use RuntimeException;
use ZipArchive;

/**
 * Reads every top-level table in a .docx file and turns it into equipment items.
 *
 * Two table layouts are supported, detected per table:
 *  - Horizontal: a header row holds the keys (one of them is the serial number
 *    column) and every row below it is one equipment.
 *  - Vertical: a Key | Value table (optionally Key | Value | Key | Value) that
 *    describes a single equipment.
 */
class WordTableParser
{
    private const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

    /** How many rows from the top of a table are searched for the header row. */
    private const HEADER_SEARCH_ROWS = 5;

    /** @var string[] normalized serial-number header names */
    private array $serialAliases;

    /** @var string[] normalized row-number («ت») header names */
    private array $rowNoAliases;

    /**
     * @param  string[]  $serialAliases
     * @param  string[]  $rowNoAliases
     */
    public function __construct(array $serialAliases, array $rowNoAliases = [])
    {
        $this->serialAliases = array_values(array_filter(array_map([self::class, 'normalize'], $serialAliases)));
        $this->rowNoAliases = array_values(array_filter(array_map([self::class, 'normalize'], $rowNoAliases)));
    }

    /** "١٢" / "12." / " 12 " → 12; anything that is not a plain number → null */
    public static function parseRowNo(?string $text): ?int
    {
        $text = strtr(trim((string) $text), [
            '٠' => '0', '١' => '1', '٢' => '2', '٣' => '3', '٤' => '4', '٥' => '5', '٦' => '6', '٧' => '7', '٨' => '8', '٩' => '9',
            '۰' => '0', '۱' => '1', '۲' => '2', '۳' => '3', '۴' => '4', '۵' => '5', '۶' => '6', '۷' => '7', '۸' => '8', '۹' => '9',
        ]);
        $text = rtrim($text, '.-)');

        return preg_match('/^\d{1,9}$/', $text) ? (int) $text : null;
    }

    /**
     * @return array{tables: int, items: array<int, array{table: int, row: ?int, row_no: ?int, serial: ?string, fields: array<int, array{key: string, value: string}>}>, warnings: string[]}
     */
    public function parse(string $path): array
    {
        $tables = $this->readTables($path);
        $items = [];
        $warnings = [];

        foreach ($tables as $index => $table) {
            $tableNo = $index + 1;
            $grid = $this->dropEmptyRows($table['grid']);
            if (! $grid) {
                continue;
            }

            $headerRow = $this->findHeaderRow($grid);
            if ($headerRow !== null) {
                array_push($items, ...$this->parseHorizontal($grid, $headerRow, $tableNo));
            } elseif ($this->looksVertical($grid)) {
                $item = $this->parseVertical($grid, $tableNo);
                if ($item['serial'] === null) {
                    $warnings[] = "table_no_serial:$tableNo";
                }
                $items[] = $item;
            } else {
                // Unknown layout: treat the first row as the header so the user
                // can still review the rows and type the serials by hand.
                $warnings[] = "table_no_serial:$tableNo";
                array_push($items, ...$this->parseHorizontal($grid, 0, $tableNo));
            }
        }

        if (! $tables) {
            $warnings[] = 'no_tables';
        }

        return ['tables' => count($tables), 'items' => $items, 'warnings' => $warnings];
    }

    /**
     * Raw tables (for showing them in the browser) plus the detected mapping of
     * each table, in the same shape the table mapper edits.
     *
     * @return array<int, array{index: int, title: ?string, grid: array<int, array<int, string>>, spans: array<int, array{0: int, 1: int, 2: int}>, vmerged: array<int, array{0: int, 1: int}>, detected: array<string, mixed>}>
     */
    public function analyze(string $path): array
    {
        $result = [];
        foreach ($this->readTables($path) as $index => $table) {
            $result[] = $table + ['index' => $index + 1, 'detected' => $this->detect($table['grid'])];
        }

        return $result;
    }

    /**
     * Guesses how a table is laid out.
     *
     * @param  array<int, array<int, string>>  $grid
     * @return array{layout: string, header_row: ?int, columns: array<int, array{role: string, key: string}>, pair_roles: array<string, string>}
     */
    private function detect(array $grid): array
    {
        $nonEmpty = array_filter($grid, fn ($row) => $this->nonEmptyCount($row) > 0);
        if (! $nonEmpty) {
            return ['layout' => 'ignore', 'header_row' => null, 'columns' => [], 'pair_roles' => []];
        }

        $headerRow = $this->findHeaderRow($nonEmpty);
        if ($headerRow === null && $this->looksVertical($nonEmpty)) {
            return ['layout' => 'pairs', 'header_row' => null, 'columns' => [], 'pair_roles' => $this->detectPairRoles($nonEmpty)];
        }

        // Unknown layout falls back to "first row is the header" without a serial column
        $headerRow ??= array_key_first($nonEmpty);
        $header = $grid[$headerRow];
        $serialCol = $this->serialColumn($header);
        $rowNoCol = $this->columnOf($header, $this->rowNoAliases);
        $columns = [];
        foreach ($this->buildKeys($header) as $c => $key) {
            $columns[$c] = [
                'role' => match ($c) {
                    $serialCol => 'serial',
                    $rowNoCol => 'row_no',
                    default => 'field',
                },
                'key' => $key,
            ];
        }

        return ['layout' => 'rows', 'header_row' => $headerRow, 'columns' => $columns, 'pair_roles' => []];
    }

    /**
     * @param  array<int, array<int, string>>  $grid
     * @return array<string, string> key text => role
     */
    private function detectPairRoles(array $grid): array
    {
        $roles = [];
        foreach ($grid as $row) {
            $cells = array_values(array_filter($row, fn ($c) => trim($c) !== ''));
            for ($i = 0; $i < count($cells); $i += 2) {
                $key = $this->cleanKey($cells[$i]);
                if ($key === '' || isset($roles[$key])) {
                    continue;
                }
                $normalized = self::normalize($key);
                $roles[$key] = match (true) {
                    ! in_array('serial', $roles, true) && in_array($normalized, $this->serialAliases, true) => 'serial',
                    ! in_array('row_no', $roles, true) && in_array($normalized, $this->rowNoAliases, true) && self::parseRowNo($cells[$i + 1] ?? '') !== null => 'row_no',
                    default => 'field',
                };
            }
        }

        return $roles;
    }

    /** Normalizes text for comparing header names (Arabic letter variants, case, spacing). */
    public static function normalize(?string $text): string
    {
        $text = (string) $text;
        $text = preg_replace('/[\x{064B}-\x{065F}\x{0670}\x{0640}]/u', '', $text); // diacritics + tatweel
        $text = strtr($text, ['أ' => 'ا', 'إ' => 'ا', 'آ' => 'ا', 'ى' => 'ي', 'ة' => 'ه']);
        $text = mb_strtolower($text);
        $text = preg_replace('/\s+/u', ' ', $text);

        return trim($text, " \t\n\r\0\x0B:：.-_");
    }

    // ---------------------------------------------------------------------
    // Layouts
    // ---------------------------------------------------------------------

    private function findHeaderRow(array $grid): ?int
    {
        foreach (array_slice($grid, 0, self::HEADER_SEARCH_ROWS, true) as $r => $row) {
            if ($this->serialColumn($row) !== null && $this->nonEmptyCount($row) > 2) {
                return $r;
            }
            // Only title rows (one merged cell) may sit above the header. A row with
            // several values means this is a Key | Value | Key | Value table instead.
            if ($this->nonEmptyCount($row) > 1) {
                return null;
            }
        }

        return null;
    }

    private function serialColumn(array $row): ?int
    {
        return $this->columnOf($row, $this->serialAliases);
    }

    private function columnOf(array $row, array $aliases): ?int
    {
        foreach ($row as $c => $cell) {
            if (in_array(self::normalize($cell), $aliases, true)) {
                return $c;
            }
        }

        return null;
    }

    private function parseHorizontal(array $grid, int $headerRow, int $tableNo): array
    {
        $header = $grid[$headerRow];
        $serialCol = $this->serialColumn($header);
        $rowNoCol = $this->columnOf($header, $this->rowNoAliases);
        $keys = $this->buildKeys($header);
        $headerSignature = array_map([self::class, 'normalize'], $header);
        $items = [];

        foreach (array_slice($grid, $headerRow + 1, null, true) as $r => $row) {
            // Header rows repeated on every page of a long table
            if (array_map([self::class, 'normalize'], $row) === $headerSignature) {
                continue;
            }

            $serial = $serialCol !== null ? trim($row[$serialCol] ?? '') : '';
            $rowNo = $rowNoCol !== null ? self::parseRowNo($row[$rowNoCol] ?? '') : null;
            $fields = [];
            foreach ($keys as $c => $key) {
                if ($c === $serialCol) {
                    continue;
                }
                // A row number is kept apart; text that is not a number stays a normal field
                if ($c === $rowNoCol && ($rowNo !== null || trim($row[$c] ?? '') === '')) {
                    continue;
                }
                $value = trim($row[$c] ?? '');
                if ($value !== '') {
                    $fields[] = ['key' => $key, 'value' => $value];
                }
            }

            if ($serial === '' && ! $fields) {
                continue;
            }

            $items[] = [
                'table' => $tableNo,
                'row' => $r + 1,
                'row_no' => $rowNo,
                'serial' => $serial !== '' ? $serial : null,
                'fields' => $fields,
            ];
        }

        return $items;
    }

    private function looksVertical(array $grid): bool
    {
        foreach ($grid as $row) {
            if ($this->nonEmptyCount($row) > 4) {
                return false;
            }
        }

        return true;
    }

    private function parseVertical(array $grid, int $tableNo): array
    {
        $serial = null;
        $rowNo = null;
        $fields = [];

        foreach ($grid as $row) {
            $cells = array_values(array_filter($row, fn ($c) => trim($c) !== ''));
            for ($i = 0; $i < count($cells); $i += 2) {
                $key = $this->cleanKey($cells[$i]);
                $value = trim($cells[$i + 1] ?? '');
                if ($key === '') {
                    continue;
                }
                if ($serial === null && in_array(self::normalize($key), $this->serialAliases, true)) {
                    $serial = $value !== '' ? $value : null;

                    continue;
                }
                if ($rowNo === null && in_array(self::normalize($key), $this->rowNoAliases, true) && self::parseRowNo($value) !== null) {
                    $rowNo = self::parseRowNo($value);

                    continue;
                }
                if ($value !== '') {
                    $fields[] = ['key' => $key, 'value' => $value];
                }
            }
        }

        return ['table' => $tableNo, 'row' => null, 'row_no' => $rowNo, 'serial' => $serial, 'fields' => $fields];
    }

    /** Header cells → unique, single-line keys. */
    private function buildKeys(array $header): array
    {
        $keys = [];
        $seen = [];
        foreach ($header as $c => $cell) {
            $key = $this->cleanKey($cell);
            if ($key === '') {
                $key = 'Column '.($c + 1);
            }
            $norm = self::normalize($key);
            $seen[$norm] = ($seen[$norm] ?? 0) + 1;
            if ($seen[$norm] > 1) {
                $key .= ' ('.$seen[$norm].')';
            }
            $keys[$c] = $key;
        }

        return $keys;
    }

    private function cleanKey(string $text): string
    {
        return trim(preg_replace('/\s+/u', ' ', $text), " \t\n\r\0\x0B:：");
    }

    private function nonEmptyCount(array $row): int
    {
        return count(array_filter($row, fn ($c) => trim($c) !== ''));
    }

    private function dropEmptyRows(array $grid): array
    {
        return array_values(array_filter($grid, fn ($row) => $this->nonEmptyCount($row) > 0));
    }

    // ---------------------------------------------------------------------
    // DOCX reading
    // ---------------------------------------------------------------------

    /**
     * @return array<int, array{title: ?string, grid: array<int, array<int, string>>, spans: array<int, array{0: int, 1: int, 2: int}>, vmerged: array<int, array{0: int, 1: int}>}>
     */
    private function readTables(string $path): array
    {
        $zip = new ZipArchive;
        if ($zip->open($path) !== true) {
            throw new RuntimeException('not_docx');
        }
        $xml = $zip->getFromName('word/document.xml');
        $zip->close();
        if ($xml === false) {
            throw new RuntimeException('not_docx');
        }

        $dom = new DOMDocument;
        $dom->loadXML($xml, LIBXML_NONET | LIBXML_COMPACT | LIBXML_PARSEHUGE);
        $xp = new DOMXPath($dom);
        $xp->registerNamespace('w', self::W);

        $tables = [];
        foreach ($xp->query('//w:body//w:tbl[not(ancestor::w:tbl)]') as $tbl) {
            $tables[] = $this->readTable($xp, $tbl) + ['title' => $this->tableTitle($xp, $tbl)];
        }

        return $tables;
    }

    /** The nearest non-empty paragraph above a table (usually its heading). */
    private function tableTitle(DOMXPath $xp, DOMElement $tbl): ?string
    {
        $p = $xp->query('preceding-sibling::*[1][self::w:p][normalize-space(.) != ""] | preceding-sibling::w:p[normalize-space(.) != ""][1]', $tbl)->item(0);
        $text = $p ? trim(preg_replace('/\s+/u', ' ', $p->textContent)) : '';

        return $text !== '' ? mb_substr($text, 0, 200) : null;
    }

    /** @return array{grid: array<int, array<int, string>>, spans: array<int, array{0: int, 1: int, 2: int}>, vmerged: array<int, array{0: int, 1: int}>} */
    private function readTable(DOMXPath $xp, DOMElement $tbl): array
    {
        $grid = [];
        $spans = [];
        $vmerged = [];
        foreach ($xp->query('./w:tr | ./w:sdt/w:sdtContent/w:tr', $tbl) as $tr) {
            $r = count($grid);
            $row = [];
            $col = (int) ($xp->evaluate('string(./w:trPr/w:gridBefore/@w:val)', $tr) ?: 0);
            for ($i = 0; $i < $col; $i++) {
                $row[$i] = '';
            }

            foreach ($xp->query('./w:tc | ./w:sdt/w:sdtContent/w:tc', $tr) as $tc) {
                $span = max(1, (int) ($xp->evaluate('string(./w:tcPr/w:gridSpan/@w:val)', $tc) ?: 1));
                $vMerge = $xp->query('./w:tcPr/w:vMerge', $tc)->item(0);
                $continues = $vMerge instanceof DOMElement && $vMerge->getAttributeNS(self::W, 'val') !== 'restart';

                // A vertically merged cell repeats the value of the cell above it
                if ($continues) {
                    $text = $grid[$r - 1][$col] ?? '';
                    $vmerged[] = [$r, $col];
                } else {
                    $text = $this->cellText($xp, $tc);
                }

                $row[$col] = $text;
                for ($i = 1; $i < $span; $i++) {
                    $row[$col + $i] = '';
                }
                if ($span > 1) {
                    $spans[] = [$r, $col, $span];
                }
                $col += $span;
            }
            $grid[] = $row;
        }

        // Same number of cells in every row, so the browser can draw a clean grid
        $width = $grid ? max(array_map('count', $grid)) : 0;
        foreach ($grid as &$row) {
            $row = array_values(array_pad($row, $width, ''));
        }
        unset($row);

        return ['grid' => $grid, 'spans' => $spans, 'vmerged' => $vmerged];
    }

    private function cellText(DOMXPath $xp, DOMElement $tc): string
    {
        $lines = [];
        foreach ($xp->query('.//w:p', $tc) as $p) {
            $line = '';
            foreach ($xp->query('.//w:t | .//w:tab | .//w:br', $p) as $node) {
                $line .= match ($node->localName) {
                    't' => $node->textContent,
                    'tab' => ' ',
                    'br' => "\n",
                };
            }
            $lines[] = $line;
        }

        return trim(implode("\n", $lines));
    }
}
