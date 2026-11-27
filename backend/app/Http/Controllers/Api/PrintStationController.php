<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Voucher;
use App\Models\VoucherPrint;
use App\Support\PrintStation;
use App\Support\VoucherRows;
use Illuminate\Http\Request;

/**
 * The print station on the laptop asks here for vouchers to print (with its key, no PIN) and says
 * when each one was printed or cancelled. Phones ask whether it is open, and can have it opened.
 */
class PrintStationController extends Controller
{
    /** Is the station open? (asked by phones before and after issuing) */
    public function status(): array
    {
        return PrintStation::state() + ['pending' => VoucherPrint::where('status', VoucherPrint::PENDING)->count()];
    }

    /** Asks START.bat to open the station on the laptop; the phone then waits for it to answer. */
    public function open(): array
    {
        if (PrintStation::online()) {
            return ['requested' => false] + PrintStation::state();
        }
        PrintStation::requestOpen();

        return ['requested' => true] + PrintStation::state();
    }

    /** The oldest print waiting, with everything the station needs to lay it out. */
    public function next(Request $request): array
    {
        $this->station($request);
        $window = (string) $request->query('window', '');
        if (! PrintStation::seen(substr($window, 0, 64))) {
            return ['job' => null, 'duplicate' => true];
        }

        $print = VoucherPrint::where('status', VoucherPrint::PENDING)
            ->whereHas('voucher', fn ($q) => $q->where('status', '!=', Voucher::DRAFT))
            ->orderBy('id')
            ->first();
        if (! $print) {
            return ['job' => null];
        }

        $voucher = $print->voucher->load([
            'items.custody',
            'items.equipment' => fn ($q) => $q->with(['fields', 'group', 'parent' => fn ($p) => $p->withTrashed()->with(['fields', 'group'])]),
        ]);

        return ['job' => $print->brief() + [
            'voucher' => $voucher->only(['id', 'number', 'recipient', 'fields', 'issued_at']),
            'rows' => VoucherRows::for($voucher->items),
            'layout' => $voucher->printLayout(),
            'waiting' => VoucherPrint::where('status', VoucherPrint::PENDING)->count(),
        ]];
    }

    public function printed(Request $request, VoucherPrint $print): array
    {
        return $this->finish($request, $print, VoucherPrint::PRINTED);
    }

    public function cancel(Request $request, VoucherPrint $print): array
    {
        return $this->finish($request, $print, VoucherPrint::CANCELLED);
    }

    private function finish(Request $request, VoucherPrint $print, string $status): array
    {
        $this->station($request);
        if ($print->status === VoucherPrint::PENDING) {
            $print->update(['status' => $status, 'finished_at' => now()]);
            $print->voucher?->increment('revision'); // the phone shows "printed" / "cancelled"
        }

        return ['print' => $print->brief()];
    }

    private function station(Request $request): void
    {
        abort_unless(PrintStation::checks($request->header('X-Station-Key') ?? $request->query('key')), 403);
    }
}
