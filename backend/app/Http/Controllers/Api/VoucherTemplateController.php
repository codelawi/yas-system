<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\VoucherTemplate;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/** The designs issue vouchers are printed with: several, one of them the default. */
class VoucherTemplateController extends Controller
{
    public function index()
    {
        VoucherTemplate::current(); // the paper voucher, the first time

        return VoucherTemplate::withCount('vouchers')->orderByDesc('is_default')->orderBy('name')->get(['id', 'name', 'is_default', 'updated_at']);
    }

    /** A new template: a copy of `from`, else of the paper voucher. */
    public function store(Request $request)
    {
        $data = $request->validate([
            'name' => ['nullable', 'string', 'max:120'],
            'from' => ['nullable', 'integer', 'exists:voucher_templates,id'],
        ]);
        $source = isset($data['from']) ? VoucherTemplate::findOrFail($data['from'])->only(['header', 'footer', 'item_table', 'fields', 'style', 'name']) : VoucherTemplate::builtIn();
        $name = trim((string) ($data['name'] ?? '')) ?: $source['name'].' (نسخة)';
        $template = VoucherTemplate::create(['name' => $name, 'is_default' => VoucherTemplate::count() === 0] + $source);

        return $template->fresh();
    }

    public function show(VoucherTemplate $template)
    {
        return $template;
    }

    public function update(Request $request, VoucherTemplate $template)
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:120'],
            'header' => ['nullable', 'string', 'max:200000'],
            'footer' => ['nullable', 'string', 'max:200000'],
            'item_table' => ['required', 'array'],
            'item_table.columns' => ['required', 'array', 'size:'.count(VoucherTemplate::COLUMNS)],
            'item_table.columns.*.key' => ['required', 'distinct', Rule::in(VoucherTemplate::COLUMNS)],
            'item_table.columns.*.title' => ['nullable', 'string', 'max:100'],
            'item_table.columns.*.width' => ['required', 'integer', 'min:3', 'max:90'],
            'item_table.columns.*.show' => ['required', 'boolean'],
            'item_table.quantity_group' => ['nullable', 'string', 'max:100'],
            'item_table.no_code' => ['nullable', 'string', 'max:50'],
            'fields' => ['present', 'array', 'max:20'],
            'fields.*.key' => ['required', 'distinct', 'regex:/^[a-z0-9_]{1,30}$/'],
            'fields.*.label' => ['required', 'string', 'max:100'],
            'style' => ['required', 'array'],
            'style.font_size' => ['required', 'integer', 'min:6', 'max:24'],
            'style.row_height' => ['required', 'integer', 'min:4', 'max:30'],
            'style.margin' => ['required', 'integer', 'min:0', 'max:30'],
        ]);
        if (! collect($data['item_table']['columns'])->contains('show', true)) {
            throw ValidationException::withMessages(['item_table' => 'voucher_template_no_columns']);
        }

        $template->update([
            'name' => trim($data['name']),
            'header' => $data['header'] ?? '',
            'footer' => $data['footer'] ?? '',
            'item_table' => [
                'columns' => collect($data['item_table']['columns'])->map(fn ($c) => [
                    'key' => $c['key'],
                    'title' => trim((string) ($c['title'] ?? '')),
                    'width' => (int) $c['width'],
                    'show' => (bool) $c['show'],
                ])->values()->all(),
                'quantity_group' => trim((string) ($data['item_table']['quantity_group'] ?? '')),
                'no_code' => trim((string) ($data['item_table']['no_code'] ?? '')),
            ],
            'fields' => collect($data['fields'])->map(fn ($f) => ['key' => $f['key'], 'label' => trim($f['label'])])->values()->all(),
            'style' => array_map('intval', array_intersect_key($data['style'], VoucherTemplate::defaultStyle())),
        ]);

        return $template;
    }

    /** The default can only go once another one takes its place. */
    public function destroy(VoucherTemplate $template)
    {
        if (VoucherTemplate::count() === 1) {
            throw ValidationException::withMessages(['template' => 'voucher_template_last']);
        }
        DB::transaction(function () use ($template) {
            $template->delete();
            if ($template->is_default) {
                VoucherTemplate::orderBy('id')->first()?->update(['is_default' => true]);
            }
        });

        return response()->noContent();
    }

    public function makeDefault(VoucherTemplate $template)
    {
        DB::transaction(function () use ($template) {
            VoucherTemplate::where('id', '!=', $template->id)->update(['is_default' => false]);
            $template->update(['is_default' => true]);
        });

        return $template;
    }
}
