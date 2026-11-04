<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Groups (مجموعات): a kind of equipment, e.g. «وحدة الفتح والقص», holding every unit of that kind
        Schema::create('equipment_groups', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            // Normalized name (no diacritics, أ/إ/آ → ا ...) so «وحدة الفتح والقص» and «وحده الفتح و القص» match
            $table->string('name_key')->unique();
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });

        Schema::table('equipment', function (Blueprint $table) {
            $table->foreignId('group_id')->nullable()->after('parent_id')->constrained('equipment_groups')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('equipment', function (Blueprint $table) {
            $table->dropConstrainedForeignId('group_id');
        });
        Schema::dropIfExists('equipment_groups');
    }
};
