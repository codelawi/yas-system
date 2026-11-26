<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // A draft made to correct an issued voucher: issuing it deletes that voucher and takes its number
        Schema::table('vouchers', function (Blueprint $table) {
            $table->foreignId('replaces_id')->nullable()->after('fields')->constrained('vouchers')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('vouchers', function (Blueprint $table) {
            $table->dropConstrainedForeignId('replaces_id');
        });
    }
};
