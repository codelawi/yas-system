<?php

namespace App\Services;

use DOMDocument;
use DOMElement;
use DOMXPath;
use RuntimeException;
use ZipArchive;

/**
 * Reads every sheet of an .xlsx file as a table of text, in the same shape as
 * WordTableParser::analyze() gives Word tables (grid + merged cells). No external package needed.
 */
class XlsxTableReader
{
    private const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

    private const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

    /** Bigger sheets are cut (the browser shows every cell). */
    private const MAX_ROWS = 3000;

    private const MAX_COLUMNS = 40;

    /**
     * @return array<int, array{index: int, title: string, grid: array<int, array<int, string>>, spans: array<int, array{0: int, 1: int, 2: int}>}>
     */
    public function read(string $path): array
    {
        $zip = new ZipArchive;
        if ($zip->open($path) !== true) {
            throw new RuntimeException('not_xlsx');
        }

        try {
            $workbook = $zip->getFromName('xl/workbook.xml');
            if ($workbook === false) {
                throw new RuntimeException('not_xlsx');
            }
            $strings = $this->sharedStrings($zip);
            $targets = $this->sheetTargets($zip);

            $tables = [];
            $xp = $this->xpath($workbook);
            foreach ($xp->query('//m:sheets/m:sheet') as $sheet) {
                /** @var DOMElement $sheet */
                $target = $targets[$sheet->getAttributeNS(self::REL, 'id')] ?? null;
                $xml = $target ? $zip->getFromName($target) : false;
                if ($xml === false) {
                    continue;
                }
                $tables[] = ['index' => count($tables) + 1, 'title' => $sheet->getAttribute('name')] + $this->readSheet($xml, $strings);
            }

            return $tables;
        } finally {
            $zip->close();
        }
    }

    /** @return array<string, string> relationship id → file inside the zip */
    private function sheetTargets(ZipArchive $zip): array
    {
        $rels = $zip->getFromName('xl/_rels/workbook.xml.rels');
        if ($rels === false) {
            return [];
        }
        $targets = [];
        $dom = new DOMDocument;
        $dom->loadXML($rels, LIBXML_NONET | LIBXML_COMPACT);
        foreach ($dom->getElementsByTagName('Relationship') as $rel) {
            $target = ltrim($rel->getAttribute('Target'), '/');
            $targets[$rel->getAttribute('Id')] = str_starts_with($target, 'xl/') ? $target : 'xl/'.$target;
        }

        return $targets;
    }

    /** @return array<int, string> */
    private function sharedStrings(ZipArchive $zip): array
    {
        $xml = $zip->getFromName('xl/sharedStrings.xml');
        if ($xml === false) {
            return [];
        }
        $xp = $this->xpath($xml);
        $strings = [];
        foreach ($xp->query('//m:si') as $si) {
            $strings[] = $this->text($xp, $si);
        }

        return $strings;
    }

    /**
     * @param  array<int, string>  $strings
     * @return array{grid: array<int, array<int, string>>, spans: array<int, array{0: int, 1: int, 2: int}>}
     */
    private function readSheet(string $xml, array $strings): array
    {
        $xp = $this->xpath($xml);
        $cells = [];
        $width = 0;
        $nextRow = 0;
        foreach ($xp->query('//m:sheetData/m:row') as $row) {
            /** @var DOMElement $row */
            $r = $row->hasAttribute('r') ? (int) $row->getAttribute('r') - 1 : $nextRow;
            $nextRow = $r + 1;
            if ($r >= self::MAX_ROWS) {
                break;
            }
            $nextCol = 0;
            foreach ($xp->query('./m:c', $row) as $cell) {
                /** @var DOMElement $cell */
                $c = $cell->hasAttribute('r') ? $this->columnIndex($cell->getAttribute('r')) : $nextCol;
                $nextCol = $c + 1;
                if ($c >= self::MAX_COLUMNS) {
                    continue;
                }
                $value = $this->cellValue($xp, $cell, $strings);
                if ($value !== '') {
                    $cells[$r][$c] = $value;
                    $width = max($width, $c + 1);
                }
            }
        }

        $spans = [];
        foreach ($xp->query('//m:mergeCells/m:mergeCell') as $merge) {
            /** @var DOMElement $merge */
            [$from, $to] = array_pad(explode(':', $merge->getAttribute('ref')), 2, null);
            if (! $to) {
                continue;
            }
            [$r1, $c1] = $this->position($from);
            [, $c2] = $this->position($to);
            if ($c2 > $c1 && $r1 < self::MAX_ROWS && $c1 < self::MAX_COLUMNS) {
                $spans[] = [$r1, $c1, min($c2, self::MAX_COLUMNS - 1) - $c1 + 1];
                $width = max($width, min($c2, self::MAX_COLUMNS - 1) + 1);
            }
        }

        // Dense rows of the same width, like the Word tables; empty rows at the end are dropped
        $height = $cells ? max(array_keys($cells)) + 1 : 0;
        $grid = [];
        for ($r = 0; $r < $height; $r++) {
            $grid[] = array_map(fn ($c) => $cells[$r][$c] ?? '', range(0, max(0, $width - 1)));
        }

        return ['grid' => $width ? $grid : [], 'spans' => array_values(array_filter($spans, fn ($s) => $s[0] < $height))];
    }

    /** @param  array<int, string>  $strings */
    private function cellValue(DOMXPath $xp, DOMElement $cell, array $strings): string
    {
        $type = $cell->getAttribute('t');
        if ($type === 'inlineStr') {
            $is = $xp->query('./m:is', $cell)->item(0);

            return $is ? trim($this->text($xp, $is)) : '';
        }
        $v = $xp->query('./m:v', $cell)->item(0)?->textContent;
        if ($v === null) {
            return '';
        }

        return trim(match ($type) {
            's' => $strings[(int) $v] ?? '',
            'b' => $v === '1' ? 'TRUE' : 'FALSE',
            default => $v,
        });
    }

    /** Text of a shared/inline string, without phonetic hints. */
    private function text(DOMXPath $xp, DOMElement $node): string
    {
        $text = '';
        foreach ($xp->query('./m:t | ./m:r/m:t', $node) as $t) {
            $text .= $t->textContent;
        }

        return $text;
    }

    /** "C12" → [11, 2] */
    private function position(string $ref): array
    {
        preg_match('/^([A-Z]+)(\d+)$/i', $ref, $m);

        return [(int) ($m[2] ?? 1) - 1, $this->columnIndex($ref)];
    }

    /** "C12" → 2 */
    private function columnIndex(string $ref): int
    {
        $letters = strtoupper(preg_replace('/[^A-Za-z]/', '', $ref));
        $n = 0;
        foreach (str_split($letters) as $letter) {
            $n = $n * 26 + (ord($letter) - 64);
        }

        return max(0, $n - 1);
    }

    private function xpath(string $xml): DOMXPath
    {
        $dom = new DOMDocument;
        if (! @$dom->loadXML($xml, LIBXML_NONET | LIBXML_COMPACT | LIBXML_PARSEHUGE)) {
            throw new RuntimeException('not_xlsx');
        }
        $xp = new DOMXPath($dom);
        $xp->registerNamespace('m', self::MAIN);

        return $xp;
    }
}
