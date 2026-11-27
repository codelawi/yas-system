<?php

namespace Tests\Feature;

use App\Models\ActivityLog;
use App\Models\Box;
use App\Models\Equipment;
use App\Models\OfflineChange;
use App\Models\ScanDocument;
use App\Models\ScanFolder;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/** A phone sending the changes it made without a connection (App\Http\Middleware\ApplyOfflineChange). */
class OfflineSyncTest extends TestCase
{
    use RefreshDatabase;

    private User $syncing;

    protected function setUp(): void
    {
        parent::setUp();
        $this->syncing = User::factory()->create(['name' => 'من يزامن']);
        Sanctum::actingAs($this->syncing);
    }

    /** @return array<string, string> */
    private function offline(?User $by = null, ?string $at = null, ?string $key = null): array
    {
        return array_filter([
            'X-Offline-Change' => $key ?? (string) Str::uuid(),
            'X-Offline-User' => $by ? (string) $by->id : null,
            'X-Offline-At' => $at,
        ]);
    }

    public function test_a_change_sent_again_gets_its_first_answer_and_is_saved_once(): void
    {
        $headers = $this->offline();

        $first = $this->postJson('/api/equipment', ['serial_number' => 'OF-1'], $headers)->assertOk();
        $again = $this->postJson('/api/equipment', ['serial_number' => 'OF-1'], $headers)->assertOk()->assertHeader('X-Offline-Replayed', '1');

        $this->assertSame($first->json('id'), $again->json('id'));
        $this->assertSame(1, Equipment::count());
        $this->assertSame(1, OfflineChange::count());
    }

    public function test_the_phone_can_ask_which_of_its_changes_are_saved(): void
    {
        $this->postJson('/api/equipment', ['serial_number' => 'OF-K'], $this->offline(key: 'saved-key'))->assertOk();
        $this->postJson('/api/equipment', ['serial_number' => ''], $this->offline(key: 'refused-key'))->assertUnprocessable();

        $this->postJson('/api/offline/done', ['keys' => ['saved-key', 'refused-key', 'unknown']])
            ->assertOk()
            ->assertExactJson(['done' => ['saved-key']]);
    }

    public function test_the_history_keeps_who_made_the_change_on_the_phone_and_when(): void
    {
        $worker = User::factory()->create(['name' => 'على الهاتف']);
        $at = now()->subHours(3)->startOfSecond();

        $id = $this->postJson('/api/equipment', ['serial_number' => 'OF-2'], $this->offline($worker, $at->toIso8601String()))->json('id');

        $log = ActivityLog::where('equipment_id', $id)->where('action', 'created')->sole();
        $this->assertSame($worker->id, $log->user_id);
        $this->assertTrue($log->created_at->equalTo($at));
        $this->assertTrue($log->changes['offline']);
        $this->assertSame($worker->id, Equipment::find($id)->created_by);
        $change = OfflineChange::sole();
        $this->assertSame([$worker->id, $this->syncing->id], [$change->user_id, $change->synced_by]);
    }

    public function test_a_time_from_the_future_or_long_ago_is_taken_as_now(): void
    {
        foreach ([now()->addDay(), now()->subDays(60)] as $i => $at) {
            $id = $this->postJson('/api/equipment', ['serial_number' => "OF-T$i"], $this->offline(null, $at->toIso8601String()))->json('id');
            $log = ActivityLog::where('equipment_id', $id)->sole();
            $this->assertTrue($log->created_at->diffInSeconds(now(), true) < 5);
        }
    }

    public function test_an_inactive_or_unknown_person_is_replaced_by_the_one_syncing(): void
    {
        $gone = User::factory()->create(['is_active' => false]);

        $id = $this->postJson('/api/equipment', ['serial_number' => 'OF-3'], $this->offline($gone))->json('id');
        $this->postJson('/api/equipment', ['serial_number' => 'OF-4'], ['X-Offline-Change' => 'k-4', 'X-Offline-User' => '999999'])->assertOk();

        $this->assertSame($this->syncing->id, Equipment::find($id)->created_by);
        $this->assertSame($this->syncing->id, Equipment::where('serial_number', 'OF-4')->sole()->created_by);
    }

    public function test_without_an_offline_change_key_the_request_is_an_ordinary_one(): void
    {
        $worker = User::factory()->create();

        $id = $this->postJson('/api/equipment', ['serial_number' => 'OF-5'], ['X-Offline-User' => (string) $worker->id])->json('id');

        $this->assertSame($this->syncing->id, Equipment::find($id)->created_by);
        $this->assertArrayNotHasKey('offline', ActivityLog::where('equipment_id', $id)->sole()->changes ?? []);
        $this->assertSame(0, OfflineChange::count());
        $this->assertFalse(Equipment::find($id)->label_pending);
    }

