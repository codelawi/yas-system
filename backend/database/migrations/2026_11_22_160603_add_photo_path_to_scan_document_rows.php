<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('scan_document_rows', function (Blueprint $table) {
            // A row added by reading text with the camera keeps a photo of the line read, as proof
            $table->string('photo_path')->nullable()->after('cells');
        });
    }

    public function down(): void
    {
        Schema::table('scan_document_rows', function (Blueprint $table) {
            $table->dropColumn('photo_path');
        });
    }
};
