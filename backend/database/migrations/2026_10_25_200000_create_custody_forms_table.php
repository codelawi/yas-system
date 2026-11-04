<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Paper printed when equipment is handed over: an uploaded PDF/image/Word/Excel
        // template plus where each value goes (PDF/image) — Word/Excel use {{tags}}.
        Schema::create('custody_forms', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('kind'); // pdf | image | docx | xlsx
            $table->string('file_path');
            $table->string('original_name');
            $table->json('layout')->nullable();
            $table->boolean('is_default')->default(false);
            $table->timestamps();
        });

        // More about the person who receives the equipment (printed on the form)
        Schema::table('custodies', function (Blueprint $table) {
            $table->string('holder_id_number')->nullable()->after('holder_phone');
            $table->string('holder_department')->nullable()->after('holder_id_number');
        });
    }

    public function down(): void
    {
        Schema::table('custodies', function (Blueprint $table) {
            $table->dropColumn(['holder_id_number', 'holder_department']);
        });
        Schema::dropIfExists('custody_forms');
    }
};
