<?php

namespace Tests\Feature;

use App\Models\ActivityLog;
use App\Models\Equipment;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class HistoryPrivacyTest extends TestCase
{
    use RefreshDatabase;

    private Equipment $equipment;

    protected function setUp(): void
    {
        parent::setUp();

        $this->equipment = Equipment::create(['serial_number' => 'H-1']);
        ActivityLog::record($this->equipment, 'created');
        ActivityLog::record(Equipment::create(['serial_number' => 'OTHER-9']), 'updated');
    }

    public function test_guests_do_not_receive_any_history(): void
    {
        $this->getJson('/api/equipment/'.$this->equipment->id)->assertOk()->assertJsonPath('logs', null);
        $this->getJson('/api/equipment/serial/H-1')->assertOk()->assertJsonPath('logs', null);
        $this->getJson('/api/stats')->assertOk()->assertJsonPath('recent_activity', null);
        $this->getJson('/api/activity')->assertUnauthorized();
    }

    public function test_people_with_a_pin_see_the_history(): void
    {
        Sanctum::actingAs(User::factory()->create());

        $this->getJson('/api/equipment/'.$this->equipment->id)->assertOk()->assertJsonCount(1, 'logs');
        $this->getJson('/api/stats')->assertOk()->assertJsonCount(2, 'recent_activity');
        $this->getJson('/api/activity')->assertOk()->assertJsonPath('total', 2);
    }

    public function test_history_tab_filters(): void
    {
        Sanctum::actingAs(User::factory()->create());

        $this->getJson('/api/activity?q=H-')->assertOk()->assertJsonPath('total', 1)->assertJsonPath('data.0.serial_number', 'H-1');
        $this->getJson('/api/activity?action=updated')->assertOk()->assertJsonPath('total', 1)->assertJsonPath('data.0.serial_number', 'OTHER-9');
        $this->getJson('/api/activity?from=2000-01-01&to=2000-01-02')->assertOk()->assertJsonPath('total', 0);
    }
}
