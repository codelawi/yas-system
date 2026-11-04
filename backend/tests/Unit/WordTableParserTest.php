<?php

namespace Tests\Unit;

use App\Services\WordTableParser;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class WordTableParserTest extends TestCase
{
    private function parser(): WordTableParser
    {
        return new WordTableParser(
            ['الرقم التسلسلي', 'الرقم التسلسلى', 'Serial Number', 'SN'],
            ['ت', 'م', 'تسلسل', '#', 'No'],
        );
    }

    private function fixture(string $name): string
    {
        return dirname(__DIR__).'/Fixtures/'.$name;
    }

    public function test_analyze_returns_every_table_with_its_title(): void
    {
        $tables = $this->parser()->analyze($this->fixture('demo-equipment.docx'));

        $this->assertCount(4, $tables);
        $this->assertSame('1) معدات LUKAS الهيدروليكية', $tables[0]['title']);
        $this->assertSame('4) Thermal camera', $tables[3]['title']);
    }

    public function test_header_row_table_detects_serial_and_row_number_columns(): void
    {
        $lukas = $this->parser()->analyze($this->fixture('demo-equipment.docx'))[0];
        $detected = $lukas['detected'];

        $this->assertSame('rows', $detected['layout']);
        $this->assertSame(0, $detected['header_row']);
        $this->assertSame('row_no', $detected['columns'][0]['role']);
        $this->assertSame('serial', $detected['columns'][3]['role']);
        $this->assertSame(['role' => 'field', 'key' => 'سنة الصنع'], $detected['columns'][2]);
    }

    public function test_merged_cells_are_reported(): void
    {
        $lukas = $this->parser()->analyze($this->fixture('demo-equipment.docx'))[0];

        $this->assertContains([1, 0, 11], $lukas['spans']);
        $this->assertContains([3, 10], $lukas['vmerged']);
        // A vertically merged cell repeats the value above it
        $this->assertSame($lukas['grid'][2][10], $lukas['grid'][3][10]);
    }

    public function test_key_value_tables_get_a_role_per_key(): void
    {
        $tables = $this->parser()->analyze($this->fixture('demo-equipment.docx'));

        $this->assertSame('pairs', $tables[2]['detected']['layout']);
        $this->assertSame('serial', $tables[2]['detected']['pair_roles']['الرقم التسلسلي']);
        $this->assertSame('row_no', $tables[2]['detected']['pair_roles']['ت']);
        // Key | Value | Key | Value table with the serial on its second row
        $this->assertSame('pairs', $tables[3]['detected']['layout']);
        $this->assertSame('serial', $tables[3]['detected']['pair_roles']['Serial Number']);
    }

    public function test_parse_still_builds_items(): void
    {
        $result = $this->parser()->parse($this->fixture('demo-equipment.docx'));

        $this->assertCount(11, $result['items']);
        $generator = collect($result['items'])->firstWhere('serial', 'GEN-1002');
        $this->assertSame(2, $generator['row_no']);
        $this->assertNotContains('ت', array_column($generator['fields'], 'key'));
    }

    /** @return array<string, array{0: string, 1: ?int}> */
    public static function rowNumbers(): array
    {
        return [
            'western' => ['12', 12],
            'arabic-indic' => ['١٢', 12],
            'trailing dot' => ['3.', 3],
            'spaces' => [' 7 ', 7],
            'text' => ['abc', null],
            'empty' => ['', null],
        ];
    }

    #[DataProvider('rowNumbers')]
    public function test_row_numbers_are_parsed(string $text, ?int $expected): void
    {
        $this->assertSame($expected, WordTableParser::parseRowNo($text));
    }
}
