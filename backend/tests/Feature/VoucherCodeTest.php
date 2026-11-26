<?php

namespace Tests\Feature;

use App\Models\EquipmentGroup;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;
use ZipArchive;

/** Voucher codes: what an issue voucher (سند صرف) prints for each group. */
class VoucherCodeTest extends TestCase
{
    use RefreshDatabase;

    private function signIn(): User
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        return $user;
    }

    public function test_a_group_keeps_its_voucher_code_and_voucher_name(): void
    {
        $this->signIn();
        $group = EquipmentGroup::create(['name' => 'جهاز تنفس']);

        $this->putJson("/api/groups/{$group->id}", ['voucher_code' => '  ان ٤١٢٣٤١دم ', 'voucher_name' => 'جهاز تنفس كامل  للاماكن الضيقة'])
            ->assertOk()
            ->assertJsonPath('voucher_code', 'ان ٤١٢٣٤١دم')
            ->assertJsonPath('voucher_name', 'جهاز تنفس كامل للاماكن الضيقة');

        // Renaming keeps the voucher texts
        $this->putJson("/api/groups/{$group->id}", ['name' => 'أجهزة التنفس'])->assertOk()->assertJsonPath('voucher_code', 'ان ٤١٢٣٤١دم');
        $this->getJson('/api/groups')->assertJsonPath('0.name', 'أجهزة التنفس')->assertJsonPath('0.voucher_code', 'ان ٤١٢٣٤١دم');

        // An empty voucher name falls back to the group name
        $this->putJson("/api/groups/{$group->id}", ['voucher_name' => '  '])->assertOk()->assertJsonPath('voucher_name', null);
        $this->assertSame('أجهزة التنفس', $group->fresh()->voucherName());
        $this->assertSame('أجهزة التنفس', $group->fresh()->name);
    }

    public function test_a_new_group_can_get_its_voucher_code_at_once(): void
    {
        $this->signIn();

        $this->postJson('/api/groups', ['name' => 'كشاف يدوي', 'voucher_code' => 'ان ٤٥٢٨دم', 'voucher_name' => ''])
            ->assertOk()
            ->assertJsonPath('voucher_code', 'ان ٤٥٢٨دم')
            ->assertJsonPath('voucher_name', null);
        $this->postJson('/api/groups', ['name' => 'مولد'])->assertOk()->assertJsonPath('voucher_code', null);
    }

    public function test_the_voucher_codes_of_many_groups_are_saved_at_once(): void
    {
        $a = EquipmentGroup::create(['name' => 'كشاف يدوي']);
        $b = EquipmentGroup::create(['name' => 'مولد كهرباء', 'voucher_code' => 'قديم']);
        $c = EquipmentGroup::create(['name' => 'منشار', 'voucher_code' => 'ان ١']);
        $rows = [
            ['id' => $a->id, 'voucher_code' => 'ان ٤٥٢٨دم', 'voucher_name' => 'كشاف يدوي'],
            ['id' => $b->id, 'voucher_code' => '', 'voucher_name' => 'مولد كهرباء احمر FUBAG'],
            ['id' => $c->id, 'voucher_code' => 'ان ١', 'voucher_name' => null],
        ];

        $this->putJson('/api/groups/voucher-codes', ['groups' => $rows])->assertUnauthorized();

        $this->signIn();
        $this->putJson('/api/groups/voucher-codes', ['groups' => $rows])->assertOk()->assertJsonPath('changed', 2);

        $this->assertSame('ان ٤٥٢٨دم', $a->fresh()->voucher_code);
        $this->assertNull($b->fresh()->voucher_code);
        $this->assertSame('مولد كهرباء احمر FUBAG', $b->fresh()->voucher_name);
        $this->assertSame('ان ١', $c->fresh()->voucher_code);

        $this->putJson('/api/groups/voucher-codes', ['groups' => [['id' => 999, 'voucher_code' => 'x', 'voucher_name' => null]]])->assertUnprocessable();
    }

    public function test_the_tables_of_a_word_file_are_read_without_saving_anything(): void
    {
        $this->signIn();
        $file = new UploadedFile(base_path('tests/Fixtures/demo-equipment.docx'), 'codes.docx', null, null, true);

        $tables = $this->post('/api/groups/voucher-codes/read', ['file' => $file], ['Accept' => 'application/json'])
            ->assertOk()
            ->assertJsonPath('file', 'codes.docx')
            ->json('tables');

        $this->assertNotEmpty($tables);
        $this->assertNotEmpty($tables[0]['grid']);
        $this->assertArrayNotHasKey('detected', $tables[0]);
        $this->assertDatabaseCount('imports', 0);
    }

    public function test_the_sheets_of_an_excel_file_are_read_with_shared_strings_gaps_and_merged_cells(): void
    {
        $this->signIn();
        $path = $this->excelFile();

        $tables = $this->post('/api/groups/voucher-codes/read', ['file' => UploadedFile::fake()->createWithContent('codes.xlsx', file_get_contents($path))], ['Accept' => 'application/json'])
            ->assertOk()
            ->json('tables');

        // The empty sheet is left out
        $this->assertCount(1, $tables);
        $this->assertSame('الرموز', $tables[0]['title']);
        $this->assertSame([
            ['سند الصرف', '', ''],
            ['الحرف والرقم', '', 'النوع'],
            ['ان ٤١٢٣٤١دم', '', 'جهاز تنفس كامل للاماكن الضيقة'],
            ['', '', ''],
            ['24442', '', 'كشاف يدوي'],
        ], $tables[0]['grid']);
        $this->assertSame([[0, 0, 3]], $tables[0]['spans']);
    }

    public function test_other_files_are_refused(): void
    {
        $this->signIn();
        $this->post('/api/groups/voucher-codes/read', ['file' => UploadedFile::fake()->createWithContent('codes.txt', 'hello')], ['Accept' => 'application/json'])
            ->assertUnprocessable()
            ->assertJsonPath('errors.file.0', 'only_docx_xlsx');
        $this->post('/api/groups/voucher-codes/read', ['file' => UploadedFile::fake()->createWithContent('codes.xlsx', 'not a zip')], ['Accept' => 'application/json'])
            ->assertUnprocessable()
            ->assertJsonPath('errors.file.0', 'voucher_file_bad');
    }

    /** An .xlsx written the way Excel does: shared strings, a merged title, an empty row and column. */
    private function excelFile(): string
    {
        $path = tempnam(sys_get_temp_dir(), 'xlsx');
        $zip = new ZipArchive;
        $zip->open($path, ZipArchive::OVERWRITE);
        $main = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
        $zip->addFromString('xl/workbook.xml', "<workbook $main><sheets><sheet name=\"الرموز\" sheetId=\"1\" r:id=\"rId1\"/><sheet name=\"فارغ\" sheetId=\"2\" r:id=\"rId2\"/></sheets></workbook>");
        $zip->addFromString('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>');
        $zip->addFromString('xl/sharedStrings.xml', "<sst $main><si><t>سند الصرف</t></si><si><r><t>الحرف </t></r><r><t>والرقم</t></r></si><si><t>النوع</t></si><si><t>ان ٤١٢٣٤١دم</t></si></sst>");
        $zip->addFromString('xl/worksheets/sheet1.xml', "<worksheet $main><sheetData>"
            .'<row r="1"><c r="A1" t="s"><v>0</v></c></row>'
            .'<row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2" t="s"><v>2</v></c></row>'
            .'<row r="3"><c r="A3" t="s"><v>3</v></c><c r="C3" t="inlineStr"><is><t>جهاز تنفس كامل للاماكن الضيقة</t></is></c></row>'
            .'<row r="5"><c r="A5"><v>24442</v></c><c r="C5" t="str"><v>كشاف يدوي</v></c></row>'
            .'</sheetData><mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells></worksheet>');
        $zip->addFromString('xl/worksheets/sheet2.xml', "<worksheet $main><sheetData/></worksheet>");
        $zip->close();

        return $path;
    }
}
