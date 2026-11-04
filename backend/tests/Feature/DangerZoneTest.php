<?php

namespace Tests\Feature;

use App\Models\ActivityLog;
use App\Models\Custody;
use App\Models\CustodyForm;
use App\Models\Equipment;
use App\Models\IssueReport;
use App\Models\Setting;
use App\Models\Stocktake;
use App\Models\User;
use App\Services\BackupManager;
use Illuminate\Foundation\Testing\DatabaseMigrations;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class DangerZoneTest extends TestCase
{
    use DatabaseMigrations;

    private string $folder;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
        $this->folder = sys_get_temp_dir().'/repo-danger-test-'.uniqid();
        Setting::create(['key' => 'backup_path', 'value' => $this->folder]);
        Sanctum::actingAs(User::factory()->admin()->create(['pin' => '246810']));
    }

    protected function tearDown(): void
    {
        File::deleteDirectory($this->folder);

        parent::tearDown();
    }

    private function backups(): array
    {
        return $this->app->make(BackupManager::class)->list();
    }

    private function seedData(): Equipment
    {
        $main = Equipment::create(['serial_number' => 'D-1']);
        Equipment::create(['serial_number' => 'D-1-A', 'parent_id' => $main->id]);
        Equipment::create(['serial_number' => 'D-OLD'])->delete();
        ActivityLog::record($main, 'created');
        Custody::create(['equipment_id' => $main->id, 'holder' => 'سالم', 'handed_at' => now()]);
        Storage::put('issues/p.jpg', 'photo');
        IssueReport::create(['equipment_id' => $main->id, 'description' => 'كسر', 'photo_path' => 'issues/p.jpg']);
        Stocktake::create(['name' => 'جرد', 'status' => 'open']);
        CustodyForm::create(['name' => 'سند', 'kind' => 'pdf', 'file_path' => 'custody_forms/x.pdf', 'original_name' => 'x.pdf']);

        return $main;
    }

    public function test_clearing_needs_the_pin_and_makes_a_safety_backup_first(): void
    {
        $this->seedData();

        $this->postJson('/api/danger/clear', ['target' => 'history'])->assertUnprocessable()->assertJsonPath('errors.pin.0', 'pin_required');
        $this->postJson('/api/danger/clear', ['target' => 'history', 'pin' => '000000'])->assertUnprocessable()->assertJsonPath('errors.pin.0', 'wrong_pin');
        $this->assertSame(1, ActivityLog::count());
        $this->assertCount(0, $this->backups());

        $this->postJson('/api/danger/clear', ['target' => 'history', 'pin' => '246810'])->assertOk()->assertJsonPath('deleted', 1);
        $this->assertSame(0, ActivityLog::count());
        $this->assertSame(2, Equipment::count(), 'only the history was cleared');
        $this->assertCount(1, $this->backups());
        $this->assertStringContainsString('before-clear-history', $this->backups()[0]['file']);
    }

    public function test_clearing_equipment_removes_linked_records_and_files_but_keeps_forms(): void
    {
        $this->seedData();
        $this->getJson('/api/danger')->assertOk()->assertJsonPath('equipment', 3)->assertJsonPath('custody', 1);

        $this->postJson('/api/danger/clear', ['target' => 'equipment', 'pin' => '246810'])->assertOk()->assertJsonPath('deleted', 3);

        $this->assertSame(0, Equipment::withTrashed()->count());
        $this->assertSame(0, Custody::count());
        $this->assertSame(0, IssueReport::count());
        $this->assertFalse(Storage::exists('issues/p.jpg'));
        $this->assertSame(1, CustodyForm::count());
        $this->assertSame(1, Stocktake::count(), 'stocktakes are cleared on their own');
    }

    public function test_backups_can_be_deleted_one_or_all(): void
    {
        $manager = $this->app->make(BackupManager::class);
        $first = $manager->create('one')['file'];
        sleep(1);
        $manager->create('two');

        $this->postJson('/api/backups/delete', ['file' => $first])->assertUnprocessable()->assertJsonPath('errors.pin.0', 'pin_required');
        $this->postJson('/api/backups/delete', ['file' => '../.env', 'pin' => '246810'])->assertUnprocessable();
        $this->postJson('/api/backups/delete', ['file' => $first, 'pin' => '246810'])->assertOk()->assertJsonPath('deleted', 1);
        $this->assertCount(1, $this->backups());

        $this->postJson('/api/backups/delete', ['pin' => '246810'])->assertOk()->assertJsonPath('deleted', 1);
        $this->assertCount(0, $this->backups());
    }

    public function test_only_admins(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $this->getJson('/api/danger')->assertForbidden();
        $this->postJson('/api/danger/clear', ['target' => 'all'])->assertForbidden();
        $this->postJson('/api/backups/delete', [])->assertForbidden();
    }
}
