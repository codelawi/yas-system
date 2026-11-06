<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /** Accessories may repeat a serial or have none; main equipment stays unique through validation. */
    public function up(): void
    {
        Schema::table('equipment', function (Blueprint $table) {
            $table->dropUnique(['serial_number']);
        });

        Schema::table('equipment', function (Blueprint $table) {
            $table->string('serial_number')->nullable()->change();
            $table->index('serial_number');
        });
    }

    /** Fails once accessories share a serial or have none. */
    public function down(): void
    {
        Schema::table('equipment', function (Blueprint $table) {
            $table->dropIndex(['serial_number']);
        });

        Schema::table('equipment', function (Blueprint $table) {
            $table->string('serial_number')->nullable(false)->change();
            $table->unique('serial_number');
        });
    }
};
