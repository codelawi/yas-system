<?php

namespace Tests\Feature;

use App\Models\ActivityLog;
use App\Models\Equipment;
use App\Models\Setting;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class DashboardStatsTest extends TestCase
{
    use RefreshDatabase;

    public function test_counts_and_needs_attention(): void
    {
        $broken = Equipment::create(['serial_number' => 'GEN-1']);
        $broken->syncFields([['key' => 'الحالة', 'value' => 'يحتاج صيانة عاجلة']]);
        $fine = Equipment::create(['serial_number' => 'GEN-2']);
        $fine->syncFields([['key' => 'الحالة', 'value' => 'جيد']]);
        Equipment::create(['serial_number' => 'GEN-2-A', 'parent_id' => $fine->id]);
        Equipment::create(['serial_number' => 'EMPTY-1']);

        $this->getJson('/api/stats')
            ->assertOk()
            ->assertJsonPath('main', 3)
            ->assertJsonPath('accessories', 1)
            ->assertJsonPath('without_data', 1)
            ->assertJsonPath('attention.total', 1)
            ->assertJsonPath('attention.items.0.serial_number', 'GEN-1')
            ->assertJsonPath('recent_equipment.0.serial_number', 'EMPTY-1');
    }

    public function test_attention_words_come_from_the_settings(): void
    {
        Setting::create(['key' => 'attention_words', 'value' => "مفقود\n"]);
        Equipment::create(['serial_number' => 'X-1'])->syncFields([['key' => 'الحالة', 'value' => 'يحتاج صيانة']]);
        Equipment::create(['serial_number' => 'X-2'])->syncFields([['key' => 'ملاحظات', 'value' => 'مفقود منذ شهر']]);

        $this->getJson('/api/stats')->assertJsonPath('attention.total', 1)->assertJsonPath('attention.items.0.serial_number', 'X-2');
    }

    public function test_activity_chart_and_import_users_need_a_pin(): void
    {
        ActivityLog::record(Equipment::create(['serial_number' => 'A-1']), 'created');

        $this->getJson('/api/stats')->assertJsonPath('activity_by_day', null);

        Sanctum::actingAs(User::factory()->create());
        $days = $this->getJson('/api/stats')->assertOk()->json('activity_by_day');
        $this->assertCount(30, $days);
        $this->assertSame(1, end($days)['count']);
    }
}
