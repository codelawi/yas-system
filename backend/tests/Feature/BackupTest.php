<?php

namespace Tests\Feature;

use App\Models\Equipment;
use App\Models\Setting;
use App\Models\User;
use App\Services\BackupManager;
use Illuminate\Foundation\Testing\DatabaseMigrations;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;
use ZipArchive;

class BackupTest extends TestCase
{
    use DatabaseMigrations;

    private string $folder;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
        $this->folder = sys_get_temp_dir().'/repo-backup-test-'.uniqid();
        Setting::create(['key' => 'backup_path', 'value' => $this->folder]);
    }

    protected function tearDown(): void
    {
        File::deleteDirectory($this->folder);

        parent::tearDown();
    }

    private function manager(): BackupManager
    {
        return $this->app->make(BackupManager::class);
    }

    public function test_backup_contains_the_database_word_files_and_a_manifest(): void
    {
        Storage::put('imports/abc.docx', 'word-content');
        Equipment::create(['serial_number' => 'B-1']);

        $backup = $this->manager()->create('test');

        $zip = new ZipArchive;
        $this->assertTrue($zip->open($this->folder.'/'.$backup['file']));
        $this->assertStringContainsString("'B-1'", $zip->getFromName('database.sql'));
        $this->assertSame('word-content', $zip->getFromName('imports/abc.docx'));
        $this->assertSame(1, json_decode($zip->getFromName('manifest.json'), true)['word_files']);
        $this->assertNotEmpty(Setting::get('last_backup_at'));
    }

    public function test_restore_brings_back_deleted_data_and_keeps_a_safety_backup(): void
    {
        $tricky = "سطر أول;\nسطر ثاني -- @@end ' \" \\ ;";
        $main = Equipment::create(['serial_number' => 'KEEP-ME', 'row_no' => 7]);
        $main->syncFields([['key' => 'ملاحظات', 'value' => $tricky]]);
        $backup = $this->manager()->create('test');

        $main->forceDelete();
        Equipment::create(['serial_number' => 'ADDED-LATER']);

        $safety = $this->manager()->restore($this->folder.'/'.$backup['file']);

        $restored = Equipment::where('serial_number', 'KEEP-ME')->firstOrFail();
        $this->assertSame(7, $restored->row_no);
        $this->assertSame($tricky, $restored->fields()->value('value'));
        $this->assertFalse(Equipment::where('serial_number', 'ADDED-LATER')->exists());
        // The state before the restore is not lost
        $this->assertFileExists($this->folder.'/'.$safety);
    }

    public function test_only_the_newest_backups_are_kept(): void
    {
        Setting::create(['key' => 'backup_keep', 'value' => '3']);
        foreach (range(1, 5) as $i) {
            $file = $this->manager()->create("n{$i}")['file'];
            touch($this->folder.'/'.$file, time() - (10 - $i) * 60);
        }
        $this->manager()->create('last');

        $this->assertCount(3, $this->manager()->list());
    }

    public function test_automatic_backup_runs_once_a_day(): void
    {
        $this->manager()->runIfDue();
        $this->manager()->runIfDue();

        $this->assertCount(1, $this->manager()->list());
    }

    public function test_admins_can_back_up_and_download_from_the_api(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());

        $file = $this->postJson('/api/backups')->assertOk()->json('file');
        $this->getJson('/api/backups')->assertOk()->assertJsonPath('backups.0.file', $file);
        $this->get('/api/backups/'.$file)->assertOk()->assertDownload($file);
    }

    public function test_editors_cannot_reach_backups(): void
    {
        Sanctum::actingAs(User::factory()->create());

        $this->getJson('/api/backups')->assertForbidden();
        $this->postJson('/api/backups')->assertForbidden();
    }
}