    public function test_a_refused_change_is_not_kept_and_can_be_sent_again(): void
    {
        Equipment::create(['serial_number' => 'OF-6']);
        $headers = $this->offline();

        $this->postJson('/api/equipment', ['serial_number' => 'OF-6'], $headers)->assertUnprocessable()->assertJsonPath('errors.serial_number.0', 'serial_taken');
        $this->assertSame(0, OfflineChange::count());

        $this->postJson('/api/equipment', ['serial_number' => 'OF-6b'], $headers)->assertOk();
        $this->assertSame(1, OfflineChange::count());
    }

    public function test_a_delete_sent_again_gets_its_first_answer_although_the_equipment_is_gone(): void
    {
        $equipment = Equipment::create(['serial_number' => 'OF-7']);
        $headers = $this->offline();

        $this->deleteJson("/api/equipment/{$equipment->id}", [], $headers)->assertNoContent();
        $this->deleteJson("/api/equipment/{$equipment->id}", [], $headers)->assertNoContent()->assertHeader('X-Offline-Replayed', '1');
        $this->assertSoftDeleted($equipment);
    }

    public function test_a_change_sent_as_it_is_made_is_an_ordinary_one_saved_with_its_key(): void
    {
        $worker = User::factory()->create();
        $live = ['X-Offline-Change' => 'live-key', 'X-Offline-Live' => '1', 'X-Offline-User' => (string) $worker->id, 'X-Offline-At' => now()->subHours(2)->toIso8601String()];

        $id = $this->postJson('/api/equipment', ['serial_number' => 'OF-L'], $live)->assertOk()->json('id');

        $equipment = Equipment::find($id);
        $this->assertSame($this->syncing->id, $equipment->created_by);
        $this->assertFalse($equipment->label_pending);
        $log = ActivityLog::where('equipment_id', $id)->sole();
        $this->assertArrayNotHasKey('offline', $log->changes ?? []);
        $this->assertTrue($log->created_at->diffInSeconds(now(), true) < 5);
        $change = OfflineChange::sole();
        $this->assertSame(['live-key', $this->syncing->id, $this->syncing->id], [$change->key, $change->user_id, $change->synced_by]);
    }

    public function test_a_change_whose_answer_came_too_late_is_not_done_again_by_the_sync(): void
    {
        $this->postJson('/api/scan-folders', ['name' => 'مجلد'], ['X-Offline-Change' => 'slow-key', 'X-Offline-Live' => '1'])->assertCreated();

        // The phone did not hear back in time: it kept the change and syncs it with the same key
        $this->postJson('/api/offline/done', ['keys' => ['slow-key']])->assertExactJson(['done' => ['slow-key']]);
        $again = $this->postJson('/api/scan-folders', ['name' => 'مجلد'], $this->offline(key: 'slow-key'));

        $again->assertCreated()->assertHeader('X-Offline-Replayed', '1');
        $this->assertSame(1, ScanFolder::count());
        $this->assertSame(ScanFolder::sole()->id, $again->json('id'));
    }

    public function test_a_change_sent_as_it_is_made_still_needs_the_pin_for_large_deletes(): void
    {
        $ids = collect(range(1, 7))->map(fn ($i) => Equipment::create(['serial_number' => "OF-LD$i"])->id)->all();

        $this->postJson('/api/equipment/bulk-delete', ['ids' => $ids], ['X-Offline-Change' => 'live-delete', 'X-Offline-Live' => '1'])
            ->assertUnprocessable()
            ->assertJsonPath('errors.pin.0', 'pin_required:7');
        $this->assertSame(0, OfflineChange::count());
    }

    public function test_the_phone_checked_the_pin_for_large_deletes(): void
    {
        $ids = collect(range(1, 7))->map(fn ($i) => Equipment::create(['serial_number' => "OF-D$i"])->id)->all();

        $this->postJson('/api/equipment/bulk-delete', ['ids' => $ids])->assertUnprocessable()->assertJsonPath('errors.pin.0', 'pin_required:7');
        $this->postJson('/api/equipment/bulk-delete', ['ids' => $ids], $this->offline())->assertOk()->assertJsonPath('deleted', 7);
    }

    public function test_deleted_equipment_can_be_brought_back(): void
    {
        $equipment = Equipment::create(['serial_number' => 'OF-8']);
        $equipment->delete();

        $this->postJson("/api/equipment/{$equipment->id}/restore", [], $this->offline())->assertOk()->assertJsonPath('serial_number', 'OF-8');

        $this->assertNotSoftDeleted($equipment);
        $this->assertSame(['restored'], ActivityLog::where('equipment_id', $equipment->id)->pluck('action')->all());
        // Not deleted: nothing to do
        $this->postJson("/api/equipment/{$equipment->id}/restore")->assertOk();
    }

