<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('equipment', function (Blueprint $table) {
            // An accessory is a full equipment linked to one main equipment (one level only)
            $table->foreignId('parent_id')->nullable()->after('id')->constrained('equipment')->cascadeOnDelete();
            // Short name, mostly used for accessories (e.g. "تمساح")
            $table->string('name')->nullable()->after('serial_number');
        });
    }

    public function down(): void
    {
        Schema::table('equipment', function (Blueprint $table) {
            $table->dropConstrainedForeignId('parent_id');
            $table->dropColumn('name');
        });
    }
};
