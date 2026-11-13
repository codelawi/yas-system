<?php

namespace Tests\Feature;

use App\Models\ActivityLog;
use App\Models\Box;
use App\Models\Custody;
use App\Models\Equipment;
use App\Models\EquipmentGroup;
use App\Models\IssueReport;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class OfflineSnapshotTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_snapshot_holds_the_same_pages_the_phone_would_open_online(): void
    {
        $group = EquipmentGroup::create(['name' => 'وحدة القص']);
        $main = Equipment::create(['serial_number' => 'LK-1', 'name' => 'مضخة', 'group_id' => $group->id, 'row_no' => 3]);
        $main->syncFields([['key' => 'المكان', 'value' => 'مستودع 2']]);
        $accessory = Equipment::create(['serial_number' => 'LK-1-A', 'parent_id' => $main->id, 'name' => 'خرطوم']);
        $accessory->syncFields([['key' => 'عدد', 'value' => '2']]);
        $box = Box::create(['number' => '7', 'name' => 'إسعافات', 'weight' => 4.5]);
        $box->equipment()->attach([$main->id, $accessory->id]);
        $main->schedules()->create(['title' => 'فحص', 'due_date' => now()->addMonth()]);
        IssueReport::create(['equipment_id' => $main->id, 'description' => 'تسريب']);

        $snapshot = $this->getJson('/api/offline/snapshot')->assertOk()->json();

        $this->assertSame(Equipment::count(), count($snapshot['equipment']));
        foreach ($snapshot['equipment'] as $page) {
            $online = $this->getJson("/api/equipment/{$page['id']}")->json();
            unset($online['logs']);
            $this->assertSame($online, $page);
        }
        $this->assertSame($this->getJson("/api/boxes/{$box->id}")->json(), $snapshot['boxes'][0]);
        $this->assertSame($this->getJson("/api/equipment/{$main->id}/maintenance")->json(), $snapshot['maintenance'][$main->id]);
        $this->assertSame($this->getJson("/api/equipment/{$main->id}/issues")->json(), $snapshot['issues'][$main->id]);
        $this->assertSame($this->getJson('/api/settings')->json(), $snapshot['settings']);
        $this->assertArrayNotHasKey($accessory->id, $snapshot['maintenance']);
    }

    public function test_a_serial_opens_the_main_equipment_before_an_accessory_like_a_scan_does(): void
    {
        $accessoryFirst = Equipment::create(['serial_number' => 'P-1', 'parent_id' => Equipment::create(['serial_number' => 'M-0'])->id]);
        $main = Equipment::create(['serial_number' => 'P-1']);
        $onlyAccessory = Equipment::create(['serial_number' => 'ACC-9', 'parent_id' => $main->id]);
        Equipment::create(['serial_number' => null, 'parent_id' => $main->id]);
        Equipment::create(['serial_number' => 'GONE-1'])->delete();

        $serials = $this->getJson('/api/offline/snapshot')->json('serials');

        $this->assertSame($this->getJson('/api/equipment/serial/P-1')->json('id'), $serials['P-1']);
        $this->assertSame($main->id, $serials['P-1']);
        $this->assertNotSame($accessoryFirst->id, $serials['P-1']);
        $this->assertSame($onlyAccessory->id, $serials['ACC-9']);
        $this->assertArrayNotHasKey('GONE-1', $serials);
        $this->assertCount(3, $serials);
    }

    public function test_the_snapshot_never_holds_history_or_custody_holders_even_with_a_pin(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $main = Equipment::create(['serial_number' => 'S-1']);
        ActivityLog::record($main, 'created');
        Custody::create(['equipment_id' => $main->id, 'holder' => 'سالم الخطيب', 'handed_at' => now()]);

        $response = $this->getJson('/api/offline/snapshot')->assertOk();

        $this->assertArrayNotHasKey('logs', $response->json('equipment.0'));
        $this->assertStringNotContainsString('سالم الخطيب', $response->getContent());
    }

    public function test_an_empty_system_still_sends_maps_not_lists(): void
    {
        $content = $this->getJson('/api/offline/snapshot')->assertOk()->assertJsonPath('equipment', [])->getContent();

        // The phone looks pages up by key: an empty map must stay {} in the JSON
        foreach (['serials', 'maintenance', 'issues'] as $key) {
            $this->assertStringContainsString('"'.$key.'":{}', $content);
        }
    }
}
