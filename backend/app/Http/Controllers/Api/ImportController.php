<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\Equipment;
use App\Models\EquipmentGroup;
use App\Models\Import;
use App\Models\Setting;
use App\Services\WordTableParser;
use App\Support\FieldDiff;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use RuntimeException;

class ImportController extends Controller
{
    public function index()
    {
        return Import::with('user:id,name')
            ->whereNotNull('committed_at')
            ->latest()
            ->paginate(20);
    }

    /**
     * Step 1: upload Word files. Returns every table (cells, merges, title) and the
     * detected mapping; the browser turns tables into items and lets the user adjust.
     */
    public function preview(Request $request)
    {
        $request->validate([
            'files' => ['required', 'array', 'max:100'],
            'files.*' => ['file', 'max:51200', 'extensions:docx'],
        ], ['files.*.extensions' => 'only_docx']);

        $this->cleanupStaleImports();

        $parser = new WordTableParser(
            preg_split('/\r?\n/', Setting::get('serial_aliases')),
            preg_split('/\r?\n/', (string) Setting::get('row_no_aliases')),
        );
        $results = [];

        foreach ($request->file('files') as $file) {
            $path = $file->storeAs('imports', Str::uuid().'.docx');
            $import = Import::create([
                'original_name' => $file->getClientOriginalName(),
                'stored_path' => $path,
                'user_id' => $request->user()->id,
            ]);

            try {
                $tables = $parser->analyze(Storage::path($path));
            } catch (RuntimeException) {
                $results[] = ['import_id' => $import->id, 'file' => $import->original_name, 'error' => 'not_docx', 'tables' => [], 'warnings' => []];

                continue;
            }

            $results[] = [
                'import_id' => $import->id,
                'file' => $import->original_name,
                'tables' => $tables,
                'warnings' => $tables ? [] : ['no_tables'],
            ];
        }

        return ['files' => $results];
    }

    /** Which of these serials already exist (used by the review step while the user edits the mapping). */
    public function check(Request $request)
    {
        $data = $request->validate([
            'serials' => ['present', 'array', 'max:5000'],
            'serials.*' => ['string', 'max:191'],
        ]);

        return Equipment::with('fields')
            ->whereIn('serial_number', array_unique($data['serials']))
            ->get()
            ->mapWithKeys(fn (Equipment $e) => [$e->serial_number => [
                'id' => $e->id,
                'category' => $e->category,
                'parent_id' => $e->parent_id,
                'fields' => $e->fieldList(),
            ]]);
    }

