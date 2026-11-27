<?php

namespace Tests\Feature;

use App\Models\Equipment;
use App\Models\EquipmentGroup;
use App\Models\User;
use App\Models\VoucherPrint;
use App\Models\VoucherTemplate;
use App\Support\PrintStation;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\File;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/** Printing issue vouchers: templates, the voucher's own fields, and the print station on the laptop. */
class VoucherPrintTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Sanctum::actingAs(User::factory()->create());
        File::delete(PrintStation::openRequestFile());
    }

    /** A draft with two saws, ready to issue. */
    private function draft(): int
    {
        $saw = EquipmentGroup::create(['name' => 'منشار', 'voucher_code' => 'ان ٤١٢٣٤١دم']);
        foreach (['SAW-1', 'SAW-2'] as $serial) {
            Equipment::create(['serial_number' => $serial, 'group_id' => $saw->id]);
        }
        $id = $this->postJson('/api/vouchers')->assertOk()->json('voucher.id');
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'SAW-1']);
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'SAW-2']);

        return $id;
    }

    /** @return array<string, mixed> */
    private function templateData(VoucherTemplate $template, array $changes = []): array
    {
        return array_replace_recursive($template->only(['name', 'header', 'footer', 'item_table', 'fields', 'style']), $changes);
    }

    public function test_templates_start_from_the_paper_voucher_and_one_is_the_default(): void
    {
        $list = $this->getJson('/api/voucher-templates')->assertOk()->assertJsonCount(1)->assertJsonPath('0.is_default', true);
        $paper = VoucherTemplate::findOrFail($list->json('0.id'));
        $this->assertStringContainsString('data-field="recipient"', $paper->header);
        $this->assertSame(['code', 'name', 'quantity', 'quantity_words'], array_column($paper->item_table['columns'], 'key'));
        $this->assertSame('بلا', $paper->item_table['no_code']);

        $copy = $this->postJson('/api/voucher-templates', ['from' => $paper->id])->assertOk()->assertJsonPath('is_default', false);
        $this->assertSame($paper->header, $copy->json('header'));

        // Edited: titles, widths, fields; at least one column must stay
        $this->putJson('/api/voucher-templates/'.$copy->json('id'), $this->templateData($paper, [
            'name' => 'سند مختصر',
            'item_table' => ['columns' => [3 => ['show' => false]]],
            'fields' => [['key' => 'officer', 'label' => 'الضابط المسؤول']],
        ]))->assertOk()->assertJsonPath('name', 'سند مختصر')->assertJsonPath('item_table.columns.3.show', false)->assertJsonPath('fields.0.label', 'الضابط المسؤول');
        $none = $this->templateData($paper, ['item_table' => ['columns' => array_map(fn ($c) => ['show' => false] + $c, $paper->item_table['columns'])]]);
        $this->putJson('/api/voucher-templates/'.$copy->json('id'), $none)->assertUnprocessable()->assertJsonPath('errors.item_table.0', 'voucher_template_no_columns');

        // The default moves; deleting the default hands it on; the last one stays
        $this->postJson('/api/voucher-templates/'.$copy->json('id').'/default')->assertOk();
        $this->assertFalse($paper->fresh()->is_default);
        $this->deleteJson('/api/voucher-templates/'.$copy->json('id'))->assertNoContent();
        $this->assertTrue($paper->fresh()->is_default);
        $this->deleteJson("/api/voucher-templates/{$paper->id}")->assertUnprocessable()->assertJsonPath('errors.template.0', 'voucher_template_last');
    }

    public function test_issuing_keeps_the_template_as_it_was_and_sends_the_copies_to_print(): void
    {
        $id = $this->draft();
        $template = VoucherTemplate::current();
        $this->getJson("/api/vouchers/{$id}")->assertJsonPath('layout.template_id', $template->id)->assertJsonPath('copies', 1);
        $this->putJson("/api/vouchers/{$id}", ['fields' => ['storekeeper' => ' أحمد  علي ', 'receiver' => 'سالم']])->assertJsonPath('voucher.fields.storekeeper', 'أحمد علي');

        $this->postJson("/api/vouchers/{$id}/issue", ['recipient' => 'فورد اسود', 'copies' => 2])
            ->assertOk()
            ->assertJsonPath('status', 'issued')
            ->assertJsonPath('print.job.copies', 2)
            ->assertJsonPath('print.job.status', 'pending')
            ->assertJsonPath('print.station.online', false)
            ->assertJsonPath('voucher.last_print.copies', 2);

        // The template changes later: the issued voucher prints as before
        $template->update(['header' => '<p>رأس جديد</p>']);
        $this->getJson("/api/vouchers/{$id}")->assertJsonPath('layout.header', VoucherTemplate::builtIn()['header']);

        // The next voucher starts with the same fields and copies
        $this->postJson('/api/vouchers')->assertJsonPath('voucher.fields.storekeeper', 'أحمد علي')->assertJsonPath('voucher.fields.receiver', 'سالم')->assertJsonPath('copies', 2);

        // Reprint, as many copies as asked; an issue without copies prints nothing
        $this->postJson("/api/vouchers/{$id}/print", ['copies' => 1])->assertOk()->assertJsonPath('print.job.copies', 1);
        $this->assertSame(2, VoucherPrint::where('voucher_id', $id)->count());
        $this->putJson("/api/vouchers/{$id}", ['recipient' => 'غيره'])->assertUnprocessable();
        $other = $this->postJson('/api/vouchers')->json('voucher.id');
        $this->postJson("/api/vouchers/{$other}/items", ['code' => 'SAW-1', 'move' => true]);
        $this->postJson("/api/vouchers/{$other}/issue", ['recipient' => 'سالم', 'copies' => 0, 'move' => true])->assertJsonPath('print.job', null);
        $this->postJson("/api/vouchers/{$other}/print", ['copies' => 0])->assertUnprocessable();
    }

    public function test_the_print_station_needs_its_key_and_says_what_was_printed(): void
    {
        $id = $this->draft();
        $this->postJson("/api/vouchers/{$id}/issue", ['recipient' => 'فورد اسود', 'copies' => 2]);
        $key = PrintStation::key();

        $this->getJson('/api/print-station/next')->assertForbidden();
        $this->getJson('/api/print-station/next?key=wrong')->assertForbidden();
        $this->getJson('/api/print-station')->assertJsonPath('online', false)->assertJsonPath('pending', 1);

        $job = $this->getJson('/api/print-station/next', ['X-Station-Key' => $key])
            ->assertOk()
            ->assertJsonPath('job.copies', 2)
            ->assertJsonPath('job.voucher.number', 1)
            ->assertJsonPath('job.voucher.recipient', 'فورد اسود')
            ->assertJsonPath('job.rows.0.code', 'ان ٤١٢٣٤١دم')
            ->assertJsonPath('job.rows.0.quantity', 2)
            ->assertJsonPath('job.layout.item_table.no_code', 'بلا')
            ->json('job.id');
        // Asking for work is how the station says it is open; a second window waits its turn
        $this->getJson('/api/print-station')->assertJsonPath('online', true);
        $this->getJson("/api/print-station/next?key={$key}&window=second")->assertJsonPath('job', null)->assertJsonPath('duplicate', true);
        $this->travel(PrintStation::ONLINE_FOR + 1)->seconds();
        $this->getJson("/api/print-station/next?key={$key}&window=second")->assertJsonPath('job.id', $job);
        $this->getJson("/api/print-station/next?key={$key}")->assertJsonPath('duplicate', true);
        $this->travelBack();
        $revision = $this->getJson("/api/vouchers/{$id}/revision")->json('revision');

        $this->postJson("/api/print-station/jobs/{$job}/printed")->assertForbidden();
        $this->postJson("/api/print-station/jobs/{$job}/printed?key={$key}")->assertOk()->assertJsonPath('print.status', 'printed');
        $this->getJson("/api/vouchers/{$id}")->assertJsonPath('voucher.last_print.status', 'printed')->assertJsonPath('voucher.revision', $revision + 1);
        $this->getJson("/api/print-station/next?key={$key}")->assertJsonPath('job', null);

        // A reprint cancelled at the station; a finished print stays as it was
        $again = $this->postJson("/api/vouchers/{$id}/print", ['copies' => 1])->json('print.job.id');
        $this->postJson("/api/print-station/jobs/{$again}/cancel?key={$key}")->assertJsonPath('print.status', 'cancelled');
        $this->postJson("/api/print-station/jobs/{$job}/cancel?key={$key}")->assertJsonPath('print.status', 'printed');
    }

    public function test_a_phone_can_have_the_station_opened_on_the_laptop(): void
    {
        $this->postJson('/api/print-station/open')->assertOk()->assertJsonPath('requested', true)->assertJsonPath('online', false);
        $this->assertFileExists(PrintStation::openRequestFile());
        File::delete(PrintStation::openRequestFile());

        // Already open: nothing to ask
        $this->getJson('/api/print-station/next?key='.PrintStation::key())->assertOk();
        $this->postJson('/api/print-station/open')->assertJsonPath('requested', false)->assertJsonPath('online', true);
        $this->assertFileDoesNotExist(PrintStation::openRequestFile());

        // Open means: asked for work in the last few seconds
        $this->travel(PrintStation::ONLINE_FOR + 1)->seconds();
        $this->getJson('/api/print-station')->assertJsonPath('online', false);
        Cache::flush();
    }

    public function test_printing_needs_a_pin(): void
    {
        $this->app['auth']->forgetGuards();
        $this->getJson('/api/voucher-templates')->assertUnauthorized();
        $this->postJson('/api/print-station/open')->assertUnauthorized();
        $this->getJson('/api/print-station')->assertUnauthorized();
    }
}
