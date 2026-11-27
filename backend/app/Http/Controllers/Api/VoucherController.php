<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\Custody;
use App\Models\Equipment;
use App\Models\EquipmentField;
use App\Models\Setting;
use App\Models\Voucher;
use App\Models\VoucherItem;
use App\Models\VoucherPrint;
use App\Models\VoucherTemplate;
use App\Support\PinConfirmation;
use App\Support\PrintStation;
use App\Support\VoucherRows;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * Issue vouchers (سند صرف عهدة): scan the equipment someone takes (from a phone or the computer),
 * issue the voucher to hand it all over as custody, take it back by scanning again.
 * A draft lives on the server, so several devices can fill the same voucher.
 */
class VoucherController extends Controller
{
    private const STATUSES = [Voucher::DRAFT, Voucher::ISSUED, Voucher::RETURNED];

    /** Most copies one print can ask for. */
    private const MAX_COPIES = 20;

    public function index(Request $request)
    {
        $status = $request->query('status');
        $q = trim((string) $request->query('q', ''));

        $vouchers = Voucher::with(['creator:id,name', 'issuer:id,name', 'replaces:id,number'])
            ->withCount(['items', 'items as held_count' => fn ($query) => $query->whereHas('custody', fn ($c) => $c->whereNull('returned_at'))])
            ->when(in_array($status, self::STATUSES, true), fn ($query) => $query->where('status', $status))
            ->when($q !== '', fn ($query) => $query->where(fn ($w) => $w
                ->where('recipient', 'like', '%'.str_replace(['%', '_'], ['\%', '\_'], $q).'%')
                ->when(ctype_digit($q), fn ($n) => $n->orWhere('number', (int) $q))))
            ->orderByRaw("case when status = 'draft' then 0 else 1 end")
            ->orderByDesc('number')
            ->orderByDesc('id')
            ->limit(300)
            ->get();

        return [
            'vouchers' => $vouchers,
            'counts' => Voucher::selectRaw('status, count(*) as n')->groupBy('status')->pluck('n', 'status'),
            'next_number' => Voucher::nextNumber(),
        ];
    }

    /** A new, empty draft; the template's fields start with what was typed on the last voucher. */
    public function store(Request $request)
    {
        $data = $request->validate(['recipient' => ['nullable', 'string', 'max:191']]);
        $voucher = Voucher::create([
            'status' => Voucher::DRAFT,
            'recipient' => self::clean($data['recipient'] ?? null),
            'fields' => self::lastFields() ?: null,
            'created_by' => $request->user()->id,
        ]);

        return $this->payload($voucher);
    }

    public function show(Voucher $voucher)
    {
        return $this->payload($voucher);
    }

    /** Asked every second or two by open screens, to show what another device scanned. */
    public function revision(Voucher $voucher): array
    {
        return ['revision' => $voucher->revision];
    }

    /** Names used before (vouchers and custody), for suggestions. */
    public function recipients()
    {
        return Voucher::whereNotNull('recipient')->distinct()->pluck('recipient')
            ->merge(Custody::distinct()->pluck('holder'))
            ->map(fn ($name) => trim((string) $name))
            ->filter()
            ->unique()
            ->sort()
            ->take(500)
            ->values();
    }

    /** The recipient, the template and the template's fields, while it is a draft. */
    public function update(Request $request, Voucher $voucher)
    {
        self::mustBeDraft($voucher);
        $data = $request->validate([
            'recipient' => ['sometimes', 'nullable', 'string', 'max:191'],
            'template_id' => ['sometimes', 'nullable', 'integer', 'exists:voucher_templates,id'],
            'fields' => ['sometimes', 'nullable', 'array', 'max:50'],
            'fields.*' => ['nullable', 'string', 'max:500'],
        ]);

        if (array_key_exists('recipient', $data)) {
            $voucher->recipient = self::clean($data['recipient']);
        }
        if (array_key_exists('template_id', $data)) {
            $voucher->template_id = $data['template_id'];
        }
        if (array_key_exists('fields', $data)) {
            $voucher->fields = array_map(fn ($value) => self::clean($value), $data['fields']);
        }
        $voucher->revision++;
        $voucher->save();

        return $this->payload($voucher);
    }

