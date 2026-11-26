<?php

namespace Tests\Feature;

use App\Models\ActivityLog;
use App\Models\Custody;
use App\Models\Equipment;
use App\Models\EquipmentGroup;
use App\Models\User;
use App\Models\Voucher;
use App\Support\ArabicNumber;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/** Issue vouchers (سند صرف عهدة): scan, issue as custody, take back by scanning. */
class VoucherTest extends TestCase
{
    use RefreshDatabase;

    private function signIn(): User
    {
        $user = User::factory()->create();
        Sanctum::actingAs($user);

        return $user;
    }

    private function draft(): int
    {
        return $this->postJson('/api/vouchers')->assertOk()->json('voucher.id');
    }

    /** @return array{saw: EquipmentGroup, saws: array<int, Equipment>, light: Equipment, charger: Equipment} */
    private function store(): array
    {
        $saw = EquipmentGroup::create(['name' => 'منشار', 'voucher_code' => 'ان ٤١٢٣٤١دم', 'voucher_name' => 'منشار قص خشب يعمل على البطارية']);
        $lights = EquipmentGroup::create(['name' => 'كشاف']);
        $saws = [
            Equipment::create(['serial_number' => 'SAW-1', 'group_id' => $saw->id]),
            Equipment::create(['serial_number' => 'SAW-2', 'group_id' => $saw->id]),
            Equipment::create(['serial_number' => 'SAW-3', 'group_id' => $saw->id]),
        ];
        $light = Equipment::create(['serial_number' => 'L-1', 'group_id' => $lights->id]);
        $charger = Equipment::create(['serial_number' => 'L-1-C', 'name' => 'شاحن للكشاف', 'parent_id' => $light->id]);

        return compact('saw', 'saws', 'light', 'charger');
    }

    public function test_vouchers_need_a_pin(): void
    {
        $this->getJson('/api/vouchers')->assertUnauthorized();
        $this->postJson('/api/vouchers')->assertUnauthorized();
        $this->postJson('/api/vouchers/return', ['code' => 'X'])->assertUnauthorized();
    }

