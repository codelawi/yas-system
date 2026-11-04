<?php

namespace App\Support;

/** Builds the change set stored in the activity log. */
class FieldDiff
{
    /**
     * @param  array<int, array{key: string, value: ?string}>  $before
     * @param  array<int, array{key: string, value: ?string}>  $after
     */
    public static function make(array $before, array $after, array $extraBefore = [], array $extraAfter = []): ?array
    {
        $old = self::toMap($before);
        $new = self::toMap($after);
        $changes = ['added' => [], 'removed' => [], 'changed' => []];

        foreach ($new as $key => $value) {
            if (! array_key_exists($key, $old)) {
                $changes['added'][] = ['key' => $key, 'value' => $value];
            } elseif ((string) $old[$key] !== (string) $value) {
                $changes['changed'][] = ['key' => $key, 'from' => $old[$key], 'to' => $value];
            }
        }
        foreach ($old as $key => $value) {
            if (! array_key_exists($key, $new)) {
                $changes['removed'][] = ['key' => $key, 'value' => $value];
            }
        }
        // serial_number / category
        foreach ($extraAfter as $key => $value) {
            if ((string) ($extraBefore[$key] ?? '') !== (string) $value) {
                $changes['changed'][] = ['key' => $key, 'from' => $extraBefore[$key] ?? null, 'to' => $value, 'system' => true];
            }
        }

        return array_filter($changes) ? array_filter($changes) : null;
    }

    private static function toMap(array $fields): array
    {
        $map = [];
        foreach ($fields as $f) {
            $map[$f['key']] = $f['value'] ?? null;
        }

        return $map;
    }
}
