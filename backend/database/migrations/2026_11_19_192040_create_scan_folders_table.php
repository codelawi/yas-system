<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Folders of scan documents: a folder is made first, then its documents inside it
        Schema::create('scan_folders', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            // Goes up by one with every change, like scan_documents.revision
            $table->unsignedInteger('revision')->default(0);
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignId('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });

        Schema::table('scan_documents', function (Blueprint $table) {
            $table->foreignId('scan_folder_id')->nullable()->after('id')->constrained()->cascadeOnDelete();
            // Where a scanned code must not repeat: "document" = this document, "folder" = any document of its folder
            $table->string('duplicate_scope', 10)->default('document')->after('columns');
        });

        // Documents made before folders existed go into one folder, so none is lost
        if (DB::table('scan_documents')->exists()) {
            $folderId = DB::table('scan_folders')->insertGetId([
                'name' => 'المستندات السابقة',
                'created_at' => now(),
                'updated_at' => now(),
            ]);
            DB::table('scan_documents')->whereNull('scan_folder_id')->update(['scan_folder_id' => $folderId]);
        }
    }

    public function down(): void
    {
        Schema::table('scan_documents', function (Blueprint $table) {
            $table->dropConstrainedForeignId('scan_folder_id');
            $table->dropColumn('duplicate_scope');
        });
        Schema::dropIfExists('scan_folders');
    }
};
