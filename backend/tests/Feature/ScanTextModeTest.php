<?php

namespace Tests\Feature;

use App\Models\Equipment;
use App\Models\ScanDocument;
use App\Models\ScanDocumentRow;
use App\Models\ScanFolder;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/** The camera's text mode: serial numbers to recognise readings, and the photo kept with a row. */
class ScanTextModeTest extends TestCase
{
    use RefreshDatabase;

    private function newDocument(): ScanDocument
    {
        $folder = ScanFolder::create(['name' => 'مجلد']);

        return ScanDocument::create(['scan_folder_id' => $folder->id, 'title' => 'مسح', 'columns' => ScanDocument::defaultColumns()]);
    }

    public function test_the_serial_list_has_every_serial_number_once_without_deleted_equipment(): void
    {
        $main = Equipment::create(['serial_number' => '146636 15 0261']);
        Equipment::create(['serial_number' => '23D0482378156', 'parent_id' => $main->id]);
        Equipment::create(['serial_number' => '23D0482378156', 'parent_id' => $main->id]);
        Equipment::create(['serial_number' => null, 'parent_id' => $main->id]);
        Equipment::create(['serial_number' => 'GONE-1'])->delete();

        $this->getJson('/api/equipment/serial-list')
            ->assertOk()
            ->assertExactJson(['serials' => ['146636 15 0261', '23D0482378156']]);
    }

    public function test_a_text_reading_keeps_its_photo_which_anyone_can_see(): void
    {
        Storage::fake();
        Sanctum::actingAs(User::factory()->create());
        $document = $this->newDocument();

        $response = $this->post("/api/scan-documents/{$document->id}/scan", [
            'code' => '23D0482378156',
            'photo' => UploadedFile::fake()->image('line.jpg', 400, 80),
        ], ['Accept' => 'application/json'])->assertOk()->assertJsonPath('status', 'added');

        $row = ScanDocumentRow::firstOrFail();
        $this->assertNotNull($row->photo_path);
        Storage::assertExists($row->photo_path);
        $url = $response->json('row.photo_url');
        $this->assertStringStartsWith("/api/scan-documents/{$document->id}/rows/{$row->id}/photo?v=", $url);
        $this->assertArrayNotHasKey('photo_path', $response->json('row'));

        // Viewing needs no PIN, like the document itself
        $this->app['auth']->forgetGuards();
        $this->get($url)->assertOk();
        $this->getJson("/api/scan-documents/{$document->id}")->assertJsonPath('rows.0.photo_url', $url);
    }

    public function test_a_duplicate_reading_does_not_keep_a_photo(): void
    {
        Storage::fake();
        Sanctum::actingAs(User::factory()->create());
        $document = $this->newDocument();
        $this->postJson("/api/scan-documents/{$document->id}/scan", ['code' => 'ABC-1'])->assertJsonPath('status', 'added');

        $this->post("/api/scan-documents/{$document->id}/scan", [
            'code' => 'ABC-1',
            'photo' => UploadedFile::fake()->image('line.jpg'),
        ], ['Accept' => 'application/json'])->assertOk()->assertJsonPath('status', 'duplicate');

        $this->assertNull(ScanDocumentRow::firstOrFail()->photo_path);
        $this->assertSame([], Storage::files(ScanDocumentRow::PHOTO_FOLDER));
    }

    public function test_deleting_a_row_document_or_folder_deletes_its_photos(): void
    {
        Storage::fake();
        Sanctum::actingAs(User::factory()->create());
        $document = $this->newDocument();
        foreach (['A-1', 'A-2', 'A-3'] as $code) {
            $this->post("/api/scan-documents/{$document->id}/scan", [
                'code' => $code,
                'photo' => UploadedFile::fake()->image('line.jpg'),
            ], ['Accept' => 'application/json'])->assertOk();
        }
        $this->assertCount(3, Storage::files(ScanDocumentRow::PHOTO_FOLDER));

        $row = ScanDocumentRow::where('code', 'A-1')->firstOrFail();
        $this->deleteJson("/api/scan-documents/{$document->id}/rows/{$row->id}")->assertNoContent();
        $this->assertCount(2, Storage::files(ScanDocumentRow::PHOTO_FOLDER));

        $this->deleteJson("/api/scan-documents/{$document->id}")->assertNoContent();
        $this->assertCount(0, Storage::files(ScanDocumentRow::PHOTO_FOLDER));

        $other = $this->newDocument();
        $this->post("/api/scan-documents/{$other->id}/scan", [
            'code' => 'B-1',
            'photo' => UploadedFile::fake()->image('line.jpg'),
        ], ['Accept' => 'application/json'])->assertOk();
        $this->deleteJson("/api/scan-folders/{$other->scan_folder_id}")->assertNoContent();
        $this->assertCount(0, Storage::files(ScanDocumentRow::PHOTO_FOLDER));
    }

    public function test_a_photo_must_be_an_image(): void
    {
        Storage::fake();
        Sanctum::actingAs(User::factory()->create());
        $document = $this->newDocument();

        $this->post("/api/scan-documents/{$document->id}/scan", [
            'code' => 'ABC',
            'photo' => UploadedFile::fake()->create('notes.pdf', 10, 'application/pdf'),
        ], ['Accept' => 'application/json'])->assertUnprocessable()->assertJsonValidationErrors('photo');
        $this->assertSame(0, ScanDocumentRow::count());
    }
}
