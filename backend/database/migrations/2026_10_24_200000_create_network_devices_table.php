<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Phones / PCs that opened the system, recorded by the TrackDevice middleware
        Schema::create('network_devices', function (Blueprint $table) {
            $table->id();
            $table->string('ip', 45)->unique();
            $table->string('name')->nullable();
            $table->text('user_agent')->nullable();
            $table->foreignId('last_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->unsignedInteger('hits')->default(0);
            $table->boolean('blocked')->default(false);
            $table->timestamp('first_seen_at')->nullable();
            $table->timestamp('last_seen_at')->nullable();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('network_devices');
    }
};