    /**
     * A draft is deleted at once; an issued or returned voucher needs the PIN again. What is still
     * out is cancelled as if the voucher was never issued; what came back stays in each
     * equipment's custody history.
     */
    public function destroy(Request $request, Voucher $voucher)
    {
        if (! $voucher->isDraft()) {
            PinConfirmation::check($request);
        }
        DB::transaction(function () use ($voucher, $request) {
            // A correction being prepared for this voucher goes with it
            Voucher::where('replaces_id', $voucher->id)->where('status', Voucher::DRAFT)->delete();
            $this->discard($voucher, $request->user()->id);
        });

        return response()->noContent();
    }

    /**
     * An issued voucher cannot be changed: a correction starts as a draft with the same recipient,
     * fields and the units still out on it (what came back or went to another voucher is left
     * out, so it is not handed over again). Issuing it deletes this voucher and takes its number.
     */
    public function replace(Request $request, Voucher $voucher)
    {
        if ($voucher->isDraft()) {
            throw ValidationException::withMessages(['voucher' => 'voucher_not_issued']);
        }
        $draft = Voucher::where('replaces_id', $voucher->id)->where('status', Voucher::DRAFT)->first();
        if (! $draft) {
            $out = $voucher->custodies()->open()->orderBy('id')->pluck('equipment_id');
            if ($out->isEmpty()) {
                throw ValidationException::withMessages(['voucher' => 'voucher_nothing_out']);
            }
            $userId = $request->user()->id;
            $draft = DB::transaction(function () use ($voucher, $out, $userId) {
                $draft = Voucher::create([
                    'status' => Voucher::DRAFT,
                    'recipient' => $voucher->recipient,
                    'fields' => $voucher->fields,
                    'template_id' => VoucherTemplate::whereKey($voucher->layout['template_id'] ?? $voucher->template_id)->value('id'),
                    'replaces_id' => $voucher->id,
                    'created_by' => $userId,
                ]);
                foreach ($out as $equipmentId) {
                    $draft->items()->create(['equipment_id' => $equipmentId, 'added_by' => $userId]);
                }
                $voucher->increment('revision');

                return $draft;
            });
        }

        return $this->payload($draft);
    }

    /**
     * Adds a scanned code (`code`) or chosen equipment (`equipment_ids`, e.g. accessories picked
     * under their main equipment). Equipment someone else holds is only added with `move`: the
     * answer is `held` with who holds it, so the screen can ask first.
     */
    public function addItems(Request $request, Voucher $voucher)
    {
        self::mustBeDraft($voucher);
        $data = $request->validate([
            'code' => ['required_without:equipment_ids', 'nullable', 'string', 'max:500'],
            'equipment_ids' => ['required_without:code', 'array', 'max:500'],
            'equipment_ids.*' => ['integer'],
            'move' => ['boolean'],
        ]);

        $equipment = isset($data['code'])
            ? collect([self::findByCode($data['code'])])
            : Equipment::with(['fields', 'group', 'parent.fields', 'parent.group'])->whereIn('id', $data['equipment_ids'])->get();

        $inVoucher = $voucher->items()->pluck('equipment_id')->flip();
        $new = $equipment->reject(fn (Equipment $e) => $inVoucher->has($e->id))->values();
        if ($new->isEmpty()) {
            return ['status' => 'already', 'equipment' => $equipment->map(fn (Equipment $e) => self::brief($e))->values()] + $this->payload($voucher);
        }

        $held = $this->heldElsewhere($voucher, $new->pluck('id'));
        if ($held->isNotEmpty() && ! ($data['move'] ?? false)) {
            return ['status' => 'held', 'held' => $this->heldList($held, $new)] + $this->payload($voucher);
        }

        $userId = $request->user()->id;
        $added = DB::transaction(function () use ($voucher, $new, $userId) {
            $items = $new->map(fn (Equipment $e) => $voucher->items()->create(['equipment_id' => $e->id, 'added_by' => $userId]));
            $voucher->syncStatus();

            return $items;
        });

        return ['status' => 'added', 'added' => $added->pluck('id'), 'equipment' => $new->map(fn (Equipment $e) => self::brief($e))->values()] + $this->payload($voucher);
    }

    /** Takes a unit off a draft. */
    public function removeItem(Voucher $voucher, VoucherItem $item)
    {
        abort_unless($item->voucher_id === $voucher->id, 404);
        self::mustBeDraft($voucher);

        $item->delete();
        $voucher->syncStatus();

        return $this->payload($voucher);
    }

