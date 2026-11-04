<?php

namespace Tests\Feature;

use App\Models\ActivityLog;
use App\Models\Equipment;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;
use ZipArchive;

class ExportTest extends TestCase
{
    use RefreshDatabase;

    /** Text of the sheet inside a downloaded .xlsx */
    private function sheetXml($response): string
    {
        $path = tempnam(sys_get_temp_dir(), 't');
        file_put_contents($path, $response->streamedContent());
        $zip = new ZipArchive;
        $this->assertTrue($zip->open($path));
        $xml = $zip->getFromName('xl/worksheets/sheet1.xml');
        $this->assertNotFalse($zip->getFromName('xl/workbook.xml'));
        @unlink($path);

        return $xml;
    }

    public function test_equipment_export_has_one_column_per_field_and_respects_filters(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $a = Equipment::create(['serial_number' => 'EX-1', 'row_no' => 4]);
        $a->syncFields([['key' => 'المكان', 'value' => 'المستودع'], ['key' => 'ملاحظات', 'value' => "سطر 1\nسطر 2 & <x>"]]);
        Equipment::create(['serial_number' => 'EX-1-A', 'name' => 'تمساح', 'parent_id' => $a->id]);
        Equipment::create(['serial_number' => 'OTHER-1']);

        $response = $this->get('/api/equipment/export?type=main&q=EX');
        $response->assertOk()->assertHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        $xml = $this->sheetXml($response);

        $this->assertStringContainsString('المكان', $xml);
        $this->assertStringContainsString('EX-1', $xml);
        $this->assertStringContainsString('&amp; &lt;x&gt;', $xml);
        $this->assertStringContainsString('rightToLeft="1"', $xml);
        $this->assertStringNotContainsString('OTHER-1', $xml);
        $this->assertStringNotContainsString('EX-1-A', $xml);
    }

    public function test_history_export(): void
    {
        Sanctum::actingAs(User::factory()->create());
        ActivityLog::record(Equipment::create(['serial_number' => 'H-9']), 'created');

        $xml = $this->sheetXml($this->get('/api/activity/export')->assertOk());

        $this->assertStringContainsString('H-9', $xml);
        $this->assertStringContainsString('إضافة', $xml);
    }

    public function test_exports_need_a_pin(): void
    {
        $this->getJson('/api/equipment/export')->assertUnauthorized();
        $this->getJson('/api/activity/export')->assertUnauthorized();
    }
}
