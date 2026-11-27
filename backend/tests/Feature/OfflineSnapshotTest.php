<?php

namespace Tests\Feature;

use App\Models\ActivityLog;
use App\Models\Box;
use App\Models\Equipment;
use App\Models\EquipmentGroup;
use App\Models\IssueReport;
use App\Models\User;
use App\Support\OfflinePin;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class OfflineSnapshotTest extends TestCase
{
    use RefreshDatabase;

    private function signIn(): User
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        return $user;
    }

    public function test_the_snapshot_needs_a_pin(): void
    {
        $this->getJson('/api/offline/snapshot')->assertUnauthorized();
    }

    public function test_the_snapshot_holds_the_same_pages_the_phone_would_open_online(): void
    {
        $this->signIn();
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
        $this->assertSame($this->getJson('/api/stats')->json(), $snapshot['stats']);
        $this->assertArrayNotHasKey($accessory->id, $snapshot['maintenance']);
    }

    public function test_groups_are_sent_as_items_for_the_phone_to_list(): void
    {
        $this->signIn();
        $group = EquipmentGroup::create(['name' => 'منشار', 'voucher_code' => 'ان ٤١', 'voucher_name' => 'منشار قص']);

        $groups = $this->getJson('/api/offline/snapshot')->json('groups');

        // The list adds how many equipment each group holds; the phone counts them itself
        $online = $this->getJson('/api/groups')->json();
        unset($online[0]['equipment_count']);
        $this->assertSame($online, $groups);
        $this->assertSame([$group->id, 'منشار', 'ان ٤١', 'منشار قص'], [$groups[0]['id'], $groups[0]['name'], $groups[0]['voucher_code'], $groups[0]['voucher_name']]);
    }

    public function test_vouchers_are_sent_whole_with_every_voucher_page(): void
    {
        $this->signIn();
        $saw = EquipmentGroup::create(['name' => 'منشار', 'voucher_code' => 'ان ٤١']);
        Equipment::create(['serial_number' => 'SAW-1', 'group_id' => $saw->id]);
        Equipment::create(['serial_number' => 'SAW-2', 'group_id' => $saw->id]);
        $issued = $this->postJson('/api/vouchers')->json('voucher.id');
        $this->postJson("/api/vouchers/{$issued}/items", ['code' => 'SAW-1'])->assertOk();
        $this->postJson("/api/vouchers/{$issued}/issue", ['recipient' => 'سالم الخطيب', 'copies' => 0])->assertOk();
        $draft = $this->postJson('/api/vouchers')->json('voucher.id');
        $this->postJson("/api/vouchers/{$draft}/items", ['code' => 'SAW-2'])->assertOk();

        $vouchers = $this->getJson('/api/offline/snapshot')->json('vouchers');

        $online = $this->getJson('/api/vouchers')->json();
        $this->assertSame($online['vouchers'], $vouchers['list']);
        $this->assertSame($online['next_number'], $vouchers['next_number']);
        $this->assertSame($this->getJson("/api/vouchers/{$issued}")->json(), $vouchers['pages'][$issued]);
        $this->assertSame($this->getJson("/api/vouchers/{$draft}")->json(), $vouchers['pages'][$draft]);
        $this->assertSame($this->getJson('/api/vouchers/recipients')->json(), $vouchers['recipients']);
        $this->assertSame(['سالم الخطيب'], $vouchers['recipients']);
        $this->assertSame($this->getJson('/api/voucher-templates')->json(), $vouchers['templates']);

        // The rows themselves, for the phone to issue and take back without a connection
        $this->assertSame([$issued, $draft], array_column($vouchers['records']['vouchers'], 'id'));
        $this->assertArrayHasKey('layout', $vouchers['records']['vouchers'][0]);
        $this->assertSame([[$issued, 'SAW-1'], [$draft, 'SAW-2']], array_map(fn (array $item) => [$item['voucher_id'], Equipment::find($item['equipment_id'])->serial_number], $vouchers['records']['items']));
        $custody = $vouchers['records']['custodies'];
        $this->assertCount(1, $custody);
        $this->assertSame([$issued, 'سالم الخطيب', null], [$custody[0]['voucher_id'], $custody[0]['holder'], $custody[0]['returned_at']]);
        $default = $vouchers['default_template'];
        // A draft shows its template as it is now
        $this->assertSame($this->getJson("/api/vouchers/{$draft}")->json('layout'), $vouchers['layouts'][$default]);
        $this->assertSame(1, $vouchers['copies']);
    }

    public function test_scan_documents_are_sent_with_their_folders_and_revisions(): void
    {
        $this->signIn();
        $folder = $this->postJson('/api/scan-folders', ['name' => 'جرد المستودع'])->assertCreated()->json('id');
        $document = $this->postJson('/api/scan-documents', ['scan_folder_id' => $folder, 'title' => 'الرف 1'])->assertCreated()->json('id');
        $this->postJson("/api/scan-documents/{$document}/scan", ['code' => 'ABC-1'])->assertOk();

        $scan = $this->getJson('/api/offline/snapshot')->json('scan');

        $this->assertSame($this->getJson('/api/scan-folders')->json(), $scan['folders']);
        $this->assertSame($this->getJson('/api/scan-folders/revision')->json('revision'), $scan['revision']);
        $this->assertSame($this->getJson("/api/scan-folders/{$folder}")->json(), $scan['folder_pages'][$folder]);
        $this->assertSame($this->getJson("/api/scan-folders/{$folder}/revision")->json('revision'), $scan['folder_revisions'][$folder]);
        $this->assertSame($this->getJson("/api/scan-documents/{$document}")->json(), $scan['documents'][$document]);
    }

    public function test_a_serial_opens_the_main_equipment_before_an_accessory_like_a_scan_does(): void
    {
        $this->signIn();
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

    public function test_equipment_pages_never_carry_their_change_history(): void
    {
        $this->signIn();
        $main = Equipment::create(['serial_number' => 'S-1']);
        ActivityLog::record($main, 'created');

        $this->assertArrayNotHasKey('logs', $this->getJson('/api/offline/snapshot')->json('equipment.0'));
    }

    public function test_users_unlock_the_phone_offline_once_their_pin_was_typed(): void
    {
        $admin = User::factory()->create(['name' => 'مدير', 'pin' => '135790', 'role' => 'admin']);
        User::factory()->create(['name' => 'لم يدخل بعد', 'pin' => '864200']);
        User::factory()->create(['name' => 'موقوف', 'pin' => '112233', 'is_active' => false, 'offline_pin' => OfflinePin::make('112233')]);
        $token = $this->postJson('/api/auth/login', ['pin' => '135790'])->assertOk()->json('token');

        $users = $this->withToken($token)->getJson('/api/offline/snapshot')->assertOk()->json('users');

        $this->assertCount(1, $users);
        $this->assertSame(['id' => $admin->id, 'name' => 'مدير', 'role' => 'admin'], array_diff_key($users[0], ['offline_pin' => 0]));
        $this->assertTrue(OfflinePin::matches('135790', $users[0]['offline_pin']));
        $this->assertFalse(OfflinePin::matches('135791', $users[0]['offline_pin']));
        // Never the bcrypt hash the server checks
        $this->assertStringNotContainsString($admin->fresh()->pin, json_encode($users));
    }

    public function test_a_new_or_changed_pin_is_ready_for_offline_at_once(): void
    {
        Sanctum::actingAs(User::factory()->create(['role' => 'admin']));

        $id = $this->postJson('/api/users', ['name' => 'جديد', 'pin' => '445566', 'role' => 'editor'])->assertOk()->json('id');
        $this->assertTrue(OfflinePin::matches('445566', User::find($id)->offline_pin));

        $this->putJson("/api/users/{$id}", ['name' => 'جديد', 'pin' => '778899', 'role' => 'editor'])->assertOk();
        $this->assertTrue(OfflinePin::matches('778899', User::find($id)->offline_pin));
        $this->assertFalse(OfflinePin::matches('445566', User::find($id)->offline_pin));
        $this->assertArrayNotHasKey('offline_pin', User::find($id)->toArray());
    }

    public function test_an_offline_pin_hash_is_salted_and_rejects_anything_malformed(): void
    {
        $hash = OfflinePin::make('2468');

        $this->assertMatchesRegularExpression('#^pbkdf2_sha256\$20000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$#', $hash);
        $this->assertNotSame($hash, OfflinePin::make('2468'));
        $this->assertTrue(OfflinePin::matches('2468', $hash));
        foreach ([null, '', 'x', 'bcrypt$1$a$b', 'pbkdf2_sha256$0$AA==$AA==', 'pbkdf2_sha256$10$*$*'] as $bad) {
            $this->assertFalse(OfflinePin::matches('2468', $bad));
        }
    }

    public function test_an_empty_system_still_sends_maps_not_lists(): void
    {
        $this->signIn();

        $content = $this->getJson('/api/offline/snapshot')->assertOk()->assertJsonPath('equipment', [])->getContent();

        // The phone looks pages up by key: an empty map must stay {} in the JSON
        foreach (['serials', 'maintenance', 'issues', 'pages', 'folder_pages', 'folder_revisions', 'documents', 'last_fields'] as $key) {
            $this->assertStringContainsString('"'.$key.'":{}', $content);
        }
    }
}
