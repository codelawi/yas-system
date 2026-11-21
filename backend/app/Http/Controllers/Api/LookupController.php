<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Box;
use App\Models\Equipment;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\Request;

/**
 * Finds what a scanned code belongs to, for codes that are not the system's own labels, such
 * as a Data Matrix code printed on equipment by its maker: equipment (main or accessory) whose
 * serial number or any field is that code, or a box whose number or name is. Only when nothing
 * is exactly the code: those that contain it.
 *
 * The phone's service worker (frontend/src/sw.js) answers the same way from its saved copy, so
 * keep the two in step.
 */
class LookupController extends Controller
{
    /** At most this many equipment and this many boxes. */
    private const LIMIT = 30;

    /** Shorter codes are only looked up exactly ("contains 1" would match everything). */
    private const MIN_CONTAINS = 3;

    public function show(Request $request): array
    {
        $code = trim((string) $request->query('code', ''));
        if ($code === '') {
            return ['code' => '', 'matches' => []];
        }

        $matches = $this->find($code, true);
        if (! $matches && mb_strlen($code) >= self::MIN_CONTAINS) {
            $matches = $this->find($code, false);
        }

        return ['code' => $code, 'matches' => $matches];
    }

    /** @return array<int, array<string, mixed>> */
    private function find(string $code, bool $exact): array
    {
        $like = '%'.str_replace(['%', '_'], ['\%', '\_'], $code).'%';
        $test = fn (Builder $query, string $column) => $exact ? $query->where($column, $code) : $query->where($column, 'like', $like);

        // Main equipment before accessories, as a scanned label does
        $equipment = Equipment::with(['fields', 'group:id,name', 'parent:id,serial_number,name,category,group_id', 'parent.fields', 'parent.group:id,name'])
            ->where(fn (Builder $q) => $test($q, 'serial_number')->orWhereHas('fields', fn (Builder $f) => $test($f, 'value')))
            ->orderByRaw('parent_id is not null')
            ->orderBy('id')
            ->limit(self::LIMIT)
            ->get();
        $boxes = Box::where(fn (Builder $q) => $test($q, 'number')->orWhere(fn (Builder $n) => $test($n, 'name')))
            ->orderBy('id')
            ->limit(self::LIMIT)
            ->get();

        // Which value matched, compared as MySQL does (case and trailing spaces ignored)
        $wanted = mb_strtolower($code);
        $matches = fn (?string $value) => $value !== null && ($exact
            ? mb_strtolower(rtrim($value)) === $wanted
            : str_contains(mb_strtolower($value), $wanted));

        return [
            ...$equipment->map(function (Equipment $e) use ($matches) {
                $field = $e->fields->first(fn ($f) => $matches($f->value));

                return [
                    'type' => 'equipment',
                    'id' => $e->id,
                    'serial_number' => $e->serial_number,
                    'display_name' => EquipmentController::displayName($e),
                    'category' => $e->category,
                    'parent' => $e->parent?->only(['id', 'serial_number', 'name', 'display_name', 'category']),
                    'photo_url' => $e->photoUrl(),
                    'match' => $matches($e->serial_number) || ! $field
                        ? ['by' => 'serial', 'key' => null]
                        : ['by' => 'field', 'key' => $field->key],
                ];
            }),
            ...$boxes->map(fn (Box $b) => [
                'type' => 'box',
                'id' => $b->id,
                'number' => $b->number,
                'name' => $b->name,
                'match' => ['by' => $matches($b->number) ? 'number' : 'name', 'key' => null],
            ]),
        ];
    }
}
