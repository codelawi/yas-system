<?php

namespace Tests\Feature;

use App\Models\Equipment;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/** A phone connected to the system learns that the copy it downloaded is out of date (App\Support\DataRevision). */
class OfflineRevisionTest extends TestCase
{
    use RefreshDatabase;

    private function revision(): string
    {
        return $this->getJson('/api/offline/revision')->assertOk()->json('revision');
    }

    public function test_anyone_on_the_network_can_ask_without_a_pin(): void
    {
        $first = $this->revision();

        $this->assertNotSame('', $first);
        $this->assertSame($first, $this->revision());
    }

    public function test_the_copy_holds_the_revision_it_was_made_with(): void
    {
        Sanctum::actingAs(User::factory()->create());

        $snapshot = $this->getJson('/api/offline/snapshot')->assertOk()->json('revision');

        $this->assertSame($this->revision(), $snapshot);
    }

    public function test_any_change_on_the_system_changes_it(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $before = $this->revision();

        $id = $this->postJson('/api/equipment', ['serial_number' => 'REV-1'])->assertOk()->json('id');
        $afterAdd = $this->revision();
        $this->assertNotSame($before, $afterAdd);

        $this->deleteJson("/api/equipment/{$id}")->assertSuccessful();
        $this->assertNotSame($afterAdd, $this->revision());
    }

    public function test_reading_or_a_refused_change_leaves_it_alone(): void
    {
        Sanctum::actingAs(User::factory()->create());
        Equipment::create(['serial_number' => 'REV-2']);
        $before = $this->revision();

        $this->getJson('/api/equipment')->assertOk();
        $this->getJson('/api/offline/snapshot')->assertOk();
        $this->postJson('/api/equipment', ['serial_number' => ''])->assertUnprocessable();
        $this->postJson('/api/offline/done', ['keys' => ['none']])->assertOk();

        $this->assertSame($before, $this->revision());
    }

    public function test_a_change_sent_again_by_a_sync_is_counted_once(): void
    {
        Sanctum::actingAs(User::factory()->create());
        $headers = ['X-Offline-Change' => (string) Str::uuid()];
        $this->postJson('/api/equipment', ['serial_number' => 'REV-3'], $headers)->assertOk();
        $after = $this->revision();

        $this->postJson('/api/equipment', ['serial_number' => 'REV-3'], $headers)->assertOk()->assertHeader('X-Offline-Replayed', '1');

        $this->assertSame($after, $this->revision());
    }

    public function test_unlocking_changes_it_only_when_the_pin_is_new_to_the_phones(): void
    {
        User::factory()->create(['pin' => '246810']);
        $before = $this->revision();

        $this->postJson('/api/auth/login', ['pin' => '246810'])->assertOk();
        $afterFirst = $this->revision();
        $this->assertNotSame($before, $afterFirst);

        $this->postJson('/api/auth/login', ['pin' => '246810'])->assertOk();
        $this->assertSame($afterFirst, $this->revision());
    }
}
