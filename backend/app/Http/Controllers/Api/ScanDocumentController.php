<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ScanDocument;
use App\Models\ScanDocumentRow;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Scan documents (مستندات المسح): a phone scans QR / Data Matrix codes and each code
 * becomes a row of the document's table. The table can then be edited and saved as Word.
 */
class ScanDocumentController extends Controller
{
    public function index(): Collection
    {
        return ScanDocument::with('createdBy:id,name')->withCount('rows')->latest('updated_at')->limit(200)->get();
    }

    public function store(Request $request): ScanDocument
    {
        $data = $request->validate([
            'title' => ['required', 'string', 'max:191'],
            'columns' => ['nullable', 'array'],
        ]);

        return ScanDocument::create([
            'title' => $data['title'],
            'columns' => isset($data['columns']) ? $this->validColumns($data['columns']) : ScanDocument::defaultColumns(),
            'created_by' => $request->user()->id,
            'updated_by' => $request->user()->id,
        ])->load('createdBy:id,name')->loadCount('rows');
    }

    public function show(ScanDocument $scanDocument): array
    {
        return $this->full($scanDocument);
    }

    /** Title and columns (add, rename, reorder, remove). */
    public function update(Request $request, ScanDocument $scanDocument): array
    {
        $data = $request->validate([
            'title' => ['sometimes', 'required', 'string', 'max:191'],
            'columns' => ['sometimes', 'array'],
        ]);
        if (array_key_exists('columns', $data)) {
            $data['columns'] = $this->validColumns($data['columns']);
        }
        $scanDocument->update($data + ['updated_by' => $request->user()->id]);

        return $this->full($scanDocument);
    }

    public function destroy(ScanDocument $scanDocument): Response
    {
        $scanDocument->delete();

        return response()->noContent();
    }

    /**
     * Adds one scanned code as a new row. A code already in the document is not added again:
     * the answer then says which row has it.
     *
     * @return array{status: string, row: ScanDocumentRow, row_number: int}
     */
    public function scan(Request $request, ScanDocument $scanDocument): array
    {
        $data = $request->validate(['code' => ['required', 'string', 'max:500']]);
        $code = trim($data['code']);
        if ($code === '') {
            throw ValidationException::withMessages(['code' => 'scan_empty']);
        }

        $existing = $scanDocument->rows()->where('code', $code)->first();
        if ($existing) {
            return ['status' => 'duplicate', 'row' => $existing, 'row_number' => $this->rowNumber($scanDocument, $existing)];
        }

        try {
            $row = DB::transaction(fn () => $scanDocument->rows()->create([
                'position' => $this->nextPosition($scanDocument),
                'code' => $code,
                'cells' => [],
                'scanned_at' => now(),
                'scanned_by' => $request->user()->id,
            ]));
        } catch (UniqueConstraintViolationException) {
            // Two phones scanned the same code at the same moment
            $existing = $scanDocument->rows()->where('code', $code)->firstOrFail();

            return ['status' => 'duplicate', 'row' => $existing, 'row_number' => $this->rowNumber($scanDocument, $existing)];
        }
        $scanDocument->touch();

        return ['status' => 'added', 'row' => $row, 'row_number' => $this->rowNumber($scanDocument, $row)];
    }

    /** An empty row typed by hand, at the end of the table. */
    public function storeRow(Request $request, ScanDocument $scanDocument): ScanDocumentRow
    {
        $row = $scanDocument->rows()->create(['position' => $this->nextPosition($scanDocument), 'cells' => []]);
        $scanDocument->touch();

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
            if ($code !== null && $scanDocument->rows()->where('code', $code)->whereKeyNot($row->id)->exists()) {
                throw ValidationException::withMessages(['code' => 'scan_duplicate']);
            }
            $row->code = $code;
        }
        if (array_key_exists('cells', $data)) {
            $allowed = array_flip($scanDocument->cellKeys());
            $row->cells = array_merge($row->cells ?? [], array_intersect_key($data['cells'], $allowed));
        }
        $row->save();
        $scanDocument->touch();

        return $row;
    }

    public function destroyRow(ScanDocument $scanDocument, ScanDocumentRow $row): Response
    {
        abort_unless($row->scan_document_id === $scanDocument->id, 404);
        $row->delete();
        $scanDocument->touch();

        return response()->noContent();
    }

    /** @return array{document: ScanDocument, rows: Collection} */
    private function full(ScanDocument $scanDocument): array
    {
        return [
            'document' => $scanDocument->load('createdBy:id,name'),
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
