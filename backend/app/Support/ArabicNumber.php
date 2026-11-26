<?php

namespace App\Support;

/** Numbers written in Arabic words, as on a voucher's «كتابة» column: 2 → «اثنان». */
class ArabicNumber
{
    private const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة'];

    private const TENS = ['', 'عشرة', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];

    private const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

    public static function words(int $n): string
    {
        if ($n <= 0) {
            return 'صفر';
        }
        if ($n >= 1000000) {
            return (string) $n;
        }

        $thousands = intdiv($n, 1000);
        $rest = $n % 1000;
        $parts = [];
        if ($thousands > 0) {
            $parts[] = match (true) {
                $thousands === 1 => 'ألف',
                $thousands === 2 => 'ألفان',
                $thousands <= 10 => self::belowThousand($thousands).' آلاف',
                default => self::belowThousand($thousands).' ألف',
            };
        }
        if ($rest > 0) {
            $parts[] = self::belowThousand($rest);
        }

        return implode(' و', $parts);
    }

    /** 1 → «١», for printing digits the way the paper does. */
    public static function digits(int|string $value): string
    {
        return strtr((string) $value, ['0' => '٠', '1' => '١', '2' => '٢', '3' => '٣', '4' => '٤', '5' => '٥', '6' => '٦', '7' => '٧', '8' => '٨', '9' => '٩']);
    }

    private static function belowThousand(int $n): string
    {
        $parts = [];
        if ($n >= 100) {
            $parts[] = self::HUNDREDS[intdiv($n, 100)];
            $n %= 100;
        }
        if ($n > 0) {
            $parts[] = self::belowHundred($n);
        }

        return implode(' و', $parts);
    }

    private static function belowHundred(int $n): string
    {
        return match (true) {
            $n < 10 => self::ONES[$n],
            $n === 10 => 'عشرة',
            $n === 11 => 'أحد عشر',
            $n === 12 => 'اثنا عشر',
            $n < 20 => self::ONES[$n - 10].' عشر',
            $n % 10 === 0 => self::TENS[intdiv($n, 10)],
            default => self::ONES[$n % 10].' و'.self::TENS[intdiv($n, 10)],
        };
    }
}
