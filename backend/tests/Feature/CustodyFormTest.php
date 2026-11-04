<?php

namespace Tests\Feature;

use App\Models\Custody;
use App\Models\CustodyForm;
use App\Models\Equipment;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;
use ZipArchive;

class CustodyFormTest extends TestCase
{
    use RefreshDatabase;

    private function admin(): User
    {
        $user = User::factory()->create(['role' => 'admin']);
        Sanctum::actingAs($user);

        return $user;
    }

    /** A minimal .docx whose tags are split over several runs, as Word often does. */
    private function docx(): UploadedFile
    {
        $path = tempnam(sys_get_temp_dir(), 'docx');
        $zip = new ZipArchive;
        $zip->open($path, ZipArchive::OVERWRITE);
        $zip->addFromString('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
        $zip->addFromString('word/document.xml', '<w:document><w:body>'
            .'<w:p><w:r><w:t>المستلم: {</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>{المست</w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:t>لم}}</w:t></w:r></w:p>'
            .'<w:p><w:r><w:t>{{الرقم التسلسلي}} / {{مضخة يدوية}} / {{الملحقات}} / {{شيء غريب}}</w:t></w:r></w:p>'
            .'</w:body></w:document>');
        $zip->close();

        return new UploadedFile($path, 'سند عهدة.docx', null, null, true);
    }

    public function test_word_form_is_filled_for_a_custody(): void
    {
        Storage::fake();
        $this->admin();
        $main = Equipment::create(['serial_number' => 'LK-1']);
        $main->syncFields([['key' => 'مضخة يدوية', 'value' => 'P-77']]);
        $acc = Equipment::create(['serial_number' => 'LK-1-A', 'parent_id' => $main->id]);

        $form = $this->postJson('/api/custody-forms', ['file' => $this->docx()])
            ->assertCreated()->assertJsonPath('kind', 'docx')->assertJsonPath('name', 'سند عهدة')->assertJsonPath('is_default', true);

        $this->getJson("/api/custody-forms/{$form['id']}/tags")->assertOk()
            ->assertJsonFragment(['tag' => 'المستلم', 'known' => 'builtin'])
            ->assertJsonFragment(['tag' => 'مضخة يدوية', 'known' => 'field'])
            ->assertJsonFragment(['tag' => 'شيء غريب', 'known' => 'unknown']);

        $custodyId = $this->postJson("/api/equipment/{$main->id}/custody", ['holder' => 'أحمد <علي>', 'holder_id_number' => '123', 'include_accessories' => true])
            ->assertOk()->json('custody_id');
        $this->assertSame($main->id, Custody::find($custodyId)->equipment_id);

        $this->getJson("/api/custodies/{$custodyId}/form-data")->assertOk()
            ->assertJsonPath('values.holder_id_number', '123')
            ->assertJsonPath('values.accessories', 'LK-1-A')
            ->assertJsonPath('fields.مضخة يدوية', 'P-77');

        $response = $this->get("/api/custody-forms/{$form['id']}/fill/{$custodyId}")->assertOk();
        $zip = new ZipArchive;
        $zip->open($response->baseResponse->getFile()->getPathname());
        $xml = $zip->getFromName('word/document.xml');
        $zip->close();

        $this->assertStringContainsString('المستلم: أحمد &lt;علي&gt;</w:t>', $xml);
        $this->assertStringContainsString('LK-1 / P-77 / LK-1-A / </w:t>', $xml);
        $this->assertStringNotContainsString('{{', $xml);
        $this->assertNotFalse(simplexml_load_string(str_replace('w:', '', $xml)), 'filled document is still valid XML');
    }

    public function test_layout_is_saved_whole_and_default_moves(): void
    {
        Storage::fake();
        $this->admin();
        $first = $this->postJson('/api/custody-forms', ['file' => UploadedFile::fake()->create('a.pdf', 10, 'application/pdf')])->assertCreated()->json();
        $second = $this->postJson('/api/custody-forms', ['file' => UploadedFile::fake()->image('b.png')])->assertCreated()
            ->assertJsonPath('kind', 'image')->assertJsonPath('is_default', false)->json();

        $layout = ['pages' => [['w' => 210, 'h' => 297]], 'elements' => [['id' => 'e1', 'type' => 'field', 'page' => 0, 'source' => 'holder', 'prefix' => 'الاسم: ', 'x' => 20, 'y' => 40, 'w' => 80, 'h' => 8, 'size' => 4]]];
        $this->putJson("/api/custody-forms/{$second['id']}", ['layout' => $layout, 'is_default' => true])->assertOk()
            ->assertJsonPath('layout.elements.0.source', 'holder')->assertJsonPath('layout.elements.0.prefix', 'الاسم: ')->assertJsonPath('layout.elements.0.x', 20);
        $this->assertFalse(CustodyForm::find($first['id'])->is_default);

        $this->deleteJson("/api/custody-forms/{$second['id']}")->assertNoContent();
        $this->assertTrue(CustodyForm::find($first['id'])->is_default);
    }

    public function test_old_office_files_and_non_admins_are_refused(): void
    {
        Storage::fake();
        $this->admin();
        $this->postJson('/api/custody-forms', ['file' => UploadedFile::fake()->create('old.doc', 10)])
            ->assertUnprocessable()->assertJsonPath('errors.file.0', 'form_old_format');

        Sanctum::actingAs(User::factory()->create(['role' => 'user']));
        $this->postJson('/api/custody-forms', ['file' => UploadedFile::fake()->create('a.pdf', 10)])->assertForbidden();
        $this->getJson('/api/custody-forms')->assertOk();
    }
}
