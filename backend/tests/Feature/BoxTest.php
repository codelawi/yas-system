<?php

namespace Tests\Feature;

use App\Models\ActivityLog;
use App\Models\Box;
use App\Models\Equipment;
use App\Models\EquipmentGroup;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class BoxTest extends TestCase
{
    use RefreshDatabase;

    private function signIn(): User
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        return $user;
    }

    public function test_changes_need_a_pin_but_viewing_is_open(): void
    {
        $box = Box::create(['number' => '1', 'name' => 'إسعافات', 'weight' => 12.5]);

        $this->postJson('/api/boxes', ['number' => '2'])->assertUnauthorized();
        $this->getJson('/api/boxes')->assertOk()->assertJsonPath('0.number', '1');
        $this->getJson('/api/boxes/number/1')->assertOk()
            ->assertJsonPath('id', $box->id)
            ->assertJsonPath('name', 'إسعافات')
            ->assertJsonPath('weight', 12.5);
    }

    public function test_box_numbers_are_unique_and_listed_in_natural_order(): void
    {
        $this->signIn();

        $this->postJson('/api/boxes', ['number' => ' 10 ', 'name' => 'B', 'weight' => 3])->assertOk()->assertJsonPath('number', '10');
        $this->postJson('/api/boxes', ['number' => '2'])->assertOk();
        $this->postJson('/api/boxes', ['number' => '10'])->assertJsonValidationErrors(['number' => 'box_number_taken']);
        $this->postJson('/api/boxes', ['number' => 'a/b'])->assertJsonValidationErrors(['number' => 'box_number_invalid']);
        $this->postJson('/api/boxes', ['number' => '3', 'weight' => -1])->assertJsonValidationErrors('weight');

        $this->assertSame(['2', '10'], collect($this->getJson('/api/boxes')->json())->pluck('number')->all());
    }

    public function test_adding_a_main_equipment_brings_its_accessories_and_removing_takes_them_out(): void
    {
        $this->signIn();
        $box = Box::create(['number' => '1']);
        $main = Equipment::create(['serial_number' => 'LK-1', 'name' => 'مضخة']);
        $accessory = Equipment::create(['serial_number' => 'LK-1-A', 'parent_id' => $main->id]);
        $other = Equipment::create(['serial_number' => 'X-9']);

        $this->postJson("/api/boxes/{$box->id}/equipment", ['ids' => [$main->id]])->assertOk()->assertJsonPath('added', 2);
        // Adding again changes nothing
        $this->postJson("/api/boxes/{$box->id}/equipment", ['ids' => [$main->id, $other->id]])->assertOk()->assertJsonPath('added', 1);

        $serials = collect($this->getJson("/api/boxes/{$box->id}")->json('equipment'))->pluck('serial_number')->all();
        $this->assertSame(['LK-1', 'LK-1-A', 'X-9'], $serials);
        $this->assertSame(1, ActivityLog::where('equipment_id', $accessory->id)->where('action', 'box_added')->count());

        $this->deleteJson("/api/boxes/{$box->id}/equipment/{$main->id}")->assertOk()->assertJsonCount(1, 'equipment');
        $this->assertSame(['X-9'], $box->equipment()->pluck('serial_number')->all());
    }

    public function test_an_equipment_can_be_in_several_boxes_and_new_accessories_follow_their_main_equipment(): void
    {
        $this->signIn();
        $first = Box::create(['number' => '1']);
        $second = Box::create(['number' => '2']);
        $main = Equipment::create(['serial_number' => 'LK-1']);

        $this->postJson("/api/boxes/{$first->id}/equipment", ['ids' => [$main->id]])->assertOk();
        $this->postJson("/api/boxes/{$second->id}/equipment", ['ids' => [$main->id]])->assertOk();
        $this->getJson("/api/equipment/{$main->id}")->assertOk()->assertJsonCount(2, 'boxes');

        $accessoryId = $this->postJson('/api/equipment', ['serial_number' => 'LK-1-B', 'parent_id' => $main->id])->assertOk()->json('id');
        $this->assertEqualsCanonicalizing([$first->id, $second->id], Equipment::find($accessoryId)->boxes()->pluck('boxes.id')->all());
    }

    public function test_deleting_a_box_keeps_its_equipment_and_deleted_equipment_leaves_the_box(): void
    {
        $this->signIn();
        $box = Box::create(['number' => '1']);
        $kept = Equipment::create(['serial_number' => 'A']);
        $gone = Equipment::create(['serial_number' => 'B']);
        $box->equipment()->attach([$kept->id, $gone->id]);

        $gone->delete();
        $this->getJson("/api/boxes/{$box->id}")->assertOk()->assertJsonCount(1, 'equipment');

        $this->deleteJson("/api/boxes/{$box->id}")->assertNoContent();
        $this->assertModelMissing($box);
        $this->assertNotNull($kept->fresh());
    }

    public function test_box_labels_list_the_names_inside(): void
    {
        $box = Box::create(['number' => '7', 'name' => 'أدوات']);
        $named = Equipment::create(['serial_number' => 'S-1', 'name' => 'مولد']);
        $unnamed = Equipment::create(['serial_number' => 'S-2']);
        $box->equipment()->attach([$named->id, $unnamed->id]);

        $this->getJson('/api/boxes/labels?ids[]='.$box->id)->assertOk()
            ->assertJsonPath('0.number', '7')
            ->assertJsonPath('0.items', ['مولد', 'S-2']);
    }

    public function test_equipment_photo_can_be_added_replaced_and_removed(): void
    {
        Storage::fake();
        $equipment = Equipment::create(['serial_number' => 'P-1']);

        $this->postJson("/api/equipment/{$equipment->id}/photo", ['photo' => UploadedFile::fake()->image('a.jpg')])->assertUnauthorized();

        $this->signIn();
        $first = $this->postJson("/api/equipment/{$equipment->id}/photo", ['photo' => UploadedFile::fake()->image('a.jpg')])->assertOk()->json('photo_url');
        $firstPath = $equipment->fresh()->photo_path;
        Storage::assertExists($firstPath);
        $this->get($first)->assertOk();

        $second = $this->postJson("/api/equipment/{$equipment->id}/photo", ['photo' => UploadedFile::fake()->image('b.png')])->assertOk()->json('photo_url');
        $this->assertNotSame($first, $second);
        Storage::assertMissing($firstPath);
        $this->getJson("/api/equipment/{$equipment->id}")->assertJsonPath('photo_url', $second);

        $this->postJson("/api/equipment/{$equipment->id}/photo", ['photo' => UploadedFile::fake()->create('x.pdf', 10)])->assertJsonValidationErrors('photo');

        $this->deleteJson("/api/equipment/{$equipment->id}/photo")->assertOk()->assertJsonPath('photo_url', null);
        $this->assertNull($equipment->fresh()->photo_path);
        $this->get("/api/equipment/{$equipment->id}/photo")->assertNotFound();
    }

    public function test_a_whole_group_can_be_put_in_and_taken_out_of_a_box(): void
    {
        $this->signIn();
        $box = Box::create(['number' => '1']);
        $group = EquipmentGroup::create(['name' => 'وحدة الفتح والقص']);
        $first = Equipment::create(['serial_number' => 'G-1', 'group_id' => $group->id]);
        Equipment::create(['serial_number' => 'G-2', 'group_id' => $group->id]);
        Equipment::create(['serial_number' => 'G-1-A', 'parent_id' => $first->id]);
        Equipment::create(['serial_number' => 'OTHER']);

        $this->postJson("/api/boxes/{$box->id}/equipment", ['group_ids' => [$group->id]])->assertOk()
            ->assertJsonPath('added', 3)
            ->assertJsonPath('box.equipment.0.group.name', 'وحدة الفتح والقص')
            // The accessory shows under its main equipment's group
            ->assertJsonPath('box.equipment.1.serial_number', 'G-1-A')
            ->assertJsonPath('box.equipment.1.group.id', $group->id);

        $ids = $group->equipment()->pluck('id')->all();
        $this->postJson("/api/boxes/{$box->id}/equipment/remove", ['ids' => $ids])->assertOk()->assertJsonCount(0, 'equipment');
    }
}