    /**
     * Numbers the draft, hands every unit over to the recipient and sends `copies` prints to the
     * print station. The template is kept with the voucher as it is now.
     */
    public function issue(Request $request, Voucher $voucher)
    {
        $data = $request->validate([
            'recipient' => ['nullable', 'string', 'max:191'],
            'move' => ['boolean'],
            'copies' => ['nullable', 'integer', 'min:0', 'max:'.self::MAX_COPIES],
        ]);
        if (! $voucher->isDraft()) {
            throw ValidationException::withMessages(['voucher' => 'voucher_not_draft']);
        }
        $recipient = self::clean($data['recipient'] ?? null) ?? $voucher->recipient;
        if (! $recipient) {
            throw ValidationException::withMessages(['recipient' => 'voucher_no_recipient']);
        }
        $items = $voucher->items()->with('equipment')->get();
        if ($items->isEmpty()) {
            throw ValidationException::withMessages(['voucher' => 'voucher_empty']);
        }

        // Handed to someone else since it was scanned: ask again
        $held = $this->heldElsewhere($voucher, $items->pluck('equipment_id'));
        if ($held->isNotEmpty() && ! ($data['move'] ?? false)) {
            return ['status' => 'held', 'held' => $this->heldList($held, $items->pluck('equipment'))] + $this->payload($voucher);
        }

        $userId = $request->user()->id;
        $copies = (int) ($data['copies'] ?? 1);
        $template = VoucherTemplate::current($voucher->template_id);
        $print = DB::transaction(function () use ($voucher, $items, $recipient, $userId, $copies, $template) {
            // A correction takes the place (and the number) of the voucher it corrects
            $replaced = $voucher->replaces()->lockForUpdate()->first();
            $number = $replaced?->number;
            if ($replaced) {
                $this->discard($replaced, $userId, $items->pluck('equipment_id'));
            }
            $voucher->update([
                'number' => $number ?? Voucher::nextNumber(),
                'replaces_id' => null,
                'status' => Voucher::ISSUED,
                'recipient' => $recipient,
                'template_id' => $template->id,
                'layout' => $template->layout(),
                'issued_at' => now(),
                'issued_by' => $userId,
            ]);
            $this->handOver($voucher, $items, $userId);
            $voucher->syncStatus();
            self::rememberFields($voucher->fields ?? []);

            return $this->queuePrint($voucher, $copies, $userId);
        });

        return ['status' => 'issued', 'print' => $this->printState($print)] + $this->payload($voucher);
    }

    /** Prints an issued voucher again, as it was printed the first time. */
    public function print(Request $request, Voucher $voucher)
    {
        $data = $request->validate(['copies' => ['required', 'integer', 'min:1', 'max:'.self::MAX_COPIES]]);
        if ($voucher->isDraft()) {
            throw ValidationException::withMessages(['voucher' => 'voucher_not_issued']);
        }
        $print = $this->queuePrint($voucher, (int) $data['copies'], $request->user()->id);
        $voucher->increment('revision');

        return ['print' => $this->printState($print)] + $this->payload($voucher);
    }

    /** Return by scanning, inside one voucher. */
    public function returnItem(Request $request, Voucher $voucher)
    {
        $data = $request->validate(['code' => ['required', 'string', 'max:500']]);
        if ($voucher->isDraft()) {
            throw ValidationException::withMessages(['code' => 'voucher_not_issued']);
        }
        $equipment = self::findByCode($data['code']);
        $item = $voucher->items()->with('custody')->where('equipment_id', $equipment->id)->first();
        if (! $item) {
            return ['status' => 'not_in_voucher', 'equipment' => self::brief($equipment), 'holder' => $this->holderOf($equipment)] + $this->payload($voucher);
        }
        if (! $item->custody || $item->custody->returned_at) {
            return ['status' => 'already', 'equipment' => self::brief($equipment)] + $this->payload($voucher);
        }

        $this->takeBack($item->custody, $equipment, $request->user()->id);

        return ['status' => 'returned', 'equipment' => self::brief($equipment)] + $this->payload($voucher->refresh());
    }

    /** Everything still out on the voucher comes back at once (with the PIN again). */
    public function returnAll(Request $request, Voucher $voucher)
    {
        if ($voucher->isDraft()) {
            throw ValidationException::withMessages(['voucher' => 'voucher_not_issued']);
        }
        PinConfirmation::check($request);
        $open = $voucher->custodies()->open()->with('equipment')->get();
        if ($open->isEmpty()) {
            throw ValidationException::withMessages(['voucher' => 'voucher_nothing_out']);
        }

        $userId = $request->user()->id;
        DB::transaction(function () use ($voucher, $open, $userId) {
            $now = now();
            foreach ($open as $custody) {
                // Quietly: the voucher is brought up to date once, below
                $custody->updateQuietly(['returned_at' => $now, 'received_by' => $userId, 'return_notes' => "إرجاع كامل لسند الصرف رقم {$voucher->number}"]);
                if ($custody->equipment) {
                    ActivityLog::record($custody->equipment, 'custody_in', ['summary' => self::summary($custody->holder, $voucher)], $userId);
                }
            }
            $voucher->syncStatus();
        });

        return ['status' => 'returned', 'returned' => $open->count()] + $this->payload($voucher->refresh());
    }

