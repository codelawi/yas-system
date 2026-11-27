<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Storage;

return new class extends Migration
{
    /**
     * Custody is only handed over with issue vouchers now, printed from their own templates:
     * the old custody forms and their uploaded files go.
     */
    public function up(): void
    {
        Schema::dropIfExists('custody_forms');
        Storage::deleteDirectory('custody_forms');
    }

    /** The table comes back empty: the uploaded files are gone. */
    public function down(): void
    {
        Schema::create('custody_forms', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('kind');
            $table->string('file_path');
            $table->string('original_name');
            $table->json('layout')->nullable();
            $table->boolean('is_default')->default(false);
            $table->timestamps();
        });
    }
};
