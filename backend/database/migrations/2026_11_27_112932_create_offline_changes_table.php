<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Changes a phone made without a connection and sent when it synced, with the answer each one
     * got (App\Http\Middleware\ApplyOfflineChange). A sync that is cut off and started again gets
     * the same answers, so nothing is saved twice.
     */
    public function up(): void
    {
        Schema::create('offline_changes', function (Blueprint $table) {
            $table->id();
            $table->string('key', 100)->unique();
            $table->foreignId('user_id')->nullable()->constrained()->nullOnDelete();
            $table->foreignId('synced_by')->nullable()->constrained('users')->nullOnDelete();
            $table->string('method', 10);
            $table->string('path', 255);
            $table->unsignedSmallInteger('status');
            $table->longText('response')->nullable();
            $table->timestamp('done_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('offline_changes');
    }
};
