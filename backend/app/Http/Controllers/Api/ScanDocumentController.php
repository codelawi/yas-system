<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ScanDocument;
use App\Models\ScanDocumentRow;
use App\Models\ScanFolder;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/**
 * Scan documents (مستندات المسح): a phone scans QR / Data Matrix codes and each code
 * becomes a row of the document's table. The table can then be edited and saved as Word.
 * Every document is in a folder (ScanFolderController lists them).
 */
class ScanDocumentController extends Controller
{
    public function store(Request $request): ScanDocument
    {
        $data = $request->validate([
            'scan_folder_id' => ['required', 'integer', 'exists:scan_folders,id'],
            'title' => ['required', 'string', 'max:191'],
            'columns' => ['nullable', 'array'],
            'duplicate_scope' => ['sometimes', Rule::in(ScanDocument::DUPLICATE_SCOPES)],
        ]);

        return ScanDocument::create([
            'scan_folder_id' => $data['scan_folder_id'],
            'title' => $data['title'],
            'columns' => isset($data['columns']) ? $this->validColumns($data['columns']) : ScanDocument::defaultColumns(),
            'duplicate_scope' => $data['duplicate_scope'] ?? 'document',
            'created_by' => $request->user()->id,
            'updated_by' => $request->user()->id,
        ])->load('createdBy:id,name')->loadCount('rows');
    }

    /** @return array{revision: int} */
    public function revision(ScanDocument $scanDocument): array
    {
        return ['revision' => $scanDocument->revision];
    }

    public function show(ScanDocument $scanDocument): array
    {
        return $this->full($scanDocument);
    }

    /** Title, columns (add, rename, reorder, remove) and where duplicates are checked. */
    public function update(Request $request, ScanDocument $scanDocument): array
    {
        $data = $request->validate([
            'title' => ['sometimes', 'required', 'string', 'max:191'],
            'columns' => ['sometimes', 'array'],
            'duplicate_scope' => ['sometimes', Rule::in(ScanDocument::DUPLICATE_SCOPES)],
        ]);
        if (array_key_exists('columns', $data)) {
            $data['columns'] = $this->validColumns($data['columns']);
        }
        $scanDocument->fill($data + ['updated_by' => $request->user()->id]);
        $scanDocument->revision++;
        $scanDocument->save();

        return $this->full($scanDocument);
    }

    public function destroy(ScanDocument $scanDocument): Response
    {
        ScanDocumentRow::deletePhotoFiles($scanDocument->rows());
        $scanDocument->delete();

        return response()->noContent();
    }

    /**
     * Adds one scanned code as a new row. A code already there is not added again: "there" is the
     * document, or every document of its folder (duplicate_scope). The answer then says which
     * document and row have it.
     *
     * A code read as text by the camera comes with a photo of the line read, kept with a new row.
     *
     * @return array{status: string, row: ScanDocumentRow, row_number: int, document: array{id: int, title: string}}
     */
    public function scan(Request $request, ScanDocument $scanDocument): array
    {
        $data = $request->validate([
            'code' => ['required', 'string', 'max:500'],
            'photo' => ['sometimes', 'file', 'max:4096', 'mimes:jpg,jpeg,png,webp'],
        ]);
        $code = trim($data['code']);
        if ($code === '') {
            throw ValidationException::withMessages(['code' => 'scan_empty']);
        }

        try {
            [$status, $row] = DB::transaction(function () use ($request, $scanDocument, $code) {
                // One scan at a time per folder, so two phones cannot add the same code to two of its documents
                ScanFolder::query()->whereKey($scanDocument->scan_folder_id)->lockForUpdate()->first();

                $existing = $scanDocument->duplicateCandidates()->where('code', $code)->first();
                if ($existing) {
                    return ['duplicate', $existing];
                }

                return ['added', $scanDocument->rows()->create([
                    'position' => $this->nextPosition($scanDocument),
                    'code' => $code,
                    'cells' => [],
                    'scanned_at' => now(),
                    'scanned_by' => $request->user()->id,
                ])];
            });
        } catch (UniqueConstraintViolationException) {
            // Two phones scanned the same code into this document at the same moment
            [$status, $row] = ['duplicate', $scanDocument->rows()->where('code', $code)->firstOrFail()];
        }
        if ($status === 'added') {
            if ($request->hasFile('photo')) {
                $row->update(['photo_path' => $request->file('photo')->storeAs(ScanDocumentRow::PHOTO_FOLDER, Str::uuid().'.jpg')]);
            }
            $scanDocument->increment('revision');
        }
        $rowDocument = $row->scan_document_id === $scanDocument->id ? $scanDocument : $row->document;

        return [
            'status' => $status,
            'row' => $row,
            'row_number' => $this->rowNumber($rowDocument, $row),
            'document' => ['id' => $rowDocument->id, 'title' => $rowDocument->title],
        ];
    }