    /** Return by scanning from anywhere: the custody of the scanned equipment ends, whichever voucher it was on. */
    public function returnAny(Request $request)
    {
        $data = $request->validate(['code' => ['required', 'string', 'max:500']]);
        $equipment = self::findByCode($data['code']);
        $custody = Custody::open()->with('voucher')->where('equipment_id', $equipment->id)->latest('handed_at')->latest('id')->first();
        if (! $custody) {
            return ['status' => 'not_held', 'equipment' => self::brief($equipment)];
        }

        $this->takeBack($custody, $equipment, $request->user()->id);
        $voucher = $custody->voucher?->refresh();

        return [
            'status' => 'returned',
            'equipment' => self::brief($equipment),
            'holder' => $custody->holder,
            'voucher' => $voucher ? [
                'id' => $voucher->id,
                'number' => $voucher->number,
                'recipient' => $voucher->recipient,
                'status' => $voucher->status,
                'items_count' => $voucher->items()->count(),
                'held_count' => $voucher->items()->whereHas('custody', fn ($c) => $c->whereNull('returned_at'))->count(),
            ] : null,
        ];
    }

    /** Where numbering starts; it never goes back to a number already given. */
    public function setNextNumber(Request $request)
    {
        $data = $request->validate(['number' => ['required', 'integer', 'min:1', 'max:99999999']]);
        if ($data['number'] <= (int) Voucher::max('number')) {
            throw ValidationException::withMessages(['number' => 'voucher_number_used']);
        }
        Setting::updateOrCreate(['key' => 'voucher_next_number'], ['value' => (string) $data['number']]);

        return ['next_number' => Voucher::nextNumber()];
    }

    /**
     * The equipment a scanned code means: a system label (…/eq/<serial>) or a serial number,
     * else a maker's code saved in a field of exactly one equipment.
     */
    public static function findByCode(string $code): Equipment
    {
        $serial = StocktakeController::serialFromCode($code);
        $equipment = Equipment::forSerial($serial)->first();
        if (! $equipment && $serial !== '') {
            $ids = EquipmentField::where('value', $serial)->distinct()->limit(2)->pluck('equipment_id');
            if ($ids->count() > 1) {
                throw ValidationException::withMessages(['code' => 'voucher_code_many']);
            }
            $equipment = $ids->isNotEmpty() ? Equipment::find($ids->first()) : null;
        }
        if (! $equipment) {
            throw ValidationException::withMessages(['code' => 'voucher_unknown_code']);
        }

        return $equipment->load(['fields', 'group', 'parent.fields', 'parent.group']);
    }

    /**
     * Custody for each unit; a unit someone else holds is taken back from them first.
     *
     * @param  Collection<int, VoucherItem>  $items
     */
    private function handOver(Voucher $voucher, Collection $items, int $userId): void
    {
        $now = now();
        $previous = Custody::open()->whereIn('equipment_id', $items->pluck('equipment_id'))->get()->groupBy('equipment_id');
        foreach ($items as $item) {
            foreach ($previous[$item->equipment_id] ?? [] as $old) {
                $old->update(['returned_at' => $now, 'return_notes' => "نُقلت إلى سند الصرف رقم {$voucher->number}", 'received_by' => $userId]);
                ActivityLog::record($item->equipment, 'custody_in', ['summary' => trim($old->holder.' → '.$voucher->recipient)], $userId);
            }
            $custody = Custody::create([
                'equipment_id' => $item->equipment_id,
                'voucher_id' => $voucher->id,
                'holder' => $voucher->recipient,
                'handed_at' => $now,
                'handed_by' => $userId,
            ]);
            $item->update(['custody_id' => $custody->id]);
            ActivityLog::record($item->equipment, 'custody_out', ['summary' => self::summary($voucher->recipient, $voucher)], $userId);
        }
    }

