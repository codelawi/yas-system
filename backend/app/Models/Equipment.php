<?php

namespace App\Models;

use App\Http\Controllers\Api\EquipmentController;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

class Equipment extends Model
{
    use SoftDeletes;

    protected $table = 'equipment';

    protected $fillable = ['parent_id', 'group_id', 'serial_number', 'name', 'row_no', 'category', 'photo_path', 'import_id', 'created_by', 'updated_by'];

    protected $hidden = ['photo_path'];

    /** What to load on a model's `equipment` relation for withDisplayName(). */
    public const NAME_RELATIONS = ['equipment:id,serial_number,name,group_id', 'equipment.fields', 'equipment.group:id,name'];

    /** @return Attribute<?string, never> */
    protected function displayName(): Attribute
    {
        return Attribute::get(fn () => EquipmentController::displayName($this));
    }

    /** Sends display_name in this equipment's JSON, without the relations it was worked out from. */
    public function withDisplayName(): static
    {
        return $this->append('display_name')->makeHidden(['fields', 'group']);
    }

    public function fields(): HasMany
    {
        return $this->hasMany(EquipmentField::class)->orderBy('sort_order');
    }

    public function parent(): BelongsTo
    {
        return $this->belongsTo(self::class, 'parent_id');
    }

    public function accessories(): HasMany
    {
        return $this->hasMany(self::class, 'parent_id')->orderBy('name')->orderBy('serial_number');
    }

    public function schedules(): HasMany
    {
        return $this->hasMany(MaintenanceSchedule::class)->orderBy('due_date');
    }

    public function maintenanceRecords(): HasMany
    {
        return $this->hasMany(MaintenanceRecord::class)->latest('done_at')->latest('id');
    }

    public function custodies(): HasMany
    {
        return $this->hasMany(Custody::class)->latest('handed_at')->latest('id');
    }

    public function issues(): HasMany
    {
        return $this->hasMany(IssueReport::class)->latest('id');
    }

    public function group(): BelongsTo
    {
        return $this->belongsTo(EquipmentGroup::class, 'group_id');
    }

    public function boxes(): BelongsToMany
    {
        return $this->belongsToMany(Box::class)->withTimestamps()->orderBy('number');
    }

    /** Link to the equipment's photo; changes with every new photo so phones don't show a cached old one. */
    public function photoUrl(): ?string
    {
        return $this->photo_path ? '/api/equipment/'.$this->id.'/photo?v='.substr(md5($this->photo_path), 0, 8) : null;
    }

    public function isAccessory(): bool
    {
        return $this->parent_id !== null;
    }

    public function import(): BelongsTo
    {
        return $this->belongsTo(Import::class);
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    public function updater(): BelongsTo
    {
        return $this->belongsTo(User::class, 'updated_by');
    }

    public function logs(): HasMany
    {
        return $this->hasMany(ActivityLog::class)->latest('created_at');
    }

    protected $casts = ['row_no' => 'integer'];

    /** A deleted main equipment must not block its serial number from being used again. */
    public static function purgeTrashedSerial(string $serial): void
    {
        static::onlyTrashed()->whereNull('parent_id')->where('serial_number', $serial)->get()->each->forceDelete();
    }

    /** Equipment with this serial: accessories may share one, so main equipment comes first. */
    public function scopeForSerial(Builder $query, string $serial): void
    {
        $query->where('serial_number', $serial)->orderByRaw('parent_id is not null')->orderBy('id');
    }

    /** @return array<int, array{key: string, value: ?string}> */
    public function fieldList(): array
    {
        return $this->fields->map(fn ($a) => ['key' => $a->key, 'value' => $a->value])->all();
    }

    /** @param array<int, array{key: string, value: ?string}> $attributes */
    public function syncFields(array $fields): void
    {
        $this->fields()->delete();
        $rows = [];
        foreach (array_values($fields) as $i => $attr) {
            $rows[] = [
                'equipment_id' => $this->id,
                'key' => $attr['key'],
                'value' => $attr['value'] ?? null,
                'sort_order' => $i,
            ];
        }
        if ($rows) {
            EquipmentField::insert($rows);
        }
        $this->unsetRelation('fields');
    }
}
