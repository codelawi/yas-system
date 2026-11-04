<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Boxes (صناديق): a numbered box with its own QR label, holding a group of equipment
        Schema::create('boxes', function (Blueprint $table) {
            $table->id();
            $table->string('number')->unique();
            $table->string('name')->nullable();
            $table->decimal('weight', 10, 2)->nullable();
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignId('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });

        // An equipment can be in several boxes at the same time
        Schema::create('box_equipment', function (Blueprint $table) {
            $table->id();
            $table->foreignId('box_id')->constrained()->cascadeOnDelete();
            $table->foreignId('equipment_id')->constrained()->cascadeOnDelete();
            $table->timestamps();
            $table->unique(['box_id', 'equipment_id']);
        });

        // One photo per equipment
        Schema::table('equipment', function (Blueprint $table) {
            $table->string('photo_path')->nullable()->after('category');
        });
    }

    public function down(): void
    {
        Schema::table('equipment', function (Blueprint $table) {
            $table->dropColumn('photo_path');
        });
        Schema::dropIfExists('box_equipment');
        Schema::dropIfExists('boxes');
    }
};