    /** Step 2: save the items the user approved in the preview. */
    public function commit(Request $request)
    {
        $data = $request->validate([
            'category' => ['nullable', 'string', 'max:191'],
            // Group chosen for everything in this import (new and overwritten main equipment)
            'group_id' => ['nullable', 'integer', 'exists:equipment_groups,id'],
            // Columns whose values are accessory serial numbers
            'accessory_keys' => ['array'],
            'accessory_keys.*' => ['string', 'max:255'],
            'items' => ['required', 'array'],
            'items.*.import_id' => ['required', 'integer', 'exists:imports,id'],
            'items.*.action' => ['required', Rule::in(['create', 'overwrite', 'skip'])],
            'items.*.serial' => ['nullable', 'string', 'max:191'],
            'items.*.row_no' => ['nullable', 'integer', 'min:0'],
            'items.*.category' => ['nullable', 'string', 'max:191'],
            'items.*.fields' => ['array'],
            'items.*.fields.*.key' => ['required', 'string', 'max:255'],
            'items.*.fields.*.value' => ['nullable', 'string', 'max:10000'],
            // Accessories chosen in the table mapper; when given, accessory_keys is not used for that item
            'items.*.accessories' => ['sometimes', 'array'],
            'items.*.accessories.*.name' => ['nullable', 'string', 'max:191'],
            'items.*.accessories.*.serial' => ['required', 'string', 'max:191'],
        ]);

        $userId = $request->user()->id;
        $counts = [];
        $errors = [];
        $accessoryCount = 0;
        $accessoryKeys = array_flip($data['accessory_keys'] ?? []);

        $group = isset($data['group_id']) ? EquipmentGroup::find($data['group_id']) : null;

        DB::transaction(function () use ($data, $userId, $accessoryKeys, $group, &$counts, &$errors, &$accessoryCount) {
            $handled = [];
            foreach ($data['items'] as $i => $item) {
                $importId = $item['import_id'];
                $counts[$importId] ??= ['created' => 0, 'updated' => 0, 'skipped' => 0];
                $serial = trim((string) ($item['serial'] ?? ''));

                if ($item['action'] === 'skip') {
                    $counts[$importId]['skipped']++;

                    continue;
                }
                if ($serial === '' || isset($handled[$serial])) {
                    $errors[] = ['index' => $i, 'serial' => $serial, 'error' => $serial === '' ? 'missing_serial' : 'duplicate_in_upload'];
                    $counts[$importId]['skipped']++;

                    continue;
                }
                $handled[$serial] = true;

                $fields = [];
                $accessories = array_map(fn ($a) => ['name' => $a['name'] ?? null, 'serial' => trim($a['serial'])], $item['accessories'] ?? []);
                foreach ($item['fields'] ?? [] as $f) {
                    $key = trim($f['key']);
                    if (! isset($item['accessories']) && isset($accessoryKeys[$key])) {
                        // One cell may hold several serials, one per line
                        foreach (preg_split('/\r?\n/', (string) ($f['value'] ?? '')) as $accSerial) {
                            if (trim($accSerial) !== '') {
                                $accessories[] = ['name' => $key, 'serial' => trim($accSerial)];
                            }
                        }
                    } else {
                        $fields[] = ['key' => $key, 'value' => $f['value'] ?? null];
                    }
                }
                $category = ($item['category'] ?? null) ?: ($data['category'] ?? null);

                Equipment::purgeTrashedSerial($serial);
                $equipment = Equipment::with('fields')->where('serial_number', $serial)->first();

                if ($equipment && $item['action'] !== 'overwrite') {
                    $errors[] = ['index' => $i, 'serial' => $serial, 'error' => 'exists'];
                    $counts[$importId]['skipped']++;

                    continue;
                }

                if ($equipment) {
                    $before = $equipment->fieldList();
                    $extraBefore = $equipment->only(['category']);
                    $equipment->update([
                        'row_no' => $item['row_no'] ?? $equipment->row_no,
                        'category' => $category ?? $equipment->category,
                        'import_id' => $importId,
                        'updated_by' => $userId,
                    ]);
                    $equipment->syncFields($fields);
                    $changes = FieldDiff::make($before, $equipment->fieldList(), $extraBefore, $equipment->only(['category']));
                    ActivityLog::record($equipment, 'imported', ($changes ?? []) + ['overwrite' => true], $userId);
                    if ($group && $equipment->parent_id === null && (int) $equipment->group_id !== $group->id) {
                        $equipment->update(['group_id' => $group->id]);
                        ActivityLog::record($equipment, 'group_changed', ['summary' => '→ '.$group->name], $userId);
                    }
                    $counts[$importId]['updated']++;
                } else {
                    $equipment = Equipment::create([
                        'serial_number' => $serial,
                        'row_no' => $item['row_no'] ?? null,
                        'category' => $category,
                        'group_id' => $group?->id,
                        'import_id' => $importId,
                        'created_by' => $userId,
                        'updated_by' => $userId,
                    ]);
                    $equipment->syncFields($fields);
                    ActivityLog::record($equipment, 'imported', ['added' => $equipment->fieldList()], $userId);
                    if ($group) {
                        ActivityLog::record($equipment, 'group_changed', ['summary' => '→ '.$group->name], $userId);
                    } else {
                        // A new unit joins the group of its kind (same name), if there is one
                        EquipmentGroup::joinByName($equipment);
                    }
                    $counts[$importId]['created']++;
                }

                foreach ($accessories as $acc) {
                    $result = $this->importAccessory($equipment, $acc, $importId, $userId, $handled);
                    if ($result === true) {
                        $accessoryCount++;
                    } elseif ($result !== null) {
                        $errors[] = ['index' => $i, 'serial' => $acc['serial'], 'error' => $result];
                    }
                }
            }

            foreach ($counts as $importId => $c) {
                Import::whereKey($importId)->update([
                    'created_count' => $c['created'],
                    'updated_count' => $c['updated'],
                    'skipped_count' => $c['skipped'],
                    'committed_at' => now(),
                ]);
            }
        });

        return [
            'created' => array_sum(array_column($counts, 'created')),
            'updated' => array_sum(array_column($counts, 'updated')),
            'skipped' => array_sum(array_column($counts, 'skipped')),
            'accessories' => $accessoryCount,
            'errors' => $errors,
        ];
    }

    /**
     * Creates one accessory under $parent. Returns true when created, null when it
     * already belongs to this parent (nothing to do), or an error key.
     */
    private function importAccessory(Equipment $parent, array $acc, int $importId, int $userId, array &$handled): bool|string|null
    {
        $serial = $acc['serial'];
        if ($parent->isAccessory()) {
            return 'nested_accessory';
        }
        if (isset($handled[$serial])) {
            return 'duplicate_in_upload';
        }
        $handled[$serial] = true;

        Equipment::purgeTrashedSerial($serial);
        $existing = Equipment::where('serial_number', $serial)->first();
        if ($existing) {
            // Accessories are fixed to their main equipment
            return $existing->parent_id === $parent->id ? null : 'accessory_taken';
        }

        $accessory = Equipment::create([
            'parent_id' => $parent->id,
            'serial_number' => $serial,
            'name' => $acc['name'],
            'category' => $parent->category,
            'import_id' => $importId,
            'created_by' => $userId,
            'updated_by' => $userId,
        ]);
        ActivityLog::record($accessory, 'imported', null, $userId);
        ActivityLog::record($parent, 'accessory_added', ['accessory' => $accessory->only(['id', 'serial_number', 'name'])], $userId);

        return true;
    }

    /** Original Word file the equipment was imported from. */
    public function download(Import $import)
    {
        abort_unless(Storage::exists($import->stored_path), 404);

        return Storage::download($import->stored_path, $import->original_name);
    }

    /** Previews that were never committed are removed after a day. */
    private function cleanupStaleImports(): void
    {
        Import::whereNull('committed_at')
            ->where('created_at', '<', now()->subDay())
            ->get()
            ->each(function (Import $import) {
                Storage::delete($import->stored_path);
                $import->delete();
            });
    }
}
