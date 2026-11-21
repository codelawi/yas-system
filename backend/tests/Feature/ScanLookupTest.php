<?php

namespace Tests\Feature;

use App\Models\Box;
use App\Models\Equipment;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ScanLookupTest extends TestCase
{
    use RefreshDatabase;

    public function test_a_makers_code_saved_in_a_field_finds_its_equipment_or_accessory(): void
    {
        $main = Equipment::create(['serial_number' => 'LK-1', 'name' => 'حبل']);
        $main->syncFields([['key' => 'Data Matrix', 'value' => '0104012345678901']]);
        $accessory = Equipment::create(['serial_number' => null, 'parent_id' => $main->id, 'name' => 'حزام']);
        $accessory->syncFields([['key' => 'كود المصنع', 'value' => 'PZ7781234']]);

        $this->getJson('/api/lookup?code=0104012345678901')
            ->assertOk()
            ->assertJsonPath('code', '0104012345678901')
            ->assertJsonCount(1, 'matches')
            ->assertJsonPath('matches.0.type', 'equipment')
            ->assertJsonPath('matches.0.id', $main->id)
            ->assertJsonPath('matches.0.display_name', 'حبل')
            ->assertJsonPath('matches.0.match', ['by' => 'field', 'key' => 'Data Matrix']);

        $this->getJson('/api/lookup?code='.urlencode('  PZ7781234 '))
            ->assertJsonPath('code', 'PZ7781234')
            ->assertJsonCount(1, 'matches')
            ->assertJsonPath('matches.0.id', $accessory->id)
            ->assertJsonPath('matches.0.serial_number', null)
            ->assertJsonPath('matches.0.parent.id', $main->id)
            ->assertJsonPath('matches.0.match.key', 'كود المصنع');
    }

    public function test_a_serial_number_lists_the_main_equipment_before_its_accessories(): void
    {
        $main = Equipment::create(['serial_number' => 'SN-500']);
        $accessory = Equipment::create(['serial_number' => 'SN-500', 'parent_id' => $main->id]);
        Equipment::create(['serial_number' => 'SN-500-B']);
        Equipment::create(['serial_number' => 'SN-500'])->delete();

        $matches = $this->getJson('/api/lookup?code=SN-500')->json('matches');

        $this->assertSame([$main->id, $accessory->id], array_column($matches, 'id'));
        $this->assertSame(['by' => 'serial', 'key' => null], $matches[0]['match']);
    }

    public function test_only_when_nothing_is_exactly_the_code_those_containing_it_are_listed(): void
    {
        $exact = Equipment::create(['serial_number' => 'A-1']);
        $exact->syncFields([['key' => 'كود', 'value' => 'XY-900']]);
        $containing = Equipment::create(['serial_number' => 'A-2']);
        $containing->syncFields([['key' => 'ملاحظات', 'value' => "رقم المصنع XY-900-7\nسطر آخر"]]);
        Box::create(['number' => '12', 'name' => 'صندوق XY-900-7']);

        $this->assertSame([$exact->id], array_column($this->getJson('/api/lookup?code=XY-900')->json('matches'), 'id'));

        $matches = $this->getJson('/api/lookup?code=XY-900-7')->json('matches');
        $this->assertSame(['equipment', 'box'], array_column($matches, 'type'));
        $this->assertSame($containing->id, $matches[0]['id']);
        $this->assertSame(['by' => 'field', 'key' => 'ملاحظات'], $matches[0]['match']);
        $this->assertSame(['by' => 'name', 'key' => null], $matches[1]['match']);
    }

    public function test_boxes_are_found_by_number_or_name(): void
    {
        $box = Box::create(['number' => 'B-7', 'name' => 'إسعافات', 'weight' => 3]);

        $this->getJson('/api/lookup?code=B-7')
            ->assertJsonCount(1, 'matches')
            ->assertJsonPath('matches.0', ['type' => 'box', 'id' => $box->id, 'number' => 'B-7', 'name' => 'إسعافات', 'match' => ['by' => 'number', 'key' => null]]);
        $this->getJson('/api/lookup?code='.urlencode('إسعافات'))->assertJsonPath('matches.0.match.by', 'name');
    }

    public function test_short_or_empty_codes_are_only_looked_up_exactly(): void
    {
        Equipment::create(['serial_number' => 'Q12345']);

        $this->getJson('/api/lookup?code=12')->assertJsonCount(0, 'matches');
        $this->getJson('/api/lookup?code=123')->assertJsonCount(1, 'matches');
        $this->getJson('/api/lookup?code=')->assertExactJson(['code' => '', 'matches' => []]);
        $this->getJson('/api/lookup?code=NOTHING-HERE')->assertExactJson(['code' => 'NOTHING-HERE', 'matches' => []]);
    }
}
