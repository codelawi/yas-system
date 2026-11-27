<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Equipment and boxes added on a phone without a connection have no label yet: the home page
     * lists them («بانتظار الملصق») until their labels are printed.
     */
    public function up(): void
    {
        Schema::table('equipment', function (Blueprint $table) {
            $table->boolean('label_pending')->default(false)->index();
        });
        Schema::table('boxes', function (Blueprint $table) {
            $table->boolean('label_pending')->default(false)->index();
        });
    }

    public function down(): void
    {
        Schema::table('equipment', function (Blueprint $table) {
            $table->dropIndex(['label_pending']);
            $table->dropColumn('label_pending');
        });
        Schema::table('boxes', function (Blueprint $table) {
            $table->dropIndex(['label_pending']);
            $table->dropColumn('label_pending');
        });
    }
};