    /**
     * Deletes a voucher. Its custody still open is cancelled, as if the voucher was never issued:
     * a unit it had taken from someone goes back to them, unless the correction (`$carried`)
     * hands it over again.
     *
     * @param  Collection<int, int>|null  $carried
     */
    private function discard(Voucher $voucher, int $userId, ?Collection $carried = null): void
    {
        $carried = ($carried ?? collect())->flip();
        foreach ($voucher->custodies()->open()->with('equipment')->get() as $custody) {
            if ($custody->equipment) {
                ActivityLog::record($custody->equipment, 'custody_in', ['summary' => "إلغاء سند الصرف رقم {$voucher->number} · {$custody->holder}"], $userId);
            }
            $custody->delete();
            if ($carried->has($custody->equipment_id)) {
                continue;
            }
            $before = Custody::where('equipment_id', $custody->equipment_id)
                ->where('returned_at', $custody->handed_at)
                ->where('return_notes', "نُقلت إلى سند الصرف رقم {$voucher->number}")
                ->latest('id')
                ->first();
            if ($before && ! Custody::open()->where('equipment_id', $custody->equipment_id)->exists()) {
                $before->update(['returned_at' => null, 'return_notes' => null, 'received_by' => null]);
                if ($custody->equipment) {
                    ActivityLog::record($custody->equipment, 'custody_out', ['summary' => "{$before->holder} · عادت بعد إلغاء سند الصرف رقم {$voucher->number}"], $userId);
                }
            }
        }
        $voucher->delete();
    }

    private static function mustBeDraft(Voucher $voucher): void
    {
        if (! $voucher->isDraft()) {
            throw ValidationException::withMessages(['voucher' => 'voucher_locked']);
        }
    }

    private function takeBack(Custody $custody, Equipment $equipment, int $userId): void
    {
        DB::transaction(function () use ($custody, $equipment, $userId) {
            $custody->update(['returned_at' => now(), 'received_by' => $userId]);
            ActivityLog::record($equipment, 'custody_in', ['summary' => $custody->voucher ? self::summary($custody->holder, $custody->voucher) : $custody->holder], $userId);
        });
    }

    /**
     * Open custody of these equipment that is not this voucher's own.
     *
     * @param  Collection<int, int>  $equipmentIds
     * @return Collection<int, Custody>
     */
    private function heldElsewhere(Voucher $voucher, Collection $equipmentIds): Collection
    {
        $own = array_values(array_filter([$voucher->id, $voucher->replaces_id]));

        return Custody::open()->with('voucher:id,number')
            ->whereIn('equipment_id', $equipmentIds)
            ->where(fn ($q) => $q->whereNull('voucher_id')->orWhereNotIn('voucher_id', $own))
            ->get();
    }

    /**
     * @param  Collection<int, Custody>  $held
     * @param  Collection<int, Equipment>  $equipment
     * @return array<int, array<string, mixed>>
     */
    private function heldList(Collection $held, Collection $equipment): array
    {
        $byId = $equipment->keyBy('id');

        return $held->map(fn (Custody $c) => self::brief($byId[$c->equipment_id]) + ['holder' => $c->holder, 'voucher_number' => $c->voucher?->number])->values()->all();
    }

    /**
     * Units that left this voucher because another voucher took them: that voucher's number, by item.
     * handOver() ends the old custody at the very time the new one starts.
     *
     * @param  Collection<int, VoucherItem>  $items
     * @return Collection<int, int>
     */
    private function movedTo(Voucher $voucher, Collection $items): Collection
    {
        $ended = $items->filter(fn (VoucherItem $i) => $i->custody?->returned_at);
        if ($ended->isEmpty()) {
            return collect();
        }
        $next = Custody::with('voucher:id,number')
            ->whereIn('equipment_id', $ended->pluck('equipment_id'))
            ->whereNotNull('voucher_id')
            ->where('voucher_id', '!=', $voucher->id)
            ->whereIn('handed_at', $ended->map(fn (VoucherItem $i) => $i->custody->returned_at)->unique()->values())
            ->get()
            ->keyBy(fn (Custody $c) => $c->equipment_id.'|'.$c->handed_at->toDateTimeString());

        return $ended->mapWithKeys(fn (VoucherItem $i) => [$i->id => $next->get($i->equipment_id.'|'.$i->custody->returned_at->toDateTimeString())?->voucher?->number])->filter();
    }

