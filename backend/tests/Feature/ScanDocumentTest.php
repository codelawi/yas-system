<?php

namespace Tests\Feature;

use App\Models\ScanDocument;
use App\Models\ScanFolder;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class ScanDocumentTest extends TestCase
{
    use RefreshDatabase;

    private ScanFolder $folder;

    protected function setUp(): void
    {
        parent::setUp();
        $this->folder = ScanFolder::create(['name' => 'مجلد']);
    }

    /** Creates a document in the test folder through the API and returns its id. */
    private function newDocument(string $title = 'مسح'): int
    {
        return $this->postJson('/api/scan-documents', ['scan_folder_id' => $this->folder->id, 'title' => $title])->assertCreated()->json('id');
    }

    public function test_viewing_is_open_but_changes_need_a_pin(): void
    {
        $document = ScanDocument::create(['scan_folder_id' => $this->folder->id, 'title' => 'مستند', 'columns' => ScanDocument::defaultColumns()]);

        $this->getJson("/api/scan-folders/{$this->folder->id}")->assertOk()->assertJsonPath('documents.0.title', 'مستند');
        $this->getJson("/api/scan-documents/{$document->id}")->assertOk()
            ->assertJsonPath('document.title', 'مستند')->assertJsonPath('document.folder.name', 'مجلد');
        $this->postJson('/api/scan-documents', ['scan_folder_id' => $this->folder->id, 'title' => 'x'])->assertUnauthorized();
        $this->postJson("/api/scan-documents/{$document->id}/scan", ['code' => 'ABC'])->assertUnauthorized();
    }

    public function test_new_document_starts_with_the_default_columns_inside_its_folder(): void
    {
        Sanctum::actingAs(User::factory()->create());

        $this->postJson('/api/scan-documents', ['scan_folder_id' => $this->folder->id, 'title' => 'فحص المعدات'])
            ->assertCreated()
            ->assertJsonPath('columns.1.key', 'code')
            ->assertJsonPath('duplicate_scope', 'document')
            ->assertJsonPath('rows_count', 0);
        $this->postJson('/api/scan-documents', ['title' => 'بلا مجلد'])->assertUnprocessable()->assertJsonValidationErrors('scan_folder_id');
        $this->postJson('/api/scan-documents', ['scan_folder_id' => 999, 'title' => 'x'])->assertUnprocessable()->assertJsonValidationErrors('scan_folder_id');
    }

    public function test_scans_add_rows_and_a_repeated_code_is_not_added_again(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $id = $this->newDocument();

        $this->postJson("/api/scan-documents/{$id}/scan", ['code' => ' 24A0539655744 '])
            ->assertOk()->assertJsonPath('status', 'added')->assertJsonPath('row.code', '24A0539655744')->assertJsonPath('row_number', 1);
        $this->postJson("/api/scan-documents/{$id}/scan", ['code' => 'http://repo.local/eq/S-1'])
            ->assertJsonPath('status', 'added')->assertJsonPath('row_number', 2);
        $this->postJson("/api/scan-documents/{$id}/scan", ['code' => '24A0539655744'])
            ->assertJsonPath('status', 'duplicate')->assertJsonPath('row_number', 1)->assertJsonPath('document.id', $id);

        $this->getJson("/api/scan-documents/{$id}")->assertJsonCount(2, 'rows')->assertJsonPath('rows.1.code', 'http://repo.local/eq/S-1');
    }

    public function test_rows_can_be_typed_edited_and_deleted(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $id = $this->newDocument();
        $first = $this->postJson("/api/scan-documents/{$id}/scan", ['code' => 'A-1'])->json('row.id');
        $typed = $this->postJson("/api/scan-documents/{$id}/rows")->assertCreated()->json('id');

        $this->putJson("/api/scan-documents/{$id}/rows/{$typed}", ['code' => 'A-1'])
            ->assertUnprocessable()->assertJsonPath('errors.code.0', 'scan_duplicate');
        $this->putJson("/api/scan-documents/{$id}/rows/{$typed}", ['code' => 'B-2', 'cells' => ['notes' => 'سليم', 'unknown' => 'x']])
            ->assertOk()->assertJsonPath('code', 'B-2')->assertJsonPath('cells.notes', 'سليم')->assertJsonMissingPath('cells.unknown');

        $this->deleteJson("/api/scan-documents/{$id}/rows/{$first}")->assertNoContent();
        $this->postJson("/api/scan-documents/{$id}/scan", ['code' => 'C-3'])->assertJsonPath('row_number', 2);
    }

    public function test_columns_can_be_added_renamed_and_removed_but_the_code_column_stays(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $id = $this->newDocument();
        $columns = [
            ['key' => 'no', 'label' => '#'],
            ['key' => 'code', 'label' => 'الرقم'],
            ['key' => 'c_place', 'label' => 'المكان'],
        ];

        $this->putJson("/api/scan-documents/{$id}", ['title' => 'مسح المستودع', 'columns' => $columns])
            ->assertOk()->assertJsonPath('document.title', 'مسح المستودع')->assertJsonPath('document.columns.2.label', 'المكان');
        $row = $this->postJson("/api/scan-documents/{$id}/rows")->json('id');
        $this->putJson("/api/scan-documents/{$id}/rows/{$row}", ['cells' => ['c_place' => 'A', 'notes' => 'gone']])
            ->assertJsonPath('cells.c_place', 'A')->assertJsonMissingPath('cells.notes');

        $this->putJson("/api/scan-documents/{$id}", ['columns' => [['key' => 'no', 'label' => 'ت']]])
            ->assertUnprocessable()->assertJsonPath('errors.columns.0', 'scan_doc_bad_columns');
        $this->putJson("/api/scan-documents/{$id}", ['columns' => [['key' => 'code', 'label' => 'x'], ['key' => 'evil', 'label' => 'y']]])
            ->assertUnprocessable();
    }

    public function test_deleting_a_document_deletes_its_rows(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $id = $this->newDocument();
        $this->postJson("/api/scan-documents/{$id}/scan", ['code' => 'A-1']);

        $this->deleteJson("/api/scan-documents/{$id}")->assertNoContent();
        $this->assertDatabaseCount('scan_document_rows', 0);
    }

    public function test_revision_changes_with_every_change_so_open_screens_can_refresh(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $id = $this->newDocument();
        $list = $this->getJson('/api/scan-folders/revision')->assertOk()->json('revision');
        $this->getJson("/api/scan-documents/{$id}/revision")->assertExactJson(['revision' => 0]);

        $this->postJson("/api/scan-documents/{$id}/scan", ['code' => 'A-1']);
        $this->postJson("/api/scan-documents/{$id}/scan", ['code' => 'A-1']); // duplicate: nothing changes
        $row = $this->postJson("/api/scan-documents/{$id}/rows")->json('id');
        $this->putJson("/api/scan-documents/{$id}/rows/{$row}", ['cells' => ['notes' => 'x']]);
        $this->putJson("/api/scan-documents/{$id}", ['title' => 'جديد']);

        $this->getJson("/api/scan-documents/{$id}/revision")->assertExactJson(['revision' => 4]);
        $this->getJson("/api/scan-documents/{$id}")->assertJsonPath('document.revision', 4);
        $this->assertNotSame($list, $this->getJson('/api/scan-folders/revision')->json('revision'));
    }
}
