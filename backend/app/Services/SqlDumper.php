<?php

namespace App\Services;

use Illuminate\Database\Connection;
use Illuminate\Support\Facades\DB;
use RuntimeException;

/**
 * Plain-PHP SQL dump and restore (no mysqldump binary needed, so it works the
 * same on Laragon, XAMPP or any MySQL / MariaDB).
 *
 * Statements are separated by a marker line, so values containing ";" or line
 * breaks are restored exactly.
 */
class SqlDumper
{
    public const SEPARATOR = '-- @@end';

    private const ROWS_PER_INSERT = 200;

    public function __construct(private ?Connection $db = null)
    {
        $this->db ??= DB::connection();
    }

    /** Writes the whole database to a file. Returns the number of tables. */
    public function dump(string $path): int
    {
        $out = fopen($path, 'wb');
        if (! $out) {
            throw new RuntimeException('cannot_write_backup');
        }

        $mysql = $this->isMysql();
        $this->write($out, '-- Equipment Repository backup '.now()->toDateTimeString());
        if ($mysql) {
            $this->statement($out, 'SET NAMES utf8mb4');
            $this->statement($out, 'SET FOREIGN_KEY_CHECKS=0');
            // A consistent snapshot while people keep working
            $this->db->statement('START TRANSACTION WITH CONSISTENT SNAPSHOT');
        }

        $tables = $this->tables();
        foreach ($tables as $table => $createSql) {
            $quoted = $this->quoteName($table);
            $this->statement($out, "DROP TABLE IF EXISTS {$quoted}");
            $this->statement($out, $createSql);

            $rows = [];
            foreach ($this->db->table($table)->cursor() as $row) {
                $rows[] = '('.implode(',', array_map(fn ($v) => $this->quoteValue($v), (array) $row)).')';
                if (count($rows) >= self::ROWS_PER_INSERT) {
                    $this->insert($out, $quoted, $rows);
                    $rows = [];
                }
            }
            if ($rows) {
                $this->insert($out, $quoted, $rows);
            }
        }

        // SQLite keeps indexes apart from the tables (MySQL includes them in CREATE TABLE)
        if (! $mysql) {
            foreach ($this->db->select("SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL") as $index) {
                $this->statement($out, $index->sql);
            }
        }

        if ($mysql) {
            $this->db->statement('COMMIT');
            $this->statement($out, 'SET FOREIGN_KEY_CHECKS=1');
        }
        fclose($out);

        return count($tables);
    }

    /** Replaces the database with the contents of a dump file. */
    public function restore(string $path): void
    {
        $sql = file_get_contents($path);
        if ($sql === false || ! str_contains($sql, self::SEPARATOR)) {
            throw new RuntimeException('invalid_backup');
        }

        $statements = array_filter(array_map('trim', explode("\n".self::SEPARATOR."\n", $sql)), fn ($s) => $s !== '' && ! str_starts_with($s, '-- '));

        $mysql = $this->isMysql();
        if ($mysql) {
            $this->db->statement('SET FOREIGN_KEY_CHECKS=0');
        } else {
            $this->db->statement('PRAGMA foreign_keys = OFF');
        }
        // Tables that exist now but not in the backup are removed too
        foreach (array_keys($this->tables()) as $table) {
            $this->db->statement('DROP TABLE IF EXISTS '.$this->quoteName($table));
        }
        foreach ($statements as $statement) {
            $statement = preg_replace('/^-- [^\n]*\n/', '', $statement);
            if (! $mysql && str_starts_with($statement, 'SET ')) {
                continue;
            }
            $this->db->unprepared($statement);
        }
        if ($mysql) {
            $this->db->statement('SET FOREIGN_KEY_CHECKS=1');
        } else {
            $this->db->statement('PRAGMA foreign_keys = ON');
        }
    }

    /** @return array<string, string> table name => CREATE TABLE statement */
    private function tables(): array
    {
        if ($this->isMysql()) {
            $tables = [];
            foreach ($this->db->select('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"') as $row) {
                $name = array_values((array) $row)[0];
                $create = (array) $this->db->selectOne('SHOW CREATE TABLE '.$this->quoteName($name));
                $tables[$name] = $create['Create Table'];
            }

            return $tables;
        }

        return collect($this->db->select("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"))
            ->mapWithKeys(fn ($t) => [$t->name => $t->sql])
            ->all();
    }

    private function insert($out, string $quotedTable, array $rows): void
    {
        $this->statement($out, "INSERT INTO {$quotedTable} VALUES\n".implode(",\n", $rows));
    }

    private function statement($out, string $sql): void
    {
        $this->write($out, rtrim($sql, "; \n").";\n".self::SEPARATOR);
    }

    private function write($out, string $text): void
    {
        fwrite($out, $text."\n");
    }

    private function quoteValue(mixed $value): string
    {
        return match (true) {
            $value === null => 'NULL',
            is_bool($value) => $value ? '1' : '0',
            is_int($value), is_float($value) => (string) $value,
            default => $this->db->getPdo()->quote((string) $value),
        };
    }

    private function quoteName(string $name): string
    {
        return $this->isMysql() ? '`'.str_replace('`', '``', $name).'`' : '"'.str_replace('"', '""', $name).'"';
    }

    private function isMysql(): bool
    {
        return in_array($this->db->getDriverName(), ['mysql', 'mariadb'], true);
    }
}
