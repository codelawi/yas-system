<?php

namespace Tests\Feature;

use App\Models\Equipment;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class EquipmentListTest extends TestCase
{
    use RefreshDatabase;

    public function test_display_name_falls_back_to_a_name_like_field(): void
    {
        $named = Equipment::create(['serial_number' => 'A-1', 'name' => 'تمساح']);
        $fromField = Equipment::create(['serial_number' => 'A-2']);
        $fromField->syncFields([['key' => 'سنة الصنع', 'value' => '2020'], ['key' => 'اسم المعدة', 'value' => "طقم إنقاذ\nسطر ثاني"]]);
        Equipment::create(['serial_number' => 'A-3']);

        $names = collect($this->getJson('/api/equipment?per_page=50')->assertOk()->json('data'))->pluck('display_name', 'serial_number');

        $this->assertSame('تمساح', $names['A-1']);
        $this->assertSame('طقم إنقاذ', $names['A-2']);
        $this->assertNull($names['A-3']);
    }

    public function test_bulk_delete_removes_equipment_with_their_accessories(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $main = Equipment::create(['serial_number' => 'MAIN-1']);
        $accessory = Equipment::create(['serial_number' => 'ACC-1', 'parent_id' => $main->id]);
        $other = Equipment::create(['serial_number' => 'OTHER-1']);
        $kept = Equipment::create(['serial_number' => 'KEEP-1']);

        // The accessory is also selected: it must not be counted twice
        $this->postJson('/api/equipment/bulk-delete', ['ids' => [$main->id, $accessory->id, $other->id]])
            ->assertOk()
            ->assertJson(['deleted' => 3]);

        $this->assertSoftDeleted($main);
        $this->assertSoftDeleted($accessory);
        $this->assertSoftDeleted($other);
        $this->assertNotSoftDeleted($kept);
    }

    public function test_bulk_delete_needs_a_pin(): void
    {
        $equipment = Equipment::create(['serial_number' => 'X-1']);

        $this->postJson('/api/equipment/bulk-delete', ['ids' => [$equipment->id]])->assertUnauthorized();
        $this->assertNotSoftDeleted($equipment);
    }

    public function test_deleting_more_than_five_needs_the_pin_again(): void
    {
        $user = User::factory()->create(['pin' => '4321']);
        Sanctum::actingAs($user);
        $ids = collect(range(1, 6))->map(fn ($i) => Equipment::create(['serial_number' => "BIG-{$i}"])->id)->all();

        $this->postJson('/api/equipment/bulk-delete', ['ids' => $ids])
            ->assertUnprocessable()->assertJsonPath('errors.pin.0', 'pin_required:6');
        $this->postJson('/api/equipment/bulk-delete', ['ids' => $ids, 'pin' => '0000'])
            ->assertUnprocessable()->assertJsonPath('errors.pin.0', 'wrong_pin');
        $this->assertSame(6, Equipment::count());

        $this->postJson('/api/equipment/bulk-delete', ['ids' => $ids, 'pin' => '4321'])->assertOk()->assertJson(['deleted' => 6]);
    }

    public function test_five_or_fewer_do_not_need_the_pin_again(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $ids = collect(range(1, 5))->map(fn ($i) => Equipment::create(['serial_number' => "S-{$i}"])->id)->all();

        $this->postJson('/api/equipment/bulk-delete', ['ids' => $ids])->assertOk()->assertJson(['deleted' => 5]);
    }

    public function test_accessories_count_towards_the_limit(): void
    {
        Sanctum::actingAs(User::factory()->create(['pin' => '4321']));
        $set = Equipment::create(['serial_number' => 'SET-1']);
        foreach (range(1, 5) as $i) {
            Equipment::create(['serial_number' => "SET-1-A{$i}", 'parent_id' => $set->id]);
        }

        // 1 set + 5 accessories = 6
        $this->deleteJson('/api/equipment/'.$set->id)->assertUnprocessable()->assertJsonPath('errors.pin.0', 'pin_required:6');
        $this->deleteJson('/api/equipment/'.$set->id, ['pin' => '4321'])->assertNoContent();
        $this->assertSame(0, Equipment::count());
    }

    public function test_labels_include_fields_for_the_label_designer(): void
    {
        $main = Equipment::create(['serial_number' => 'L-1', 'row_no' => 3]);
        $main->syncFields([['key' => 'المكان', 'value' => 'المستودع']]);
        $accessory = Equipment::create(['serial_number' => 'L-1-A', 'name' => 'تمساح', 'parent_id' => $main->id]);

        $labels = $this->getJson("/api/equipment/labels?ids[]={$main->id}&ids[]={$accessory->id}")->assertOk()->json();

        $this->assertSame([['key' => 'المكان', 'value' => 'المستودع']], $labels[0]['fields']);
        $this->assertSame(3, $labels[0]['row_no']);
        $this->assertSame('L-1', $labels[1]['parent_serial']);
        $this->assertSame('تمساح', $labels[1]['display_name']);
    }

    public function test_label_design_is_saved_as_json(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());
        $design = json_encode(['width' => 50, 'height' => 30, 'elements' => [['id' => 'a', 'type' => 'qr', 'x' => 1, 'y' => 1, 'w' => 20, 'h' => 20]]]);

        $this->putJson('/api/settings', ['label_template' => $design])->assertOk()->assertJsonPath('label_template', $design);
        $this->putJson('/api/settings', ['label_template' => '{broken'])->assertUnprocessable();
    }
}
