<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Issue vouchers (سند صرف عهدة): equipment scanned on a phone or the computer, then handed
        // to a recipient together. A draft has no number yet; issuing gives it the next one.
        Schema::create('vouchers', function (Blueprint $table) {
            $table->id();
            $table->unsignedInteger('number')->nullable()->unique();
            $table->string('status')->default('draft')->index(); // draft | issued | returned
            $table->string('recipient')->nullable();
            // Values of the template's own fields (signatories...), filled in when issuing
            $table->json('fields')->nullable();
            // Bumped on every change, so other open screens reload
            $table->unsignedInteger('revision')->default(0);
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignId('issued_by')->nullable()->constrained('users')->nullOnDelete();
            $table->dateTime('issued_at')->nullable();
            $table->dateTime('returned_at')->nullable();
            $table->timestamps();
        });

        // Each scanned unit; once issued it points at the custody made for it
        Schema::create('voucher_items', function (Blueprint $table) {
            $table->id();
            $table->foreignId('voucher_id')->constrained()->cascadeOnDelete();
            $table->foreignId('equipment_id')->constrained()->cascadeOnDelete();
            $table->foreignId('custody_id')->nullable()->constrained('custodies')->nullOnDelete();
            $table->foreignId('added_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
            $table->unique(['voucher_id', 'equipment_id']);
        });

        Schema::table('custodies', function (Blueprint $table) {
            $table->foreignId('voucher_id')->nullable()->after('equipment_id')->constrained()->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('custodies', function (Blueprint $table) {
            $table->dropConstrainedForeignId('voucher_id');
        });
        Schema::dropIfExists('voucher_items');
        Schema::dropIfExists('vouchers');
    }
};