    public function test_scanned_units_make_one_line_per_group_in_scan_order(): void
    {
        $this->signIn();
        ['saws' => $saws, 'light' => $light, 'charger' => $charger] = $this->store();
        $id = $this->draft();

        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'http://192.168.1.5/eq/SAW-1'])->assertOk()->assertJsonPath('status', 'added');
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'L-1'])->assertJsonPath('status', 'added');
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'SAW-2'])->assertJsonPath('status', 'added');
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'SAW-2'])->assertJsonPath('status', 'already');
        // An accessory picked under its main equipment
        $response = $this->postJson("/api/vouchers/{$id}/items", ['equipment_ids' => [$charger->id]])->assertJsonPath('status', 'added');

        $this->assertSame([
            ['ان ٤١٢٣٤١دم', 'منشار قص خشب يعمل على البطارية', false, 2, 'اثنان فقط'],
            [null, 'كشاف', false, 1, 'واحد فقط'],
            [null, 'شاحن للكشاف', true, 1, 'واحد فقط'],
        ], collect($response->json('rows'))->map(fn ($r) => [$r['code'], $r['name'], $r['accessory'], $r['quantity'], $r['quantity_words']])->all());
        $this->assertSame(['SAW-1', 'SAW-2'], $response->json('rows.0.serials'));
        $this->assertSame(['L-1-C'], array_column($response->json('items.1.accessories'), 'serial_number'));
        $this->assertSame($light->id, $response->json('items.1.equipment.id'));
        $this->assertNull($response->json('voucher.number'));

        // Taken off again
        $item = $response->json('items.0.id');
        $this->deleteJson("/api/vouchers/{$id}/items/{$item}")->assertOk()->assertJsonPath('rows.0.quantity', 1);
        $this->assertSame(0, Custody::count());
        $this->assertNotNull($saws[0]->fresh());
    }

    public function test_unknown_codes_and_makers_codes(): void
    {
        $this->signIn();
        $id = $this->draft();
        Equipment::create(['serial_number' => 'M-1'])->syncFields([['key' => 'رقم الصانع', 'value' => 'FUBAG-77']]);
        Equipment::create(['serial_number' => 'M-2'])->syncFields([['key' => 'رقم الصانع', 'value' => 'DUP']]);
        Equipment::create(['serial_number' => 'M-3'])->syncFields([['key' => 'رقم الصانع', 'value' => 'DUP']]);

        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'FUBAG-77'])->assertJsonPath('status', 'added')->assertJsonPath('equipment.0.serial_number', 'M-1');
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'DUP'])->assertUnprocessable()->assertJsonPath('errors.code.0', 'voucher_code_many');
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'NOPE'])->assertUnprocessable()->assertJsonPath('errors.code.0', 'voucher_unknown_code');
    }

    public function test_issuing_numbers_the_voucher_and_hands_everything_over(): void
    {
        $user = $this->signIn();
        ['saws' => $saws, 'charger' => $charger] = $this->store();
        $id = $this->draft();

        $this->postJson("/api/vouchers/{$id}/issue", ['recipient' => 'فورد اسود (24442)'])->assertUnprocessable()->assertJsonPath('errors.voucher.0', 'voucher_empty');
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'SAW-1']);
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'L-1-C']);
        $this->postJson("/api/vouchers/{$id}/issue")->assertUnprocessable()->assertJsonPath('errors.recipient.0', 'voucher_no_recipient');

        $this->postJson("/api/vouchers/{$id}/issue", ['recipient' => ' فورد  اسود (24442) '])
            ->assertOk()
            ->assertJsonPath('status', 'issued')
            ->assertJsonPath('voucher.number', 1)
            ->assertJsonPath('voucher.status', 'issued')
            ->assertJsonPath('voucher.recipient', 'فورد اسود (24442)')
            ->assertJsonPath('voucher.issuer.id', $user->id);

        $this->assertSame(2, Custody::open()->where('voucher_id', $id)->where('holder', 'فورد اسود (24442)')->count());
        $this->assertSame(2, ActivityLog::where('action', 'custody_out')->where('changes->summary', 'فورد اسود (24442) · سند 1')->count());
        $this->assertTrue(Custody::open()->where('equipment_id', $charger->id)->exists());
        $this->postJson("/api/vouchers/{$id}/issue", ['recipient' => 'x'])->assertUnprocessable()->assertJsonPath('errors.voucher.0', 'voucher_not_draft');
        $this->deleteJson("/api/vouchers/{$id}")->assertUnprocessable()->assertJsonPath('errors.voucher.0', 'voucher_still_out_delete');

        // The next one gets the next number; added after issue, it is handed over at once
        $next = $this->draft();
        $this->postJson("/api/vouchers/{$next}/items", ['code' => 'SAW-2']);
        $this->postJson("/api/vouchers/{$next}/issue", ['recipient' => 'سالم'])->assertJsonPath('voucher.number', 2);
        $this->postJson("/api/vouchers/{$next}/items", ['code' => 'SAW-3'])->assertJsonPath('status', 'added');
        $this->assertSame('سالم', Custody::open()->where('equipment_id', $saws[2]->id)->value('holder'));

        // Removing a unit from an issued voucher ends its custody
        $item = $this->getJson("/api/vouchers/{$next}")->json('items.1.id');
        $this->deleteJson("/api/vouchers/{$next}/items/{$item}")->assertOk()->assertJsonCount(1, 'items');
        $this->assertFalse(Custody::open()->where('equipment_id', $saws[2]->id)->exists());
        $this->assertStringContainsString('2', Custody::where('equipment_id', $saws[2]->id)->value('return_notes'));

        // The recipient can be corrected: open custody follows
        $this->putJson("/api/vouchers/{$id}", ['recipient' => 'فورد ابيض'])->assertOk()->assertJsonPath('voucher.recipient', 'فورد ابيض');
        $this->assertSame(2, Custody::open()->where('holder', 'فورد ابيض')->count());
        $this->putJson("/api/vouchers/{$id}", ['recipient' => ''])->assertUnprocessable()->assertJsonPath('errors.recipient.0', 'voucher_no_recipient');

        $this->getJson('/api/vouchers')->assertOk()->assertJsonPath('counts.issued', 2)->assertJsonPath('next_number', 3);
        $this->getJson('/api/vouchers/recipients')->assertOk()->assertJson(['سالم', 'فورد ابيض']);
    }

    public function test_equipment_someone_holds_is_only_moved_when_asked(): void
    {
        $this->signIn();
        ['saws' => $saws] = $this->store();
        $first = $this->draft();
        $this->postJson("/api/vouchers/{$first}/items", ['code' => 'SAW-1']);
        $this->postJson("/api/vouchers/{$first}/issue", ['recipient' => 'أحمد']);
        // Handed over from the equipment page, without a voucher
        $this->postJson("/api/equipment/{$saws[1]->id}/custody", ['holder' => 'سالم'])->assertOk();

        $id = $this->draft();
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'SAW-1'])
            ->assertOk()
            ->assertJsonPath('status', 'held')
            ->assertJsonPath('held.0.holder', 'أحمد')
            ->assertJsonPath('held.0.voucher_number', 1)
            ->assertJsonCount(0, 'items');
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'SAW-1', 'move' => true])->assertJsonPath('status', 'added')->assertJsonPath('items.0.held_by.holder', 'أحمد');
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'SAW-2', 'move' => true])->assertJsonPath('items.1.held_by.voucher_number', null);

        // Issuing asks again, then moves both
        $this->postJson("/api/vouchers/{$id}/issue", ['recipient' => 'خالد'])->assertJsonPath('status', 'held')->assertJsonCount(2, 'held');
        $this->postJson("/api/vouchers/{$id}/issue", ['recipient' => 'خالد', 'move' => true])->assertJsonPath('status', 'issued');

        $this->assertSame(['خالد'], Custody::open()->whereIn('equipment_id', [$saws[0]->id, $saws[1]->id])->distinct()->pluck('holder')->all());
        $this->assertSame('نُقلت إلى سند الصرف رقم 2', Custody::where('holder', 'أحمد')->value('return_notes'));
        // The first voucher has nothing left out: it is returned, and says where its unit went
        $this->getJson("/api/vouchers/{$first}")->assertJsonPath('voucher.status', 'returned')->assertJsonPath('items.0.moved_to', 2);
        $this->getJson("/api/vouchers/{$id}")->assertJsonPath('items.0.moved_to', null);
    }

    public function test_return_by_scanning_inside_a_voucher(): void
    {
        $this->signIn();
        $this->store();
        $id = $this->draft();
        $this->postJson("/api/vouchers/{$id}/return", ['code' => 'SAW-1'])->assertUnprocessable()->assertJsonPath('errors.code.0', 'voucher_not_issued');
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'SAW-1']);
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'SAW-2']);
        $this->postJson("/api/vouchers/{$id}/issue", ['recipient' => 'أحمد']);

        $this->postJson("/api/vouchers/{$id}/return", ['code' => 'SAW-3'])->assertJsonPath('status', 'not_in_voucher')->assertJsonPath('holder', null);
        $this->postJson("/api/vouchers/{$id}/return", ['code' => 'SAW-1'])
            ->assertJsonPath('status', 'returned')
            ->assertJsonPath('voucher.status', 'issued')
            ->assertJsonPath('rows.0.returned', 1);
        $this->postJson("/api/vouchers/{$id}/return", ['code' => 'SAW-1'])->assertJsonPath('status', 'already');
        $this->postJson("/api/vouchers/{$id}/return", ['code' => 'SAW-2'])->assertJsonPath('status', 'returned')->assertJsonPath('voucher.status', 'returned')->assertJsonPath('items.1.moved_to', null);

        $this->assertSame(0, Custody::open()->count());
        $this->assertNotNull(Voucher::find($id)->returned_at);
    }

    public function test_the_whole_voucher_comes_back_with_one_press_and_the_pin(): void
    {
        $user = User::factory()->create(['pin' => '246810']);
        Sanctum::actingAs($user);
        ['saws' => $saws] = $this->store();
        $id = $this->draft();
        $this->postJson("/api/vouchers/{$id}/return-all", ['pin' => '246810'])->assertUnprocessable()->assertJsonPath('errors.voucher.0', 'voucher_not_issued');
        foreach (['SAW-1', 'SAW-2', 'L-1-C'] as $code) {
            $this->postJson("/api/vouchers/{$id}/items", ['code' => $code]);
        }
        $this->postJson("/api/vouchers/{$id}/issue", ['recipient' => 'أحمد']);
        $this->postJson("/api/vouchers/{$id}/return", ['code' => 'SAW-1'])->assertJsonPath('status', 'returned');

        $this->postJson("/api/vouchers/{$id}/return-all")->assertUnprocessable()->assertJsonPath('errors.pin.0', 'pin_required');
        $this->postJson("/api/vouchers/{$id}/return-all", ['pin' => '111111'])->assertUnprocessable()->assertJsonPath('errors.pin.0', 'wrong_pin');
        $this->assertSame(2, Custody::open()->count());

        $this->postJson("/api/vouchers/{$id}/return-all", ['pin' => '246810'])
            ->assertOk()
            ->assertJsonPath('returned', 2)
            ->assertJsonPath('voucher.status', 'returned');
        $this->assertSame(0, Custody::open()->count());
        $this->assertSame($user->id, Custody::where('equipment_id', $saws[1]->id)->value('received_by'));
        $this->assertSame(3, ActivityLog::where('action', 'custody_in')->count());
        $this->postJson("/api/vouchers/{$id}/return-all", ['pin' => '246810'])->assertUnprocessable()->assertJsonPath('errors.voucher.0', 'voucher_nothing_out');
    }

    public function test_a_returned_voucher_is_deleted_with_the_pin_and_one_still_out_is_not(): void
    {
        Sanctum::actingAs(User::factory()->create(['pin' => '246810']));
        $this->store();
        $id = $this->draft();
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'SAW-1']);
        $this->postJson("/api/vouchers/{$id}/issue", ['recipient' => 'أحمد']);

        $this->deleteJson("/api/vouchers/{$id}", ['pin' => '246810'])->assertUnprocessable()->assertJsonPath('errors.voucher.0', 'voucher_still_out_delete');
        $this->postJson("/api/vouchers/{$id}/return", ['code' => 'SAW-1']);
        $this->deleteJson("/api/vouchers/{$id}")->assertUnprocessable()->assertJsonPath('errors.pin.0', 'pin_required');
        $this->deleteJson("/api/vouchers/{$id}", ['pin' => '246810'])->assertNoContent();

        $this->assertSame(0, Voucher::count());
        // The custody history of the equipment stays
        $this->assertSame(1, Custody::whereNotNull('returned_at')->whereNull('voucher_id')->count());
    }

    public function test_general_return_finds_the_voucher(): void
    {
        $this->signIn();
        ['saws' => $saws] = $this->store();
        $id = $this->draft();
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'SAW-1']);
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'SAW-2']);
        $this->postJson("/api/vouchers/{$id}/issue", ['recipient' => 'أحمد']);
        $this->postJson("/api/equipment/{$saws[2]->id}/custody", ['holder' => 'سالم']);

        $this->postJson('/api/vouchers/return', ['code' => 'SAW-1'])
            ->assertOk()
            ->assertJsonPath('status', 'returned')
            ->assertJsonPath('holder', 'أحمد')
            ->assertJsonPath('voucher.number', 1)
            ->assertJsonPath('voucher.items_count', 2)
            ->assertJsonPath('voucher.held_count', 1);
        $this->postJson('/api/vouchers/return', ['code' => 'SAW-1'])->assertJsonPath('status', 'not_held');
        $this->postJson('/api/vouchers/return', ['code' => 'SAW-3'])->assertJsonPath('status', 'returned')->assertJsonPath('voucher', null);

        // Taken back from the equipment page: the voucher follows
        $this->postJson("/api/equipment/{$saws[1]->id}/custody/return")->assertOk();
        $this->assertSame('returned', Voucher::find($id)->status);
    }

    public function test_numbering_starts_where_asked_and_never_goes_back(): void
    {
        $this->signIn();
        $this->store();
        $this->putJson('/api/vouchers/next-number', ['number' => 150])->assertOk()->assertJsonPath('next_number', 150);
        $id = $this->draft();
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'SAW-1']);
        $this->postJson("/api/vouchers/{$id}/issue", ['recipient' => 'أحمد'])->assertJsonPath('voucher.number', 150);

        $this->putJson('/api/vouchers/next-number', ['number' => 150])->assertUnprocessable()->assertJsonPath('errors.number.0', 'voucher_number_used');
        $this->getJson('/api/vouchers')->assertJsonPath('next_number', 151);
    }

    public function test_a_draft_can_be_deleted_and_the_list_can_be_searched(): void
    {
        $this->signIn();
        $this->store();
        $draft = $this->draft();
        $id = $this->draft();
        $this->postJson("/api/vouchers/{$id}/items", ['code' => 'SAW-1']);
        $this->postJson("/api/vouchers/{$id}/issue", ['recipient' => 'فورد اسود']);

        $this->getJson('/api/vouchers')->assertJsonCount(2, 'vouchers')->assertJsonPath('vouchers.0.id', $draft)->assertJsonPath('vouchers.1.items_count', 1)->assertJsonPath('vouchers.1.held_count', 1);
        $this->getJson('/api/vouchers?q=فورد')->assertJsonCount(1, 'vouchers');
        $this->getJson('/api/vouchers?q=1')->assertJsonCount(1, 'vouchers');
        $this->getJson('/api/vouchers?status=draft')->assertJsonCount(1, 'vouchers');
        $this->getJson("/api/vouchers/{$id}/revision")->assertOk()->assertJsonStructure(['revision']);

        $this->deleteJson("/api/vouchers/{$draft}")->assertNoContent();
        $this->assertSame(1, Voucher::count());
    }

    public function test_quantities_in_arabic_words(): void
    {
        $this->assertSame('واحد', ArabicNumber::words(1));
        $this->assertSame('اثنان', ArabicNumber::words(2));
        $this->assertSame('أحد عشر', ArabicNumber::words(11));
        $this->assertSame('اثنا عشر', ArabicNumber::words(12));
        $this->assertSame('خمسة عشر', ArabicNumber::words(15));
        $this->assertSame('واحد وعشرون', ArabicNumber::words(21));
        $this->assertSame('مائة وخمسة', ArabicNumber::words(105));
        $this->assertSame('ألفان وثلاثمائة', ArabicNumber::words(2300));
        $this->assertSame('١٢٣', ArabicNumber::digits(123));
    }
}
