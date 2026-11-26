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
use App\Support\PinConfirmation;
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

    public function index(Request $request)
    {
        $status = $request->query('status');
        $q = trim((string) $request->query('q', ''));

        $vouchers = Voucher::with(['creator:id,name', 'issuer:id,name'])
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

    /** A new, empty draft. */
    public function store(Request $request)
    {
        $data = $request->validate(['recipient' => ['nullable', 'string', 'max:191']]);
        $voucher = Voucher::create([
            'status' => Voucher::DRAFT,
            'recipient' => self::clean($data['recipient'] ?? null),
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

    /** Changes the recipient; on an issued voucher, the custody of what is still held follows. */
    public function update(Request $request, Voucher $voucher)
    {
        $data = $request->validate([
            'recipient' => ['sometimes', 'nullable', 'string', 'max:191'],
            'fields' => ['sometimes', 'nullable', 'array', 'max:50'],
            'fields.*' => ['nullable', 'string', 'max:500'],
        ]);

        DB::transaction(function () use ($voucher, $data) {
            if (array_key_exists('recipient', $data)) {
                $recipient = self::clean($data['recipient']);
                if (! $recipient && ! $voucher->isDraft()) {
                    throw ValidationException::withMessages(['recipient' => 'voucher_no_recipient']);
                }
                if (! $voucher->isDraft() && $recipient !== $voucher->recipient) {
                    $voucher->custodies()->open()->update(['holder' => $recipient]);
                }
                $voucher->recipient = $recipient;
            }
            if (array_key_exists('fields', $data)) {
                $voucher->fields = $data['fields'];
            }
            $voucher->revision++;
            $voucher->save();
        });

        return $this->payload($voucher);
    }

    /**
     * A draft is deleted at once; a returned voucher needs the PIN again. One still out cannot be
     * deleted. The custody history of each equipment stays either way.
     */
    public function destroy(Request $request, Voucher $voucher)
    {
        if ($voucher->status === Voucher::ISSUED) {
            throw ValidationException::withMessages(['voucher' => 'voucher_still_out_delete']);
        }
        if ($voucher->status === Voucher::RETURNED) {
            PinConfirmation::check($request);
        }
        $voucher->delete();

        return response()->noContent();
    }

    /**
     * Adds a scanned code (`code`) or chosen equipment (`equipment_ids`, e.g. accessories picked
     * under their main equipment). Equipment someone else holds is only added with `move`: the
     * answer is `held` with who holds it, so the screen can ask first.
     */
    public function addItems(Request $request, Voucher $voucher)
    {
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
            $items = $new->map(fn (Equipment $e) => $voucher->items()->create(['equipment_id' => $e->id, 'added_by' => $userId])->setRelation('equipment', $e));
            if (! $voucher->isDraft()) {
                $this->handOver($voucher, $items, $userId);
            }
            $voucher->syncStatus();

            return $items;
        });

        return ['status' => 'added', 'added' => $added->pluck('id'), 'equipment' => $new->map(fn (Equipment $e) => self::brief($e))->values()] + $this->payload($voucher);
    }

    /** Takes a unit off the voucher; if it was handed over, its custody ends here. */
    public function removeItem(Request $request, Voucher $voucher, VoucherItem $item)
    {
        abort_unless($item->voucher_id === $voucher->id, 404);

        DB::transaction(function () use ($voucher, $item, $request) {
            $custody = $item->custody;
            if ($custody && ! $custody->returned_at) {
                $custody->update(['returned_at' => now(), 'return_notes' => "أُزيلت من سند الصرف رقم {$voucher->number}", 'received_by' => $request->user()->id]);
                ActivityLog::record($item->equipment, 'custody_in', ['summary' => self::summary($custody->holder, $voucher).' ✕']);
            }
            $item->delete();
            $voucher->refresh()->syncStatus();
        });

        return $this->payload($voucher);
    }

    /** Numbers the draft and hands every unit over to the recipient. */
    public function issue(Request $request, Voucher $voucher)
    {
        $data = $request->validate([
            'recipient' => ['nullable', 'string', 'max:191'],
            'move' => ['boolean'],
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
        DB::transaction(function () use ($voucher, $items, $recipient, $userId) {
            $voucher->update([
                'number' => Voucher::nextNumber(),
                'status' => Voucher::ISSUED,
                'recipient' => $recipient,
                'issued_at' => now(),
                'issued_by' => $userId,
            ]);
            $this->handOver($voucher, $items, $userId);
            $voucher->syncStatus();
        });

        return ['status' => 'issued'] + $this->payload($voucher);
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
        return Custody::open()->with('voucher:id,number')
            ->whereIn('equipment_id', $equipmentIds)
            ->where(fn ($q) => $q->whereNull('voucher_id')->orWhere('voucher_id', '!=', $voucher->id))
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
            'voucher' => $voucher->only(['id', 'number', 'status', 'recipient', 'fields', 'revision', 'issued_at', 'returned_at', 'created_at']) + [
                'creator' => $voucher->creator?->only(['id', 'name']),
                'issuer' => $voucher->issuer?->only(['id', 'name']),
            ],
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
