<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // What an issue voucher (سند صرف) prints for this kind of equipment:
        // the company's code («الحرف والرقم») and its name on the voucher (the group name when empty)
        Schema::table('equipment_groups', function (Blueprint $table) {
            $table->string('voucher_code')->nullable()->after('name_key');
            $table->string('voucher_name')->nullable()->after('voucher_code');
        });
    }

    public function down(): void
    {
        Schema::table('equipment_groups', function (Blueprint $table) {
            $table->dropColumn(['voucher_code', 'voucher_name']);
        });
    }
};
