<?php

namespace Tests\Feature;

use App\Models\Box;
use App\Models\Equipment;
use App\Models\EquipmentGroup;
use App\Models\Import;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class EquipmentGroupTest extends TestCase
{
    use RefreshDatabase;

    private function signIn(): User
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        return $user;
    }

    public function test_equipment_without_a_name_shows_its_group_name(): void
    {
        $group = EquipmentGroup::create(['name' => 'وحدة الفتح والقص']);
        $unnamed = Equipment::create(['serial_number' => 'G-1', 'group_id' => $group->id]);
        $named = Equipment::create(['serial_number' => 'G-2', 'group_id' => $group->id, 'name' => 'مقص']);
        $fromField = Equipment::create(['serial_number' => 'G-3', 'group_id' => $group->id]);
        $fromField->syncFields([['key' => 'اسم المعدة', 'value' => 'فتاحة']]);
        $accessory = Equipment::create(['serial_number' => 'G-4', 'parent_id' => $unnamed->id]);

        $names = collect($this->getJson('/api/equipment?per_page=50')->assertOk()->json('data'))->pluck('display_name', 'serial_number');

        $this->assertSame('وحدة الفتح والقص', $names['G-1']);
        $this->assertSame('مقص', $names['G-2']);
        $this->assertSame('فتاحة', $names['G-3']);
        $this->assertNull($names['G-4']);

        // Only shown: the saved name stays empty, so the edit form doesn't fill it in
        $this->getJson("/api/equipment/{$unnamed->id}")
            ->assertOk()
            ->assertJsonPath('name', null)
            ->assertJsonPath('display_name', 'وحدة الفتح والقص');
        $this->getJson('/api/equipment/labels?ids[]='.$unnamed->id)->assertJsonPath('0.display_name', 'وحدة الفتح والقص');
        $this->getJson("/api/groups/{$group->id}")->assertJsonPath('equipment.0.display_name', 'وحدة الفتح والقص');
    }

    public function test_the_group_name_also_shows_on_custody_home_stocktake_and_accessories(): void
    {
        $this->signIn();
        $group = EquipmentGroup::create(['name' => 'وحدة الفتح والقص']);
        $unit = Equipment::create(['serial_number' => 'G-1', 'group_id' => $group->id]);
        $accessory = Equipment::create(['serial_number' => 'G-2', 'parent_id' => $unit->id]);
        $box = Box::create(['number' => '1']);
        $box->equipment()->attach($accessory->id);
        $unit->custodies()->create(['holder' => 'سالم', 'handed_at' => now(), 'due_back_at' => now()->addDay()]);
        $unit->schedules()->create(['title' => 'فحص', 'due_date' => now()->addDay()]);
        $unit->issues()->create(['description' => 'عطل']);

        $this->getJson('/api/custody')
            ->assertJsonPath('open.0.equipment.display_name', 'وحدة الفتح والقص')
            ->assertJsonMissingPath('open.0.equipment.fields');

        $this->getJson('/api/stats')
            ->assertJsonPath('maintenance.items.0.equipment.display_name', 'وحدة الفتح والقص')
            ->assertJsonPath('issues.items.0.equipment.display_name', 'وحدة الفتح والقص')
            ->assertJsonPath('custody.items.0.equipment.display_name', 'وحدة الفتح والقص');

        $stocktake = $this->postJson('/api/stocktakes', ['name' => 'جرد'])->assertSuccessful()->json('id');
        $this->postJson("/api/stocktakes/{$stocktake}/scan", ['code' => 'G-1'])
            ->assertJsonPath('scan.equipment.display_name', 'وحدة الفتح والقص');
        $this->postJson("/api/stocktakes/{$stocktake}/scan", ['code' => 'G-1'])
            ->assertJsonPath('status', 'already')
            ->assertJsonPath('scan.equipment.display_name', 'وحدة الفتح والقص');
        $this->postJson("/api/stocktakes/{$stocktake}/scan", ['code' => 'NOT-THERE'])
            ->assertJsonPath('status', 'unknown')
            ->assertJsonPath('scan.equipment', null);

        $this->getJson("/api/equipment/{$accessory->id}")->assertJsonPath('parent.display_name', 'وحدة الفتح والقص');
        $this->getJson("/api/boxes/{$box->id}")->assertJsonPath('equipment.0.parent.display_name', 'وحدة الفتح والقص');
    }

    public function test_searching_the_grouped_list_finds_accessories_of_grouped_equipment(): void
    {
        $group = EquipmentGroup::create(['name' => 'وحدات']);
        $unit = Equipment::create(['serial_number' => 'U-1', 'group_id' => $group->id]);
        $battery = Equipment::create(['serial_number' => 'U-1ACC01', 'name' => 'بطارية', 'parent_id' => $unit->id]);
        $battery->syncFields([['key' => 'عدد', 'value' => '2']]);
        $serials = fn (string $query) => collect($this->getJson('/api/equipment?ungrouped=1'.$query)->assertOk()->json('data'))->pluck('serial_number')->all();

        $this->assertSame([], $serials(''));
        $this->assertSame(['U-1ACC01'], $serials('&q=ACC01'));
        $this->assertSame(['U-1ACC01'], $serials('&q='.urlencode('بطارية')));
    }

    public function test_names_that_differ_only_in_spelling_are_one_group(): void
    {
        $this->signIn();

        $this->postJson('/api/groups', ['name' => 'وحدة الفتح والقص'])->assertOk()->assertJsonPath('name', 'وحدة الفتح والقص');
        $this->postJson('/api/groups', ['name' => ' وحده  الفتح والقص '])->assertJsonValidationErrors(['name' => 'group_name_taken']);
    }

    public function test_suggestions_group_equipment_sharing_a_name_and_apply_makes_the_groups(): void
    {
        $this->signIn();
        foreach (['A-1', 'A-2', 'A-3'] as $i => $serial) {
            Equipment::create(['serial_number' => $serial, 'name' => $i === 2 ? 'وحده الفتح والقص' : 'وحدة الفتح والقص']);
        }
        $main = Equipment::create(['serial_number' => 'B-1', 'name' => 'مولد']);
        Equipment::create(['serial_number' => 'B-1-A', 'name' => 'وحدة الفتح والقص', 'parent_id' => $main->id]);

        $suggestions = $this->getJson('/api/groups/suggest')->assertOk()->json();
        $this->assertCount(1, $suggestions, 'a single «مولد» is not a group, and accessories are never grouped');
        $this->assertSame('وحدة الفتح والقص', $suggestions[0]['name']);
        $this->assertSame(3, $suggestions[0]['count']);

        $this->postJson('/api/groups/apply', ['groups' => [['key' => $suggestions[0]['key'], 'name' => $suggestions[0]['name']]]])
            ->assertOk()->assertJsonPath('created', 1)->assertJsonPath('grouped', 3);

        $group = EquipmentGroup::first();
        $this->getJson("/api/groups/{$group->id}")->assertOk()->assertJsonCount(3, 'equipment');
        $this->assertSame([], $this->getJson('/api/groups/suggest')->json());
    }

    public function test_new_equipment_joins_the_group_with_its_name(): void
    {
        $this->signIn();
        $group = EquipmentGroup::create(['name' => 'وحدة الفتح والقص']);

        $id = $this->postJson('/api/equipment', ['serial_number' => 'N-1', 'name' => 'وحده الفتح  والقص'])->assertOk()->assertJsonPath('group.id', $group->id)->json('id');
        $accessoryId = $this->postJson('/api/equipment', ['serial_number' => 'N-1-A', 'name' => 'وحدة الفتح والقص', 'parent_id' => $id])->assertOk()->json('id');

        $this->assertNull(Equipment::find($accessoryId)->group_id);
    }

    public function test_grouped_list_shows_groups_with_counts_and_the_rest_apart(): void
    {
        $group = EquipmentGroup::create(['name' => 'وحدة الفتح والقص']);
        $inGroup = Equipment::create(['serial_number' => 'G-1', 'group_id' => $group->id]);
        Equipment::create(['serial_number' => 'G-2', 'group_id' => $group->id]);
        Equipment::create(['serial_number' => 'G-1-A', 'parent_id' => $inGroup->id]);
        Equipment::create(['serial_number' => 'X-1']);

        $this->getJson('/api/equipment/group-summary')->assertOk()->assertJsonPath('0.name', 'وحدة الفتح والقص')->assertJsonPath('0.count', 2);
        $this->getJson('/api/equipment/group-summary?q=G-2')->assertOk()->assertJsonPath('0.count', 1);
        $this->getJson('/api/equipment/group-summary?q=X-1')->assertOk()->assertJsonCount(0);

        // The accessory of a grouped equipment shows inside the group, not with the rest
        $rest = collect($this->getJson('/api/equipment?ungrouped=1')->assertOk()->json('data'))->pluck('serial_number')->all();
        $this->assertSame(['X-1'], $rest);
        $this->assertSame(2, $this->getJson("/api/equipment?group_id={$group->id}&type=main")->json('total'));
        // Searching for the group's name finds its equipment
        $this->assertSame(2, $this->getJson('/api/equipment?q=الفتح&type=main')->json('total'));
    }

    public function test_assign_and_remove_and_deleting_a_group_keeps_its_equipment(): void
    {
        $this->signIn();
        $group = EquipmentGroup::create(['name' => 'مضخات']);
        $a = Equipment::create(['serial_number' => 'P-1']);
        $accessory = Equipment::create(['serial_number' => 'P-1-A', 'parent_id' => $a->id]);

        $this->postJson('/api/groups/assign', ['ids' => [$a->id, $accessory->id], 'group_id' => $group->id])->assertOk()->assertJsonPath('changed', 1);
        $this->assertSame($group->id, $a->fresh()->group_id);
        $this->assertNull($accessory->fresh()->group_id);

        $this->postJson('/api/groups/assign', ['ids' => [$a->id], 'group_id' => null])->assertOk()->assertJsonPath('changed', 1);
        $this->assertNull($a->fresh()->group_id);

        $a->update(['group_id' => $group->id]);
        $this->deleteJson("/api/groups/{$group->id}")->assertNoContent();
        $this->assertNull($a->fresh()->group_id);
        $this->assertNotNull($a->fresh());
    }

    public function test_changing_the_group_from_the_equipment_form(): void
    {
        $this->signIn();
        $group = EquipmentGroup::create(['name' => 'مضخات']);
        $equipment = Equipment::create(['serial_number' => 'E-1']);

        $this->putJson("/api/equipment/{$equipment->id}", ['serial_number' => 'E-1', 'group_id' => $group->id])->assertOk()->assertJsonPath('group.name', 'مضخات');
        $this->putJson("/api/equipment/{$equipment->id}", ['serial_number' => 'E-1'])->assertOk()->assertJsonPath('group.name', 'مضخات');
        $this->putJson("/api/equipment/{$equipment->id}", ['serial_number' => 'E-1', 'group_id' => null])->assertOk()->assertJsonPath('group', null);
    }

    public function test_import_puts_new_and_overwritten_equipment_in_the_chosen_group(): void
    {
        $this->signIn();
        $group = EquipmentGroup::create(['name' => 'وحدة الفتح والقص']);
        $existing = Equipment::create(['serial_number' => 'W-2']);
        $import = Import::create(['original_name' => 'a.docx', 'stored_path' => 'imports/a.docx']);

        $this->postJson('/api/imports/commit', [
            'group_id' => $group->id,
            'items' => [
                ['import_id' => $import->id, 'action' => 'create', 'serial' => 'W-1', 'fields' => [['key' => 'الاسم', 'value' => 'مولد']]],
                ['import_id' => $import->id, 'action' => 'overwrite', 'serial' => 'W-2', 'fields' => []],
            ],
        ])->assertOk();

        $this->assertSame($group->id, Equipment::where('serial_number', 'W-1')->value('group_id'));
        $this->assertSame($group->id, $existing->fresh()->group_id);
    }
}
