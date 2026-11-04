<?php

namespace Tests\Feature;

use App\Models\Setting;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

class QrAddressLockTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        Sanctum::actingAs(User::factory()->admin()->create());
        Setting::create(['key' => 'base_url', 'value' => 'http://repo.local']);
    }

    public function test_printed_labels_are_counted_per_address(): void
    {
        $this->postJson('/api/labels/printed', ['url' => 'http://repo.local', 'count' => 120])->assertOk();
        $this->postJson('/api/labels/printed', ['url' => 'http://repo.local/', 'count' => 30])
            ->assertOk()
            ->assertJsonPath('printed', ['http://repo.local' => 150]);
    }

    public function test_address_can_change_freely_before_any_label_is_printed(): void
    {
        $this->putJson('/api/settings', ['base_url' => 'http://192.168.1.10'])->assertOk()->assertJsonPath('base_url', 'http://192.168.1.10');
    }

    public function test_changing_the_address_after_printing_needs_confirmation(): void
    {
        $this->postJson('/api/labels/printed', ['url' => 'http://repo.local', 'count' => 2000]);

        $this->putJson('/api/settings', ['base_url' => 'http://192.168.1.10'])
            ->assertUnprocessable()
            ->assertJsonPath('errors.base_url.0', 'qr_address_locked:2000');
        $this->putJson('/api/network/base-url', ['base_url' => 'http://192.168.1.10'])->assertUnprocessable();
        $this->assertSame('http://repo.local', Setting::get('base_url'));

        $this->putJson('/api/settings', ['base_url' => 'http://192.168.1.10', 'confirm_base_url' => 'http://192.168.1.10'])->assertOk();
        $this->assertSame('http://192.168.1.10', Setting::get('base_url'));
    }

    public function test_saving_the_same_address_or_other_settings_is_not_blocked(): void
    {
        $this->postJson('/api/labels/printed', ['url' => 'http://repo.local', 'count' => 5]);

        $this->putJson('/api/settings', ['base_url' => 'http://repo.local/'])->assertOk();
        $this->putJson('/api/settings', ['label_width_mm' => 40])->assertOk();
    }

    public function test_check_address_flags_localhost_and_unknown_hosts(): void
    {
        $this->getJson('/api/network/check-address?url=http://localhost')->assertJsonPath('status', 'localhost');
        $this->getJson('/api/network/check-address?url=http://192.0.2.55')->assertJsonPath('status', 'mismatch');
    }

    public function test_command_refuses_an_address_that_does_not_lead_here(): void
    {
        $this->artisan('repo:qr-address', ['url' => 'http://192.0.2.55'])->assertFailed();
        $this->assertSame('http://repo.local', Setting::get('base_url'));

        $this->artisan('repo:qr-address', ['url' => 'http://192.0.2.55', '--force' => true])->assertSuccessful();
        $this->assertSame('http://192.0.2.55', Setting::get('base_url'));
    }

    public function test_command_respects_the_lock_after_printing(): void
    {
        $this->postJson('/api/labels/printed', ['url' => 'http://repo.local', 'count' => 2000]);

        $this->artisan('repo:qr-address', ['url' => 'http://192.0.2.55', '--force' => true])->assertFailed();
        $this->artisan('repo:qr-address', ['url' => 'http://192.0.2.55', '--force' => true, '--confirm' => 'http://192.0.2.55'])->assertSuccessful();
        $this->assertSame('http://192.0.2.55', Setting::get('base_url'));
    }
}
