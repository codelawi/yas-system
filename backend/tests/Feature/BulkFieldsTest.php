<?php

namespace Tests\Feature;

use App\Models\ActivityLog;
use App\Models\Equipment;
use App\Models\Setting;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class BulkFieldsTest extends TestCase
{
    use RefreshDatabase;

    private function fields(Equipment $e): array
    {
        return $e->fresh()->load('fields')->fieldList();
    }

    public function test_bulk_set_and_remove_a_field(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $a = Equipment::create(['serial_number' => 'B-1']);
        $a->syncFields([['key' => 'المكان', 'value' => 'قديم'], ['key' => 'الحالة', 'value' => 'جيد']]);
        $b = Equipment::create(['serial_number' => 'B-2']);

        $this->postJson('/api/equipment/bulk-update', ['ids' => [$a->id, $b->id], 'action' => 'set', 'key' => 'المكان', 'value' => 'المستودع B'])
            ->assertOk()->assertJson(['updated' => 2]);
        // Kept in its place for A, added for B
        $this->assertSame([['key' => 'المكان', 'value' => 'المستودع B'], ['key' => 'الحالة', 'value' => 'جيد']], $this->fields($a));
        $this->assertSame([['key' => 'المكان', 'value' => 'المستودع B']], $this->fields($b));
        $this->assertSame(2, ActivityLog::where('action', 'updated')->count());

        $this->postJson('/api/equipment/bulk-update', ['ids' => [$a->id], 'action' => 'remove', 'key' => 'الحالة'])->assertJson(['updated' => 1]);
        $this->assertSame([['key' => 'المكان', 'value' => 'المستودع B']], $this->fields($a));
    }

    public function test_bulk_category(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $a = Equipment::create(['serial_number' => 'C-1']);

        $this->postJson('/api/equipment/bulk-update', ['ids' => [$a->id], 'action' => 'category', 'category' => 'مولدات'])->assertJson(['updated' => 1]);
        $this->assertSame('مولدات', $a->fresh()->category);
    }

    public function test_rename_merges_field_names_and_updates_the_label_design(): void
    {
        Sanctum::actingAs(User::factory()->admin()->create());
        $a = Equipment::create(['serial_number' => 'R-1']);
        $a->syncFields([['key' => 'الحاله', 'value' => 'جيد'], ['key' => 'المكان', 'value' => 'X']]);
        $b = Equipment::create(['serial_number' => 'R-2']);
        $b->syncFields([['key' => 'Status', 'value' => 'تالف'], ['key' => 'الحالة', 'value' => '']]);
        Setting::create(['key' => 'label_template', 'value' => json_encode(['width' => 50, 'height' => 30, 'elements' => [['id' => 'x', 'type' => 'field', 'source' => 'field:الحاله']]])]);

        $this->postJson('/api/fields/rename', ['from' => ['الحاله', 'Status'], 'to' => 'الحالة'])->assertOk()->assertJson(['updated' => 2]);

        $this->assertSame([['key' => 'الحالة', 'value' => 'جيد'], ['key' => 'المكان', 'value' => 'X']], $this->fields($a));
        $this->assertSame([['key' => 'الحالة', 'value' => 'تالف']], $this->fields($b));
        $this->assertSame('field:الحالة', json_decode(Setting::get('label_template'), true)['elements'][0]['source']);
        $this->getJson('/api/fields/usage')->assertJsonFragment(['key' => 'الحالة', 'uses' => 2]);
    }

    public function test_renaming_needs_an_admin(): void
    {
        Sanctum::actingAs(User::factory()->create());

        $this->postJson('/api/fields/rename', ['from' => ['a'], 'to' => 'b'])->assertForbidden();
    }
}
