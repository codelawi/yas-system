<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\Equipment;
use App\Models\IssueReport;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/** Problems reported by anyone who scans a label (no PIN), closed by someone with a PIN. */
class IssueController extends Controller
{
    public function equipmentIndex(Equipment $equipment)
    {
        return $equipment->issues()->with('closedBy:id,name')->limit(30)->get();
    }

    /** Open reports across all equipment. */
    public function index()
    {
        return IssueReport::with('equipment:id,serial_number,name')->whereHas('equipment')->where('status', 'open')->latest('id')->limit(100)->get();
    }

    public function store(Request $request, Equipment $equipment)
    {
        $data = $request->validate([
            'description' => ['required', 'string', 'max:2000'],
            'reporter' => ['nullable', 'string', 'max:100'],
            'photo' => ['nullable', 'file', 'max:12288', 'mimes:jpg,jpeg,png,webp,heic,heif'],
        ]);

        $path = null;
        if ($request->hasFile('photo')) {
            $path = $request->file('photo')->storeAs('issues', Str::uuid().'.'.strtolower($request->file('photo')->getClientOriginalExtension() ?: 'jpg'));
        }

        $issue = $equipment->issues()->create([
            'description' => $data['description'],
            'reporter' => $data['reporter'] ?? null,
            'photo_path' => $path,
            'ip' => $request->ip(),
        ]);
        ActivityLog::record($equipment, 'issue_reported', ['summary' => trim(($data['reporter'] ?? '').': '.$data['description'], ': ')], $request->user('sanctum')?->id);

        return $issue;
    }

    public function photo(IssueReport $issue)
    {
        abort_unless($issue->photo_path && Storage::exists($issue->photo_path), 404);

        return response()->file(Storage::path($issue->photo_path));
    }

    public function close(Request $request, IssueReport $issue)
    {
        $data = $request->validate(['resolution' => ['nullable', 'string', 'max:2000']]);
        if ($issue->status !== 'open') {
            throw ValidationException::withMessages(['resolution' => 'already_closed']);
        }

        $issue->update(['status' => 'closed', 'resolution' => $data['resolution'] ?? null, 'closed_by' => $request->user()->id, 'closed_at' => now()]);
        ActivityLog::record($issue->equipment, 'issue_closed', ['summary' => trim($issue->description.' → '.($data['resolution'] ?? ''), ' →')]);

        return $issue->load('closedBy:id,name');
    }
}
