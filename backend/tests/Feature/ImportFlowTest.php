<?php

namespace Tests\Feature;

use App\Models\Equipment;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class ImportFlowTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
        Sanctum::actingAs(User::factory()->create());
    }

    private function upload(string $fixture): UploadedFile
    {
        return new UploadedFile(base_path('tests/Fixtures/'.$fixture), $fixture, null, null, true);
    }

    public function test_preview_returns_tables_and_detected_mapping(): void
    {
        $response = $this->postJson('/api/imports/preview', ['files' => [$this->upload('demo-equipment.docx')]]);

        $response->assertOk()
            ->assertJsonCount(4, 'files.0.tables')
            ->assertJsonPath('files.0.tables.0.detected.layout', 'rows')
            ->assertJsonPath('files.0.tables.0.detected.columns.3.role', 'serial')
            ->assertJsonPath('files.0.tables.2.detected.layout', 'pairs');
    }

    public function test_preview_rejects_non_docx_files(): void
    {
        $this->postJson('/api/imports/preview', ['files' => [UploadedFile::fake()->create('old.doc', 10)]])
            ->assertUnprocessable();
    }

    public function test_commit_creates_equipment_with_row_number_and_explicit_accessories(): void
    {
        $importId = $this->postJson('/api/imports/preview', ['files' => [$this->upload('demo-equipment.docx')]])->json('files.0.import_id');

        $this->postJson('/api/imports/commit', [
            'items' => [[
                'import_id' => $importId,
                'action' => 'create',
                'serial' => 'LKS-1',
                'row_no' => 4,
                'fields' => [['key' => 'المكان', 'value' => 'المستودع']],
                'accessories' => [['name' => 'تمساح', 'serial' => 'CRC-1'], ['name' => 'خراطيم', 'serial' => 'HSE-1']],
            ]],
        ])->assertOk()->assertJson(['created' => 1, 'accessories' => 2, 'errors' => []]);

        $main = Equipment::where('serial_number', 'LKS-1')->firstOrFail();
        $this->assertSame(4, $main->row_no);
        $this->assertSame(['CRC-1', 'HSE-1'], $main->accessories()->orderBy('serial_number')->pluck('serial_number')->all());
        $this->assertSame('تمساح', Equipment::where('serial_number', 'CRC-1')->value('name'));
    }

    public function test_accessory_serial_owned_by_another_equipment_is_reported(): void
    {
        $other = Equipment::create(['serial_number' => 'MAIN-A']);
        Equipment::create(['serial_number' => 'ACC-1', 'parent_id' => $other->id]);
        $importId = $this->postJson('/api/imports/preview', ['files' => [$this->upload('demo-update.docx')]])->json('files.0.import_id');

        $this->postJson('/api/imports/commit', [
            'items' => [[
                'import_id' => $importId,
                'action' => 'create',
                'serial' => 'MAIN-B',
                'fields' => [],
                'accessories' => [['name' => 'x', 'serial' => 'ACC-1']],
            ]],
        ])->assertOk()->assertJsonPath('errors.0.error', 'accessory_taken');

        $this->assertSame($other->id, Equipment::where('serial_number', 'ACC-1')->value('parent_id'));
    }

    public function test_check_reports_existing_serials(): void
    {
        Equipment::create(['serial_number' => 'GEN-1002', 'category' => 'مولدات']);

        $this->postJson('/api/imports/check', ['serials' => ['GEN-1002', 'NEW-1']])
            ->assertOk()
            ->assertJsonPath('GEN-1002.category', 'مولدات')
            ->assertJsonMissingPath('NEW-1');
    }

    public function test_guests_cannot_import(): void
    {
        $this->app['auth']->forgetGuards();

        $this->withHeader('Authorization', '')->postJson('/api/imports/check', ['serials' => []])->assertUnauthorized();
    }
}