    public function test_deleted_equipment_whose_serial_is_used_again_stays_deleted(): void
    {
        $equipment = Equipment::create(['serial_number' => 'OF-9']);
        $equipment->delete();
        Equipment::create(['serial_number' => 'OF-9']);
        $accessoryParent = Equipment::create(['serial_number' => 'OF-10']);
        $accessory = Equipment::create(['parent_id' => $accessoryParent->id, 'name' => 'ملحق']);
        $accessory->delete();
        $accessoryParent->delete();

        $this->postJson("/api/equipment/{$equipment->id}/restore")->assertUnprocessable()->assertJsonPath('errors.serial_number.0', 'serial_taken');
        $this->postJson("/api/equipment/{$accessory->id}/restore")->assertUnprocessable()->assertJsonPath('errors.serial_number.0', 'parent_deleted');
        $this->assertSoftDeleted($equipment);
    }

    public function test_equipment_and_boxes_added_on_a_phone_wait_for_their_labels(): void
    {
        $offline = $this->postJson('/api/equipment', ['serial_number' => 'OF-11', 'name' => 'مضخة'], $this->offline())->json('id');
        $this->postJson('/api/equipment', ['parent_id' => $offline, 'name' => 'بلا رقم'], $this->offline())->assertOk();
        $this->postJson('/api/equipment', ['serial_number' => 'OF-12'])->assertOk();
        $box = $this->postJson('/api/boxes', ['number' => '40'], $this->offline())->json('id');
        $this->postJson('/api/boxes', ['number' => '41'])->assertOk();

        $pending = $this->getJson('/api/stats')->json('pending_labels');

        // An accessory without a serial number gets no label
        $this->assertSame([['id' => $offline, 'serial_number' => 'OF-11', 'display_name' => 'مضخة']], $pending['equipment']);
        $this->assertSame([['id' => $box, 'number' => '40', 'name' => null]], $pending['boxes']);
    }

    public function test_printing_or_done_takes_labels_off_the_list_without_touching_the_items(): void
    {
        $first = $this->postJson('/api/equipment', ['serial_number' => 'OF-13'], $this->offline())->json('id');
        $second = $this->postJson('/api/equipment', ['serial_number' => 'OF-14'], $this->offline())->json('id');
        $box = $this->postJson('/api/boxes', ['number' => '42'], $this->offline())->json('id');
        $updated = Equipment::find($first)->updated_at;
        $this->travel(5)->minutes();

        $this->postJson('/api/labels/printed', ['url' => 'https://repo.local', 'count' => 1, 'equipment_ids' => [$first]])->assertOk();
        $this->assertSame([$second], array_column($this->getJson('/api/stats')->json('pending_labels.equipment'), 'id'));

        $this->postJson('/api/labels/pending/clear', ['equipment_ids' => [$second], 'box_ids' => [$box]])->assertNoContent();
        $this->assertSame(['equipment' => [], 'boxes' => []], $this->getJson('/api/stats')->json('pending_labels'));
        $this->assertTrue(Equipment::find($first)->updated_at->equalTo($updated));
        $this->assertFalse(Box::find($box)->label_pending);
    }

    public function test_problem_reports_from_a_sync_are_not_limited_like_reports_from_anyone(): void
    {
        $equipment = Equipment::create(['serial_number' => 'OF-15']);

        foreach (range(1, 12) as $i) {
            $this->postJson("/api/equipment/{$equipment->id}/issues", ['description' => "عطل $i"], $this->offline())->assertCreated();
        }
        $this->assertSame(12, $equipment->issues()->count());
        $this->assertSame(12, ActivityLog::where('action', 'issue_reported')->get()->filter(fn (ActivityLog $log) => $log->changes['offline'] ?? false)->count());
    }

    public function test_a_code_scanned_on_a_phone_keeps_when_and_by_whom(): void
    {
        $worker = User::factory()->create(['name' => 'على الهاتف']);
        $folder = ScanFolder::create(['name' => 'مجلد']);
        $document = ScanDocument::create(['scan_folder_id' => $folder->id, 'title' => 'مستند', 'columns' => ScanDocument::defaultColumns()]);
        $at = now()->subHours(2)->startOfSecond();
        $headers = $this->offline($worker, $at->toIso8601String());

        $first = $this->postJson("/api/scan-documents/{$document->id}/scan", ['code' => 'OF-SCAN'], $headers)->assertOk()->assertJsonPath('status', 'added');
        // Sent again after a sync was cut off: the same answer, not "already scanned"
        $this->postJson("/api/scan-documents/{$document->id}/scan", ['code' => 'OF-SCAN'], $headers)->assertOk()->assertJsonPath('status', 'added')->assertJsonPath('row.id', $first->json('row.id'));

        $row = $document->rows()->sole();
        $this->assertTrue($row->scanned_at->equalTo($at));
        $this->assertSame($worker->id, $row->scanned_by);
    }

    public function test_reports_without_a_sync_are_still_limited(): void
    {
        $equipment = Equipment::create(['serial_number' => 'OF-16']);
        $this->app['auth']->forgetGuards();

        foreach (range(1, 10) as $i) {
            $this->postJson("/api/equipment/{$equipment->id}/issues", ['description' => "عطل $i"])->assertCreated();
        }
        $this->postJson("/api/equipment/{$equipment->id}/issues", ['description' => 'زيادة'])->assertTooManyRequests();
    }
}
