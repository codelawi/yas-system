<?php

namespace Tests\Feature;

use App\Models\Equipment;
use App\Models\EquipmentGroup;
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

    public function test_each_item_may_choose_its_own_group_or_none(): void
    {
        $importGroup = EquipmentGroup::create(['name' => 'عامة']);
        $own = EquipmentGroup::create(['name' => 'خاصة']);
        $sameName = EquipmentGroup::create(['name' => 'مضخة']);
        $importId = $this->postJson('/api/imports/preview', ['files' => [$this->upload('demo-update.docx')]])->json('files.0.import_id');
        $item = fn (string $serial, array $extra = []) => ['import_id' => $importId, 'action' => 'create', 'serial' => $serial, 'fields' => [['key' => 'الاسم', 'value' => 'مضخة']], ...$extra];

        $this->postJson('/api/imports/commit', [
            'group_id' => $importGroup->id,
            'items' => [$item('G-1'), $item('G-2', ['group_id' => $own->id]), $item('G-3', ['group_id' => null])],
        ])->assertOk()->assertJson(['created' => 3]);

        $this->assertSame($importGroup->id, Equipment::where('serial_number', 'G-1')->value('group_id'));
        $this->assertSame($own->id, Equipment::where('serial_number', 'G-2')->value('group_id'));
        // "No group" also stops it joining the group with its name
        $this->assertNull(Equipment::where('serial_number', 'G-3')->value('group_id'));
        $this->assertSame(0, $sameName->equipment()->count());
    }

    public function test_an_accessory_count_becomes_a_field_and_updates_on_import_again(): void
    {
        $importId = $this->postJson('/api/imports/preview', ['files' => [$this->upload('demo-update.docx')]])->json('files.0.import_id');
        $commit = fn (string $action, array $accessories) => $this->postJson('/api/imports/commit', [
            'items' => [['import_id' => $importId, 'action' => $action, 'serial' => '5501', 'fields' => [], 'accessories' => $accessories]],
        ])->assertOk();

        $commit('create', [
            ['name' => 'بطارية', 'serial' => '5501ACC01', 'quantity' => 2, 'raw' => '2'],
            ['name' => 'حقيبة', 'serial' => '5501ACC02', 'quantity' => 1, 'note' => 'كتان', 'raw' => '1كتان'],
        ])->assertJson(['accessories' => 2]);

        $bag = Equipment::where('serial_number', '5501ACC02')->firstOrFail();
        $this->assertSame('حقيبة', $bag->name);
        $this->assertSame([['key' => 'عدد', 'value' => '1'], ['key' => 'ملاحظات', 'value' => 'كتان']], $bag->load('fields')->fieldList());

        // Same accessory, new count: it changes in place and other fields stay
        Equipment::where('serial_number', '5501ACC01')->firstOrFail()->syncFields([['key' => 'عدد', 'value' => '2'], ['key' => 'اللون', 'value' => 'أسود']]);
        $commit('overwrite', [['name' => 'بطارية', 'serial' => '5501ACC01', 'quantity' => 3, 'raw' => '3']])->assertJson(['accessories' => 0]);
        $battery = Equipment::where('serial_number', '5501ACC01')->firstOrFail();
        $this->assertSame(['اللون' => 'أسود', 'عدد' => '3'], collect($battery->fieldList())->pluck('value', 'key')->all());
    }

    public function test_importing_again_turns_an_old_count_serial_into_the_new_form(): void
    {
        $main = Equipment::create(['serial_number' => '7000']);
        Equipment::create(['serial_number' => '2', 'name' => 'بطارية', 'parent_id' => $main->id]);
        $importId = $this->postJson('/api/imports/preview', ['files' => [$this->upload('demo-update.docx')]])->json('files.0.import_id');

        $this->postJson('/api/imports/commit', [
            'items' => [['import_id' => $importId, 'action' => 'overwrite', 'serial' => '7000', 'fields' => [], 'accessories' => [['name' => 'بطارية', 'serial' => '7000ACC01', 'quantity' => 2, 'raw' => '2']]]],
        ])->assertOk()->assertJson(['accessories' => 0]);

        $this->assertSame(['7000ACC01'], $main->accessories()->pluck('serial_number')->all());
    }

    public function test_accessory_serial_may_repeat_on_another_equipment(): void
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
        ])->assertOk()->assertJson(['created' => 1, 'accessories' => 1, 'errors' => []]);

        $this->assertSame(2, Equipment::where('serial_number', 'ACC-1')->count());
        $this->assertSame(1, $other->accessories()->count());

        // Importing the same accessory again under the same equipment adds nothing
        $this->postJson('/api/imports/commit', [
            'items' => [[
                'import_id' => $importId,
                'action' => 'overwrite',
                'serial' => 'MAIN-B',
                'fields' => [],
                'accessories' => [['name' => 'x', 'serial' => 'ACC-1']],
            ]],
        ])->assertOk()->assertJson(['accessories' => 0]);
        $this->assertSame(2, Equipment::where('serial_number', 'ACC-1')->count());
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
