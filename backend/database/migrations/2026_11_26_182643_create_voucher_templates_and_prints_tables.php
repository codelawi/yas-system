<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // How a voucher looks on A5 paper: a header and a footer edited like Word (repeated on every
        // page), the table of equipment between them, and the voucher's own fields (signatories...)
        Schema::create('voucher_templates', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->boolean('is_default')->default(false);
            $table->longText('header')->nullable();
            $table->longText('footer')->nullable();
            $table->json('item_table'); // not "table": that name is taken on every model
            $table->json('fields');
            $table->json('style');
            $table->timestamps();
        });

        Schema::table('vouchers', function (Blueprint $table) {
            $table->foreignId('template_id')->nullable()->after('replaces_id')->constrained('voucher_templates')->nullOnDelete();
            // The template as it was when issued: a reprint looks like the first print
            $table->json('layout')->nullable()->after('template_id');
        });

        // Prints waiting for the print station on the laptop
        Schema::create('voucher_prints', function (Blueprint $table) {
            $table->id();
            $table->foreignId('voucher_id')->constrained()->cascadeOnDelete();
            $table->unsignedTinyInteger('copies')->default(1);
            $table->string('status')->default('pending')->index(); // pending | printed | cancelled
            $table->foreignId('requested_by')->nullable()->constrained('users')->nullOnDelete();
            $table->dateTime('finished_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('voucher_prints');
        Schema::table('vouchers', function (Blueprint $table) {
            $table->dropConstrainedForeignId('template_id');
            $table->dropColumn('layout');
        });
        Schema::dropIfExists('voucher_templates');
    }
};
