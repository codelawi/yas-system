<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class ScanFolderTest extends TestCase
{
    use RefreshDatabase;

    /** Creates a folder through the API and returns its id. */
    private function newFolder(string $name = 'رحلة'): int
    {
        return $this->postJson('/api/scan-folders', ['name' => $name])->assertCreated()->json('id');
    }

    /** Creates a document in a folder through the API and returns its id. */
    private function newDocument(int $folder, string $scope = 'document', string $title = 'صندوق'): int
    {
        return $this->postJson('/api/scan-documents', ['scan_folder_id' => $folder, 'title' => $title, 'duplicate_scope' => $scope])
            ->assertCreated()->assertJsonPath('duplicate_scope', $scope)->json('id');
    }

    public function test_folders_need_a_pin_to_change_and_a_name(): void
    {
        $this->getJson('/api/scan-folders')->assertOk()->assertExactJson([]);
        $this->postJson('/api/scan-folders', ['name' => 'رحلة'])->assertUnauthorized();

        Sanctum::actingAs(User::factory()->create());
        $this->postJson('/api/scan-folders', ['name' => ' '])->assertUnprocessable()->assertJsonValidationErrors('name');
        $id = $this->newFolder(' رحلة الشمال ');

        $this->putJson("/api/scan-folders/{$id}", ['name' => 'رحلة الجنوب'])->assertOk()->assertJsonPath('name', 'رحلة الجنوب');
        $this->getJson("/api/scan-folders/{$id}")->assertOk()->assertJsonPath('folder.name', 'رحلة الجنوب')->assertJsonCount(0, 'documents');
    }

    public function test_the_list_shows_each_folders_documents_and_rows(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $first = $this->newFolder('الأول');
        $this->travel(1)->minutes();
        $second = $this->newFolder('الثاني');
        $this->travel(1)->minutes();
        // Scanning into the older folder makes it the most recently used
        $document = $this->newDocument($first);
        $this->newDocument($first, 'document', 'آخر');
        $this->postJson("/api/scan-documents/{$document}/scan", ['code' => 'A-1']);
        $this->postJson("/api/scan-documents/{$document}/scan", ['code' => 'A-2']);

        $this->getJson('/api/scan-folders')->assertOk()
            ->assertJsonCount(2)
            ->assertJsonPath('0.id', $first)
            ->assertJsonPath('0.documents_count', 2)
            ->assertJsonPath('0.rows_count', 2)
            ->assertJsonPath('1.id', $second)
            ->assertJsonPath('1.documents_count', 0);
        $this->getJson("/api/scan-folders/{$first}")->assertJsonCount(2, 'documents')
            ->assertJsonFragment(['title' => 'صندوق', 'rows_count' => 2])
            ->assertJsonFragment(['title' => 'آخر', 'rows_count' => 0]);
    }

    public function test_folder_scope_refuses_a_code_already_in_another_document_of_the_folder(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $folder = $this->newFolder();
        $own = $this->newDocument($folder, 'document', 'صندوق 1');
        $shared = $this->newDocument($folder, 'folder', 'صندوق 2');
        $elsewhere = $this->newDocument($this->newFolder('مجلد آخر'), 'folder');

        $this->postJson("/api/scan-documents/{$own}/scan", ['code' => 'X-1'])->assertJsonPath('status', 'added');
        $this->postJson("/api/scan-documents/{$shared}/scan", ['code' => 'X-1'])
            ->assertOk()
            ->assertJsonPath('status', 'duplicate')
            ->assertJsonPath('document.id', $own)
            ->assertJsonPath('document.title', 'صندوق 1')
            ->assertJsonPath('row_number', 1);
        // Another folder is not checked
        $this->postJson("/api/scan-documents/{$elsewhere}/scan", ['code' => 'X-1'])->assertJsonPath('status', 'added');

        // A document checking only itself still accepts a code another document of the folder has
        $this->postJson("/api/scan-documents/{$shared}/scan", ['code' => 'Y-2'])->assertJsonPath('status', 'added');
        $this->postJson("/api/scan-documents/{$own}/scan", ['code' => 'Y-2'])->assertJsonPath('status', 'added');
        $this->assertDatabaseCount('scan_document_rows', 4);
    }

    public function test_the_scope_can_be_switched_on_a_document(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $folder = $this->newFolder();
        $first = $this->newDocument($folder);
        $second = $this->newDocument($folder);
        $this->postJson("/api/scan-documents/{$first}/scan", ['code' => 'X-1']);

        $this->postJson("/api/scan-documents/{$second}/scan", ['code' => 'X-1'])->assertJsonPath('status', 'added');
        $this->putJson("/api/scan-documents/{$second}", ['duplicate_scope' => 'folder'])
            ->assertOk()->assertJsonPath('document.duplicate_scope', 'folder')->assertJsonPath('document.revision', 2);
        $this->postJson("/api/scan-documents/{$second}/scan", ['code' => 'Z-9'])->assertJsonPath('status', 'added');
        $this->postJson("/api/scan-documents/{$first}/scan", ['code' => 'Z-9'])->assertJsonPath('status', 'added');
        $this->postJson("/api/scan-documents/{$second}/scan", ['code' => 'X-1'])->assertJsonPath('status', 'duplicate');

        $this->putJson("/api/scan-documents/{$second}", ['duplicate_scope' => 'everywhere'])->assertUnprocessable()->assertJsonValidationErrors('duplicate_scope');
    }

    public function test_editing_a_code_by_hand_checks_the_same_scope(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $folder = $this->newFolder();
        $other = $this->newDocument($folder);
        $shared = $this->newDocument($folder, 'folder');
        $this->postJson("/api/scan-documents/{$other}/scan", ['code' => 'X-1']);
        $row = $this->postJson("/api/scan-documents/{$shared}/rows")->json('id');

        $this->putJson("/api/scan-documents/{$shared}/rows/{$row}", ['code' => 'X-1'])
            ->assertUnprocessable()->assertJsonPath('errors.code.0', 'scan_duplicate_folder');
        $this->putJson("/api/scan-documents/{$shared}/rows/{$row}", ['code' => 'X-2'])->assertOk()->assertJsonPath('code', 'X-2');
    }

    public function test_deleting_a_folder_deletes_its_documents_and_their_rows(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $folder = $this->newFolder();
        $kept = $this->newDocument($this->newFolder('يبقى'));
        $document = $this->newDocument($folder);
        $this->postJson("/api/scan-documents/{$document}/scan", ['code' => 'A-1']);
        $this->postJson("/api/scan-documents/{$kept}/scan", ['code' => 'A-1']);

        $this->deleteJson("/api/scan-folders/{$folder}")->assertNoContent();
        $this->assertDatabaseMissing('scan_documents', ['id' => $document]);
        $this->assertDatabaseCount('scan_documents', 1);
        $this->assertDatabaseCount('scan_document_rows', 1);
    }

    public function test_revisions_change_so_open_screens_can_refresh(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $folder = $this->newFolder();
        $list = $this->getJson('/api/scan-folders/revision')->assertOk()->json('revision');
        $before = $this->getJson("/api/scan-folders/{$folder}/revision")->assertOk()->json('revision');

        $document = $this->newDocument($folder);
        $afterNewDocument = $this->getJson("/api/scan-folders/{$folder}/revision")->json('revision');
        $this->postJson("/api/scan-documents/{$document}/scan", ['code' => 'A-1']);
        $afterScan = $this->getJson("/api/scan-folders/{$folder}/revision")->json('revision');
        $this->putJson("/api/scan-folders/{$folder}", ['name' => 'اسم جديد']);
        $afterRename = $this->getJson("/api/scan-folders/{$folder}/revision")->json('revision');

        $this->assertCount(4, array_unique([$before, $afterNewDocument, $afterScan, $afterRename]));
        $this->assertNotSame($list, $this->getJson('/api/scan-folders/revision')->json('revision'));
    }
}