    /** An empty row typed by hand, at the end of the table. */
    public function storeRow(Request $request, ScanDocument $scanDocument): ScanDocumentRow
    {
        $row = $scanDocument->rows()->create(['position' => $this->nextPosition($scanDocument), 'cells' => []]);
        $scanDocument->increment('revision');

        return $row;
    }

    /** Edits the scanned text and/or the typed cells of one row. */
    public function updateRow(Request $request, ScanDocument $scanDocument, ScanDocumentRow $row): ScanDocumentRow
    {
        abort_unless($row->scan_document_id === $scanDocument->id, 404);
        $data = $request->validate([
            'code' => ['sometimes', 'nullable', 'string', 'max:500'],
            'cells' => ['sometimes', 'array'],
            'cells.*' => ['nullable', 'string', 'max:2000'],
        ]);

        if (array_key_exists('code', $data)) {
            $code = trim((string) $data['code']);
            $code = $code === '' ? null : $code;
            if ($code !== null && $scanDocument->duplicateCandidates()->where('code', $code)->whereKeyNot($row->id)->exists()) {
                throw ValidationException::withMessages(['code' => $scanDocument->duplicate_scope === 'folder' ? 'scan_duplicate_folder' : 'scan_duplicate']);
            }
            $row->code = $code;
        }
        if (array_key_exists('cells', $data)) {
            $allowed = array_flip($scanDocument->cellKeys());
            $row->cells = array_merge($row->cells ?? [], array_intersect_key($data['cells'], $allowed));
        }
        $row->save();
        $scanDocument->increment('revision');

        return $row;
    }

    public function destroyRow(ScanDocument $scanDocument, ScanDocumentRow $row): Response
    {
        abort_unless($row->scan_document_id === $scanDocument->id, 404);
        if ($row->photo_path) {
            Storage::delete($row->photo_path);
        }
        $row->delete();
        $scanDocument->increment('revision');

        return response()->noContent();
    }

    /** The photo of the line a row's code was read from (text mode). Anyone can see it, as the document. */
    public function rowPhoto(ScanDocument $scanDocument, ScanDocumentRow $row): BinaryFileResponse
    {
        abort_unless($row->scan_document_id === $scanDocument->id && $row->photo_path && Storage::exists($row->photo_path), 404);

        // The URL changes with the photo (ScanDocumentRow::photo_url), so it can be cached
        return response()->file(Storage::path($row->photo_path), ['Cache-Control' => 'public, max-age=31536000']);
    }

    /** @return array{document: ScanDocument, rows: Collection} */
    private function full(ScanDocument $scanDocument): array
    {
        return [
            'document' => $scanDocument->load(['createdBy:id,name', 'folder:id,name']),
            'rows' => $scanDocument->rows()->with('scannedBy:id,name')->get(),
        ];
    }

    private function nextPosition(ScanDocument $scanDocument): int
    {
        return (int) $scanDocument->rows()->max('position') + 1;
    }

    /** The row's number (ت) as shown in the table: its place counted from 1. */
    private function rowNumber(ScanDocument $scanDocument, ScanDocumentRow $row): int
    {
        return $scanDocument->rows()
            ->where(fn ($query) => $query->where('position', '<', $row->position)
                ->orWhere(fn ($query) => $query->where('position', $row->position)->where('id', '<=', $row->id)))
            ->count();
    }

    /**
     * Built-in columns keep their key; added ones get keys like `c_ab12`. The scanned text column
     * can be renamed or moved but never removed.
     *
     * @param  array<int, mixed>  $columns
     * @return list<array{key: string, label: string}>
     */
    private function validColumns(array $columns): array
    {
        $clean = [];
        foreach ($columns as $column) {
            $key = is_array($column) ? (string) ($column['key'] ?? '') : '';
            $label = is_array($column) ? trim((string) ($column['label'] ?? '')) : '';
            $isKnown = in_array($key, ScanDocument::BUILT_IN_COLUMNS, true) || preg_match('/^c_[a-z0-9]{1,20}$/', $key);
            if (! $isKnown || $label === '' || mb_strlen($label) > 100 || isset($clean[$key])) {
                throw ValidationException::withMessages(['columns' => 'scan_doc_bad_columns']);
            }
            $clean[$key] = ['key' => $key, 'label' => $label];
        }
        if (! isset($clean['code']) || count($clean) > 30) {
            throw ValidationException::withMessages(['columns' => 'scan_doc_bad_columns']);
        }

        return array_values($clean);
    }
}
