<?php

namespace Tests\Feature;

use App\Models\ActivityLog;
use App\Models\Custody;
use App\Models\Equipment;
use App\Models\IssueReport;
use App\Models\MaintenanceSchedule;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class OperationsTest extends TestCase
{
    use RefreshDatabase;

    // ------------------------------------------------------------ maintenance

    public function test_repeating_date_moves_forward_when_done(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $e = Equipment::create(['serial_number' => 'M-1']);
        $id = $this->postJson("/api/equipment/{$e->id}/maintenance", ['title' => 'فحص سنوي', 'due_date' => '2026-01-10', 'interval_months' => 12])->assertCreated()->json('id');

        $this->postJson("/api/maintenance/{$id}/complete", ['done_at' => '2026-01-15', 'notes' => 'تم', 'cost' => 50])
            ->assertOk()->assertJsonPath('schedule.due_date', '2027-01-15');
        $this->getJson("/api/equipment/{$e->id}/maintenance")->assertJsonCount(1, 'records')->assertJsonPath('records.0.title', 'فحص سنوي');
        $this->assertSame(1, ActivityLog::where('action', 'maintenance_done')->count());
    }

    public function test_one_time_date_disappears_when_done_and_due_list(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $e = Equipment::create(['serial_number' => 'M-2']);
        $s = MaintenanceSchedule::create(['equipment_id' => $e->id, 'title' => 'انتهاء الضمان', 'due_date' => now()->subDay()->toDateString()]);

        $this->getJson('/api/maintenance/due')->assertJsonCount(1);
        $this->getJson('/api/stats')->assertJsonPath('maintenance.overdue', 1);
        $this->postJson("/api/maintenance/{$s->id}/complete")->assertOk()->assertJsonPath('schedule', null);
        $this->assertSame(0, MaintenanceSchedule::count());
    }

    // ------------------------------------------------------------ custody

    public function test_hand_over_with_accessories_and_take_back(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $main = Equipment::create(['serial_number' => 'K-1']);
        Equipment::create(['serial_number' => 'K-1-A', 'parent_id' => $main->id]);

        $this->postJson("/api/equipment/{$main->id}/custody", ['holder' => 'أحمد', 'due_back_at' => now()->subDay()->toDateString(), 'include_accessories' => true])
            ->assertOk()->assertJson(['handed_over' => 2]);
        $this->postJson("/api/equipment/{$main->id}/custody", ['holder' => 'سالم'])->assertUnprocessable()->assertJsonPath('errors.holder.0', 'already_in_custody');
        $this->getJson('/api/custody')->assertJsonCount(2, 'open')->assertJsonPath('holders.0', 'أحمد');
        $this->getJson('/api/stats')->assertJsonPath('custody.overdue', 2);

        $this->postJson("/api/equipment/{$main->id}/custody/return", ['return_notes' => 'سليم'])->assertOk()->assertJson(['received' => 2]);
        $this->assertSame(0, Custody::open()->count());
        $this->assertSame(2, ActivityLog::where('action', 'custody_in')->count());
    }

    public function test_custody_needs_a_pin_and_names_are_private(): void
    {
        $e = Equipment::create(['serial_number' => 'K-2']);
        Custody::create(['equipment_id' => $e->id, 'holder' => 'سري', 'handed_at' => now(), 'due_back_at' => now()->addDay()]);

        $this->getJson('/api/custody')->assertUnauthorized();
        $this->postJson("/api/equipment/{$e->id}/custody", ['holder' => 'x'])->assertUnauthorized();
        $this->getJson('/api/stats')->assertJsonPath('custody.open', 1)->assertJsonPath('custody.items', null);
    }

    // ------------------------------------------------------------ damage reports

    public function test_anyone_can_report_a_problem_with_a_photo_and_a_pin_closes_it(): void
    {
        Storage::fake('local');
        $e = Equipment::create(['serial_number' => 'I-1']);

        $id = $this->post("/api/equipment/{$e->id}/issues", ['description' => 'الخرطوم مقطوع', 'reporter' => 'حارس', 'photo' => UploadedFile::fake()->image('p.jpg')], ['Accept' => 'application/json'])
            ->assertCreated()->assertJsonPath('has_photo', true)->json('id');
        $this->get("/api/issues/{$id}/photo")->assertOk();
        $this->getJson('/api/stats')->assertJsonPath('issues.open', 1);
        $this->postJson("/api/issues/{$id}/close")->assertUnauthorized();

        Sanctum::actingAs(User::factory()->create());
        $this->postJson("/api/issues/{$id}/close", ['resolution' => 'تم تغييره'])->assertOk()->assertJsonPath('status', 'closed');
        $this->assertSame(0, IssueReport::where('status', 'open')->count());
    }

    // ------------------------------------------------------------ stocktake

    public function test_stocktake_reports_found_missing_unexpected_and_unknown(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $here = fn ($serial) => tap(Equipment::create(['serial_number' => $serial]))->syncFields([['key' => 'المكان', 'value' => 'المستودع A']]);
        $here('S-1');
        $here('S-2');
        Equipment::create(['serial_number' => 'S-9'])->syncFields([['key' => 'المكان', 'value' => 'المستودع B']]);

        $id = $this->postJson('/api/stocktakes', ['name' => 'جرد A', 'filters' => [['key' => 'المكان', 'value' => 'المستودع A']]])->assertCreated()->json('id');

        $this->postJson("/api/stocktakes/{$id}/scan", ['code' => 'http://repo.local/eq/S-1'])->assertJsonPath('status', 'found');
        $this->postJson("/api/stocktakes/{$id}/scan", ['code' => 'S-1'])->assertJsonPath('status', 'already');
        $this->postJson("/api/stocktakes/{$id}/scan", ['code' => 'S-9'])->assertJsonPath('status', 'unexpected');
        $this->postJson("/api/stocktakes/{$id}/scan", ['code' => 'NOPE-1'])->assertJsonPath('status', 'unknown');

        $this->getJson("/api/stocktakes/{$id}")
            ->assertJsonPath('counts', ['expected' => 2, 'found' => 1, 'missing' => 1, 'unexpected' => 1, 'unknown' => 1])
            ->assertJsonPath('missing.0.serial_number', 'S-2')
            ->assertJsonPath('unexpected.0.location', 'المستودع B');

        $this->postJson("/api/stocktakes/{$id}/close")->assertOk();
        $this->postJson("/api/stocktakes/{$id}/scan", ['code' => 'S-2'])->assertUnprocessable();
        $this->get("/api/stocktakes/{$id}/export")->assertOk()->assertDownload("stocktake-{$id}.xlsx");
    }
}
