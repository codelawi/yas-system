<?php

namespace App\Support;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;

/** Network addresses of the computer running the system. */
class ServerNetwork
{
    /**
     * IPv4 addresses of this computer, best candidates first.
     *
     * @return array<int, array{interface: string, ip: string, kind: string, mac: ?string}>
     */
    public static function addresses(): array
    {
        $result = [];
        foreach (function_exists('net_get_interfaces') ? (net_get_interfaces() ?: []) : [] as $name => $iface) {
            if (isset($iface['up']) && ! $iface['up']) {
                continue;
            }
            foreach ($iface['unicast'] ?? [] as $addr) {
                $ip = $addr['address'] ?? '';
                if (($addr['family'] ?? null) !== 2 || ! filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
                    continue;
                }
                if (str_starts_with($ip, '127.')) {
                    continue;
                }
                $result[] = [
                    'interface' => (string) ($iface['description'] ?? $name),
                    'ip' => $ip,
                    'kind' => self::kind($ip),
                    'mac' => self::macAddress((string) $name, $iface),
                ];
            }
        }

        $order = ['lan' => 0, 'other' => 1, 'link_local' => 2];
        usort($result, fn ($a, $b) => $order[$a['kind']] <=> $order[$b['kind']]);

        return $result;
    }

    /** Does this host name (or IP) lead to this computer? */
    public static function hostResolvesHere(string $host): bool
    {
        $host = strtolower(trim($host, '[]'));
        if ($host === '') {
            return false;
        }
        $ips = array_column(self::addresses(), 'ip');
        if (filter_var($host, FILTER_VALIDATE_IP)) {
            return in_array($host, $ips, true);
        }

        $hostname = strtolower((string) gethostname());
        $short = preg_replace('/\.local$/', '', $hostname);
        if (in_array($host, [$hostname, $short, $short.'.local'], true)) {
            return true;
        }

        // A DNS name created by IT (e.g. repo.company.lan): check where it points
        $resolved = Cache::remember('resolve:'.$host, 60, fn () => gethostbyname($host));

        return $resolved !== $host && in_array($resolved, $ips, true);
    }

    /** MAC address of a network card (IT needs it for a DHCP reservation). */
    private static function macAddress(string $name, array $iface): ?string
    {
        if (! empty($iface['mac'])) {
            return strtoupper(str_replace('-', ':', $iface['mac']));
        }
        $map = self::osMacAddresses();

        return $map[$name] ?? $map[(string) ($iface['description'] ?? '')] ?? null;
    }

    /** @return array<string, string> interface / connection name => MAC, read from the operating system */
    private static function osMacAddresses(): array
    {
        return Cache::remember('os-mac-addresses', 300, function () {
            if (! function_exists('shell_exec')) {
                return [];
            }
            $map = [];
            if (PHP_OS_FAMILY === 'Windows') {
                // "Connection Name","Network Adapter","Physical Address","Transport Name"
                foreach (preg_split('/\r?\n/', (string) @shell_exec('getmac /fo csv /nh /v')) as $line) {
                    $cols = str_getcsv($line, ',', '"', '');
                    if (count($cols) >= 3 && preg_match('/^([0-9A-F]{2}-){5}[0-9A-F]{2}$/i', $cols[2])) {
                        $mac = strtoupper(str_replace('-', ':', $cols[2]));
                        $map[$cols[0]] = $mac;
                        $map[$cols[1]] = $mac;
                    }
                }
            } else {
                $current = null;
                foreach (preg_split('/\r?\n/', (string) @shell_exec('ifconfig 2>/dev/null')) as $line) {
                    if (preg_match('/^([\w.:-]+): /', $line, $m)) {
                        $current = $m[1];
                    } elseif ($current && preg_match('/\b(?:ether|HWaddr)\s+(([0-9a-f]{2}:){5}[0-9a-f]{2})/i', $line, $m)) {
                        $map[$current] = strtoupper($m[1]);
                    }
                }
            }

            return $map;
        });
    }

    /** Client IP, with IPv4-mapped IPv6 (::ffff:1.2.3.4, sent by Node proxies) turned into plain IPv4. */
    public static function clientIp(Request $request): string
    {
        $ip = preg_replace('/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i', '$1', (string) $request->ip());

        return $ip === '::1' ? '127.0.0.1' : $ip;
    }

    public static function isServerAddress(string $ip): bool
    {
        return str_starts_with($ip, '127.') || $ip === '::1'
            || in_array($ip, array_column(self::addresses(), 'ip'), true);
    }

    /** lan = private network address phones can use; link_local = 169.254.x.x (no DHCP, not usable). */
    private static function kind(string $ip): string
    {
        if (str_starts_with($ip, '169.254.')) {
            return 'link_local';
        }
        if (! filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE)) {
            return 'lan';
        }

        return 'other';
    }
}
