# Equipment Repository on a Mac - shared by START.command and network-setup.command.
# Not run on its own. Written for the bash that comes with every Mac (bash 3.2).

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"     # the system folder (backend, start, ...)
APP="$ROOT/backend"
HTTPS="$APP/storage/https"            # certificates - the same folder as on the Windows PC: copy it
                                      # between computers and the phones need nothing new
RUN="$APP/storage/logs/mac-server"    # Apache's settings, logs and pid while the system runs
APP_PORT=8000                         # the system itself, on this Mac only; Apache forwards 80 + 443 to it
NAME=repo                             # network name: https://repo.local (the same as the Windows PC)

# Finder starts .command files without Homebrew in the PATH
PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:$PATH"
export PATH

C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_OFF=$'\033[0m'
step() { printf '\n%s== %s%s\n' "$C_CYAN" "$1" "$C_OFF"; }
ok()   { printf '   %s[OK]%s %s\n' "$C_GREEN" "$C_OFF" "$1"; }
warn() { printf '   %s[!]%s  %s\n' "$C_YELLOW" "$C_OFF" "$1"; }
fail() { printf '   %s[X]%s  %s\n' "$C_RED" "$C_OFF" "$1"; read -r -p '   Press Enter to close ' _; exit 1; }

port_open() { nc -z -G 2 127.0.0.1 "$1" >/dev/null 2>&1; }
url_ok()    { curl -fsS -o /dev/null --max-time 5 "$@" >/dev/null 2>&1; }

# This Mac's IPv4 addresses (not 127.x, not 169.254.x = no DHCP), one per line
local_ips() { ifconfig | awk '/inet / {print $2}' | grep -vE '^(127\.|169\.254\.)'; }

# Finds PHP 8.3 or newer and puts its path in $PHP.
# Looks at $PHP, the PATH, Homebrew, Herd, MAMP and XAMPP (XAMPP's PHP is often too old).
# PHP somewhere else? In Terminal:  PHP=/path/to/php ./START.command
find_php() {
    local c list old=''
    list="$(
        [ -n "${PHP:-}" ] && echo "$PHP"
        command -v php 2>/dev/null
        ls -d /opt/homebrew/bin/php /usr/local/bin/php /opt/homebrew/opt/php*/bin/php /usr/local/opt/php*/bin/php \
            "$HOME/Library/Application Support/Herd/bin/php" /Applications/MAMP/bin/php/php8*/bin/php \
            /Applications/XAMPP/xamppfiles/bin/php 2>/dev/null
    )"
    PHP=''
    while IFS= read -r c; do
        if [ -z "$c" ] || [ ! -x "$c" ]; then continue; fi
        if "$c" -r 'exit(version_compare(PHP_VERSION, "8.3.0", "<") ? 1 : 0);' >/dev/null 2>&1; then
            PHP="$c"
            break
        fi
        old="$old"$'\n'"      $c  (PHP $("$c" -r 'echo PHP_VERSION;' 2>/dev/null))"
    done <<EOF
$list
EOF
    if [ -z "$PHP" ]; then
        warn 'PHP 8.3 or newer not found.'
        [ -n "$old" ] && echo "      Too old:$old"
        echo '      Install it with Homebrew (https://brew.sh):  brew install php'
        return 1
    fi
    # The extensions the system needs (zip: backups and Word/Excel forms)
    if ! "$PHP" -r '$m = array_filter(["pdo_mysql", "mbstring", "zip", "fileinfo", "openssl"], fn ($e) => ! extension_loaded($e)); if ($m) { echo "      ".implode(", ", $m).PHP_EOL."      php.ini: ".(php_ini_loaded_file() ?: "none").PHP_EOL; exit(1); }'; then
        warn "PHP extensions missing in $PHP (see above)."
        return 1
    fi
}

# Finds an Apache with https and proxy modules: $HTTPD and its modules folder $MODS.
# macOS has one built in; Homebrew's or XAMPP's are used when it is missing.
find_apache() {
    local pair bin dir
    for pair in \
        '/usr/sbin/httpd|/usr/libexec/apache2' \
        '/opt/homebrew/opt/httpd/bin/httpd|/opt/homebrew/opt/httpd/lib/httpd/modules' \
        '/usr/local/opt/httpd/bin/httpd|/usr/local/opt/httpd/lib/httpd/modules' \
        '/Applications/XAMPP/xamppfiles/bin/httpd|/Applications/XAMPP/xamppfiles/modules'; do
        bin="${pair%%|*}"
        dir="${pair#*|}"
        if [ -x "$bin" ] && [ -f "$dir/mod_ssl.so" ] && [ -f "$dir/mod_proxy_http.so" ]; then
            HTTPD="$bin"
            MODS="$dir"
            return 0
        fi
    done
    return 1
}
