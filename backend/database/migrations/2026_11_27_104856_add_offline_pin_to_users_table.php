<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * A second hash of each PIN that a phone can check without the server (App\Support\OfflinePin).
     * Made the next time the PIN is typed, since the PIN itself is only kept as a bcrypt hash.
     */
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->string('offline_pin')->nullable()->after('pin');
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->dropColumn('offline_pin');
        });
    }
};
