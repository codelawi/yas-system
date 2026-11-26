<?php

namespace App\Models;

use App\Http\Controllers\Api\EquipmentController;
use App\Services\WordTableParser;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/** A kind of equipment (e.g. «وحدة الفتح والقص») holding every main equipment of that kind. */
class EquipmentGroup extends Model
{
    protected $fillable = ['name', 'voucher_code', 'voucher_name', 'created_by'];

    protected static function booted(): void
    {
        static::saving(fn (EquipmentGroup $group) => $group->name_key = self::keyFor($group->name));
    }

    /** The name printed on an issue voucher (سند صرف): its own voucher name, or the group name. */
    public function voucherName(): string
    {
        return trim((string) $this->voucher_name) ?: $this->name;
    }

    public function equipment(): HasMany
    {
        return $this->hasMany(Equipment::class, 'group_id');
    }

    /** The name used to match equipment and groups: «وحدة الفتح والقص» = «وحده الفتح  والقص». */
    public static function keyFor(?string $name): string
    {
        return mb_substr(WordTableParser::normalize($name), 0, 191);
    }

    /**
     * Puts a main equipment without a group in the group that has its name, if there is one.
     * Used when equipment is added by hand or imported from Word.
     */
    public static function joinByName(Equipment $equipment): void
    {
        if ($equipment->parent_id !== null || $equipment->group_id !== null) {
            return;
        }

        $key = self::keyFor(EquipmentController::displayName($equipment));
        if ($key === '') {
            return;
        }

        $group = static::where('name_key', $key)->first();
        if ($group) {
            $equipment->update(['group_id' => $group->id]);
            ActivityLog::record($equipment, 'group_changed', ['summary' => '→ '.$group->name]);
        }
    }
}