    /** @return ?array{holder: string, voucher_number: ?int} */
    private function holderOf(Equipment $equipment): ?array
    {
        $custody = Custody::open()->with('voucher:id,number')->where('equipment_id', $equipment->id)->first();

        return $custody ? ['holder' => $custody->holder, 'voucher_number' => $custody->voucher?->number] : null;
    }

    /** @return array{id: int, serial_number: ?string, display_name: string, parent_serial: ?string} */
    private static function brief(Equipment $equipment): array
    {
        return [
            'id' => $equipment->id,
            'serial_number' => $equipment->serial_number,
            'display_name' => VoucherRows::name($equipment),
            'parent_serial' => $equipment->parent?->serial_number,
        ];
    }

    private static function summary(?string $holder, Voucher $voucher): string
    {
        return trim($holder.' · سند '.$voucher->number);
    }

    private static function clean(?string $text): ?string
    {
        return trim(preg_replace('/\s+/u', ' ', (string) $text)) ?: null;
    }

    private function queuePrint(Voucher $voucher, int $copies, int $userId): ?VoucherPrint
    {
        Setting::updateOrCreate(['key' => 'voucher_last_copies'], ['value' => (string) $copies]);
        if ($copies < 1) {
            return null;
        }

        return $voucher->prints()->create(['copies' => $copies, 'status' => VoucherPrint::PENDING, 'requested_by' => $userId]);
    }

    /** @return array{job: ?array<string, mixed>, station: array{online: bool, seen_at: ?int}} */
    private function printState(?VoucherPrint $print): array
    {
        return ['job' => $print?->brief(), 'station' => PrintStation::state()];
    }

    /** What was typed in each field last time, offered on the next voucher. */
    private static function lastFields(): array
    {
        return json_decode((string) Setting::get('voucher_last_fields'), true) ?: [];
    }

    private static function rememberFields(array $fields): void
    {
        $typed = array_filter($fields, fn ($value) => is_string($value) && $value !== '');
        if ($typed) {
            Setting::updateOrCreate(['key' => 'voucher_last_fields'], ['value' => json_encode($typed + self::lastFields(), JSON_UNESCAPED_UNICODE)]);
        }
    }

    /** The voucher, its scanned units (in scan order) and its lines. */
    private function payload(Voucher $voucher): array
    {
        $voucher->load([
            'creator:id,name',
            'issuer:id,name',
            'items.custody',
            'items.equipment' => fn ($q) => $q->with(['fields', 'group', 'parent' => fn ($p) => $p->withTrashed()->with(['fields', 'group']), 'accessories.fields']),
        ]);
        $items = $voucher->items;
        $held = $voucher->isDraft() ? $this->heldElsewhere($voucher, $items->pluck('equipment_id'))->keyBy('equipment_id') : collect();
        $movedTo = $this->movedTo($voucher, $items);

        return [
            'voucher' => $voucher->only(['id', 'number', 'status', 'recipient', 'fields', 'template_id', 'revision', 'issued_at', 'returned_at', 'created_at']) + [
                'creator' => $voucher->creator?->only(['id', 'name']),
                'issuer' => $voucher->issuer?->only(['id', 'name']),
                'replaces' => $voucher->replaces?->only(['id', 'number']),
                'replacement_id' => $voucher->isDraft() ? null : Voucher::where('replaces_id', $voucher->id)->value('id'),
                'last_print' => $voucher->prints()->latest('id')->first()?->brief(),
            ],
            'layout' => $voucher->printLayout(),
            'copies' => max(1, (int) Setting::get('voucher_last_copies')),
            'items' => $items->filter(fn (VoucherItem $i) => $i->equipment)->map(function (VoucherItem $item) use ($held, $movedTo) {
                $e = $item->equipment;
                $holder = $held[$e->id] ?? null;

                return [
                    'id' => $item->id,
                    'row_key' => VoucherRows::key($e),
                    'equipment' => self::brief($e) + ['deleted' => $e->trashed()],
                    'accessories' => $e->parent_id === null
                        ? $e->accessories->map(fn (Equipment $a) => ['id' => $a->id, 'serial_number' => $a->serial_number, 'display_name' => VoucherRows::name($a)])->values()
                        : [],
                    'returned_at' => $item->custody?->returned_at,
                    'return_notes' => $item->custody?->return_notes,
                    'moved_to' => $movedTo[$item->id] ?? null,
                    'held_by' => $holder ? ['holder' => $holder->holder, 'voucher_number' => $holder->voucher?->number] : null,
                    'added_at' => $item->created_at,
                ];
            })->values(),
            'rows' => VoucherRows::for($items),
        ];
    }
}
