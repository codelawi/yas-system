<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('equipment', function (Blueprint $table) {
            // «ت» column of the Word table: the row's number inside its table (restarts per table)
            $table->unsignedInteger('row_no')->nullable()->after('name')->index();
        });
    }

    public function down(): void
    {
        Schema::table('equipment', function (Blueprint $table) {
            $table->dropIndex(['row_no']);
            $table->dropColumn('row_no');
        });
    }
};
