<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ActivityLog;
use App\Models\Equipment;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/** One photo per equipment: everyone can see it, adding or removing it needs a PIN. */
class EquipmentPhotoController extends Controller
{
    public function show(Equipment $equipment)
    {
        abort_unless($equipment->photo_path && Storage::exists($equipment->photo_path), 404);

        // The URL changes with every new photo (see Equipment::photoUrl), so it can be cached
        return response()->file(Storage::path($equipment->photo_path), ['Cache-Control' => 'public, max-age=31536000']);
    }

    public function store(Request $request, Equipment $equipment)
    {
        $request->validate([
            'photo' => ['required', 'file', 'max:12288', 'mimes:jpg,jpeg,png,webp,heic,heif'],
        ]);

        $file = $request->file('photo');
        $path = $file->storeAs('equipment_photos', Str::uuid().'.'.strtolower($file->getClientOriginalExtension() ?: 'jpg'));

        $old = $equipment->photo_path;
        $equipment->update(['photo_path' => $path, 'updated_by' => $request->user()->id]);
        if ($old) {
            Storage::delete($old);
        }
        ActivityLog::record($equipment, 'photo_changed');

        return ['photo_url' => $equipment->photoUrl()];
    }

    public function destroy(Request $request, Equipment $equipment)
    {
        if ($equipment->photo_path) {
            Storage::delete($equipment->photo_path);
            $equipment->update(['photo_path' => null, 'updated_by' => $request->user()->id]);
            ActivityLog::record($equipment, 'photo_removed');
        }

        return ['photo_url' => null];
    }
}
