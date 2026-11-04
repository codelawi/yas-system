<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Upcoming dates per equipment (inspection, warranty, expiry...), optionally repeating
        Schema::create('maintenance_schedules', function (Blueprint $table) {
            $table->id();
            $table->foreignId('equipment_id')->constrained()->cascadeOnDelete();
            $table->string('title');
            $table->date('due_date')->index();
            $table->unsignedSmallInteger('interval_months')->nullable();
            $table->text('notes')->nullable();
            $table->timestamps();
        });

        // Work that was done
        Schema::create('maintenance_records', function (Blueprint $table) {
            $table->id();
            $table->foreignId('equipment_id')->constrained()->cascadeOnDelete();
            $table->foreignId('schedule_id')->nullable()->constrained('maintenance_schedules')->nullOnDelete();
            $table->string('title');
            $table->date('done_at');
            $table->text('notes')->nullable();
            $table->decimal('cost', 12, 2)->nullable();
            $table->foreignId('user_id')->nullable()->constrained()->nullOnDelete();
            $table->timestamps();
        });

        // Custody (عهدة): who holds an equipment, from when, until when
        Schema::create('custodies', function (Blueprint $table) {
            $table->id();
            $table->foreignId('equipment_id')->constrained()->cascadeOnDelete();
            $table->string('holder');
            $table->string('holder_phone')->nullable();
            $table->text('notes')->nullable();
            $table->dateTime('handed_at');
            $table->date('due_back_at')->nullable();
            $table->dateTime('returned_at')->nullable();
            $table->text('return_notes')->nullable();
            $table->foreignId('handed_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignId('received_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
            $table->index(['equipment_id', 'returned_at']);
        });

        // Problems reported by anyone who scans a label (no PIN needed)
        Schema::create('issue_reports', function (Blueprint $table) {
            $table->id();
            $table->foreignId('equipment_id')->constrained()->cascadeOnDelete();
            $table->text('description');
            $table->string('reporter')->nullable();
            $table->string('photo_path')->nullable();
            $table->string('status')->default('open')->index();
            $table->text('resolution')->nullable();
            $table->foreignId('closed_by')->nullable()->constrained('users')->nullOnDelete();
            $table->dateTime('closed_at')->nullable();
            $table->string('ip', 45)->nullable();
            $table->timestamps();
        });

        // Stocktake (جرد): scan labels and compare with the expected equipment
        Schema::create('stocktakes', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->json('filters')->nullable();
            $table->boolean('include_accessories')->default(true);
            $table->string('status')->default('open');
            $table->foreignId('started_by')->nullable()->constrained('users')->nullOnDelete();
            $table->dateTime('closed_at')->nullable();
            $table->timestamps();
        });

        Schema::create('stocktake_scans', function (Blueprint $table) {
            $table->id();
            $table->foreignId('stocktake_id')->constrained()->cascadeOnDelete();
            $table->foreignId('equipment_id')->nullable()->constrained()->nullOnDelete();
            $table->string('serial_number');
            $table->string('result'); // found | unexpected | unknown
            $table->foreignId('scanned_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
            $table->unique(['stocktake_id', 'serial_number']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('stocktake_scans');
        Schema::dropIfExists('stocktakes');
        Schema::dropIfExists('issue_reports');
        Schema::dropIfExists('custodies');
        Schema::dropIfExists('maintenance_records');
        Schema::dropIfExists('maintenance_schedules');
    }
};
