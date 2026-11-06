<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Custody;
use App\Models\CustodyForm;
use App\Support\CustodyFormData;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use RuntimeException;

/** Custody forms (سند عهدة): uploaded templates printed when equipment is handed over. */
class CustodyFormController extends Controller
{
    private const KINDS = ['pdf' => 'pdf', 'png' => 'image', 'jpg' => 'image', 'jpeg' => 'image', 'docx' => 'docx', 'xlsx' => 'xlsx'];

    public function index()
    {
        return CustodyForm::orderByDesc('is_default')->orderBy('name')->get();
    }

    public function store(Request $request)
    {
        $data = $request->validate([
            'name' => ['nullable', 'string', 'max:191'],
            'file' => ['required', 'file', 'max:20480'],
        ]);
        $file = $request->file('file');
        $ext = strtolower($file->getClientOriginalExtension());
        if (in_array($ext, ['doc', 'xls'], true)) {
            throw ValidationException::withMessages(['file' => 'form_old_format']);
        }
        if (! isset(self::KINDS[$ext])) {
            throw ValidationException::withMessages(['file' => 'form_bad_type']);
        }
        $kind = self::KINDS[$ext];

        $path = $file->storeAs('custody_forms', Str::uuid().'.'.$ext);
        if (in_array($kind, ['docx', 'xlsx'], true)) {
            try {
                CustodyFormData::tagsIn(Storage::path($path), $kind);
            } catch (RuntimeException) {
                Storage::delete($path);
                throw ValidationException::withMessages(['file' => 'form_bad_file']);
            }
        }

        $original = $file->getClientOriginalName();

        return CustodyForm::create([
            'name' => trim($data['name'] ?? '') ?: pathinfo($original, PATHINFO_FILENAME),
            'kind' => $kind,
            'file_path' => $path,
            'original_name' => $original,
            'is_default' => ! CustodyForm::exists(),
        ]);
    }

    public function update(Request $request, CustodyForm $form)
    {
        $data = $request->validate([
            'name' => ['sometimes', 'required', 'string', 'max:191'],
            'is_default' => ['sometimes', 'boolean'],
            'layout' => ['sometimes', 'nullable', 'array'],
            'layout.pages' => ['array', 'max:30'],
            'layout.pages.*.w' => ['required', 'numeric', 'min:10', 'max:2000'],
            'layout.pages.*.h' => ['required', 'numeric', 'min:10', 'max:2000'],
            'layout.elements' => ['array', 'max:300'],
            'layout.elements.*.type' => ['required', 'in:field,text,qr,box'],
            'layout.elements.*.page' => ['required', 'integer', 'min:0'],
        ]);
        // validate() keeps only the checked keys of each element; store the whole design
        if (array_key_exists('layout', $data)) {
            $data['layout'] = $request->input('layout');
            if (strlen(json_encode($data['layout'])) > 200000) {
                throw ValidationException::withMessages(['layout' => 'form_layout_too_big']);
            }
        }

        DB::transaction(function () use ($form, $data) {
            if ($data['is_default'] ?? false) {
                CustodyForm::whereKeyNot($form->id)->update(['is_default' => false]);
            }
            $form->update($data);
        });

        return $form;
    }

    public function destroy(CustodyForm $form)
    {
        DB::transaction(function () use ($form) {
            $form->delete();
            if ($form->is_default) {
                CustodyForm::orderBy('id')->first()?->update(['is_default' => true]);
            }
        });
        Storage::delete($form->file_path);

        return response()->noContent();
    }

    /** The uploaded template itself (PDF/image are drawn by the browser). */
    public function file(CustodyForm $form)
    {
        abort_unless(Storage::exists($form->file_path), 404);

        return response()->file(Storage::path($form->file_path));
    }

    /** {{tags}} found in a Word/Excel template. */
    public function tags(CustodyForm $form)
    {
        abort_unless($form->usesTags() && Storage::exists($form->file_path), 404);

        return [
            'found' => CustodyFormData::tagsIn(Storage::path($form->file_path), $form->kind),
            'builtin' => CustodyFormData::TAGS,
        ];
    }

    /** Everything that can be printed for one custody (hand-over). */
    public function data(Custody $custody)
    {
        return CustodyFormData::for($custody);
    }

    /** Word/Excel template filled for one custody, ready to open and print. */
    public function fill(CustodyForm $form, Custody $custody)
    {
        abort_unless($form->usesTags() && Storage::exists($form->file_path), 404);
        $data = CustodyFormData::for($custody);
        $path = CustodyFormData::fill(Storage::path($form->file_path), $form->kind, $data);
        $name = 'عهدة-'.preg_replace('#[\\\\/:*?"<>|]+#', '-', (string) $data['serial_number']).'.'.$form->kind;

        return response()->download($path, $name)->deleteFileAfterSend();
    }
}
