<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ScanDocument;
use App\Models\ScanDocumentRow;
use App\Models\ScanFolder;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;

/**
 * Folders of scan documents (مستندات المسح): a folder is made first, then documents inside it.
 * A document can check scanned codes for duplicates in itself or in its whole folder.
 */
class ScanFolderController extends Controller
{
    /** Folders with their document and row counts, the most recently used first. */
    public function index(): Collection
    {
        return ScanFolder::with('createdBy:id,name')
            ->withCount(['documents', 'rows'])
            ->withMax('documents', 'updated_at')
            ->get()
            ->each(function (ScanFolder $folder) {
                $documentsChangedAt = $folder->documents_max_updated_at ? Carbon::parse($folder->documents_max_updated_at) : null;
                $folder->setAttribute('last_change_at', $documentsChangedAt?->greaterThan($folder->updated_at) ? $documentsChangedAt : $folder->updated_at);
            })
            ->sortByDesc('last_change_at')
            ->values();
    }

    /**
     * A short fingerprint of all folders and documents. Open screens ask for it every few seconds
     * and reload the list only when it changes.
     *
     * @return array{revision: string}
     */
    public function listRevision(): array
    {
        $folders = ScanFolder::query()->selectRaw('COUNT(*) as total, COALESCE(SUM(revision), 0) as revisions, COALESCE(MAX(id), 0) as last_id')->first();
        $documents = ScanDocument::query()->selectRaw('COUNT(*) as total, COALESCE(SUM(revision), 0) as revisions, COALESCE(MAX(id), 0) as last_id')->first();

        return ['revision' => "{$folders->total}:{$folders->revisions}:{$folders->last_id}/{$documents->total}:{$documents->revisions}:{$documents->last_id}"];
    }

    public function store(Request $request): ScanFolder
    {
        $data = $request->validate(['name' => ['required', 'string', 'max:191']]);

        return ScanFolder::create([
            'name' => trim($data['name']),
            'created_by' => $request->user()->id,
            'updated_by' => $request->user()->id,
        ])->load('createdBy:id,name')->loadCount(['documents', 'rows']);
    }

    /** @return array{folder: ScanFolder, documents: \Illuminate\Database\Eloquent\Collection<int, ScanDocument>} */
    public function show(ScanFolder $scanFolder): array
    {
        return [
            'folder' => $scanFolder->load('createdBy:id,name'),
            'documents' => $scanFolder->documents()->with('createdBy:id,name')->withCount('rows')->latest('updated_at')->latest('id')->get(),
        ];
    }

    /**
     * Fingerprint of one folder and its documents (a rename, a document added, deleted or scanned into).
     *
     * @return array{revision: string}
     */
    public function revision(ScanFolder $scanFolder): array
    {
        $documents = $scanFolder->documents()->toBase()->selectRaw('COUNT(*) as total, COALESCE(SUM(revision), 0) as revisions, COALESCE(MAX(id), 0) as last_id')->first();

        return ['revision' => "{$scanFolder->revision}/{$documents->total}:{$documents->revisions}:{$documents->last_id}"];
    }

    public function update(Request $request, ScanFolder $scanFolder): ScanFolder
    {
        $data = $request->validate(['name' => ['required', 'string', 'max:191']]);
        $scanFolder->fill(['name' => trim($data['name']), 'updated_by' => $request->user()->id]);
        $scanFolder->revision++;
        $scanFolder->save();

        return $scanFolder->load('createdBy:id,name');
    }

    /** Deletes the folder with all its documents and their rows. */
    public function destroy(ScanFolder $scanFolder): Response
    {
        ScanDocumentRow::deletePhotoFiles(ScanDocumentRow::query()->whereIn('scan_document_id', $scanFolder->documents()->select('id')));
        $scanFolder->delete();

        return response()->noContent();
    }
}
