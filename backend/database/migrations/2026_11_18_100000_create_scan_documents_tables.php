<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Scan documents (مستندات المسح): a table that fills itself as QR / Data Matrix codes are scanned
        Schema::create('scan_documents', function (Blueprint $table) {
            $table->id();
            $table->string('title');
            $table->json('columns');
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignId('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });

        Schema::create('scan_document_rows', function (Blueprint $table) {
            $table->id();
            $table->foreignId('scan_document_id')->constrained()->cascadeOnDelete();
            $table->unsignedInteger('position');
            // The scanned text exactly as read. Empty for a row typed by hand.
            $table->string('code', 500)->nullable();
            $table->json('cells')->nullable();
            $table->dateTime('scanned_at')->nullable();
            $table->foreignId('scanned_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
            $table->index(['scan_document_id', 'position']);
            // The same code only once per document
            $table->unique(['scan_document_id', 'code']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('scan_document_rows');
        Schema::dropIfExists('scan_documents');
    }
};
