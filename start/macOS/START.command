#!/bin/bash
# ==========================================================================
#  Equipment Repository on a Mac - double-click this file to start everything.
#    PHP 8.3+  ->  MySQL  ->  https certificate  ->  Apache on http 80 + https 443
#    ->  the system (on this Mac only, 127.0.0.1:8000)
#    ->  the print station (Edge or Chrome): prints issued vouchers by itself
#  Keep the Terminal window open while the system is used. Closing it stops the system.
#
#  Once, before printing labels: double-click network-setup.command. Phones then open the
#  system at https://repo.local on any hotspot or Wi-Fi, whatever IP this Mac gets.
#
#  First time on this Mac: when backend/.env is missing it is created and opened in TextEdit.
#  "unidentified developer"?  Right-click this file > Open > Open (once).
#  "permission denied"?       In Terminal:  chmod +x start/macOS/*.command
# ==========================================================================
. "$(dirname "$0")/common.sh"
printf '\033]0;Equipment Repository - keep this window open\007'

HTTPD_PID=''
SERVER_PID=''
stop_all() {
    if [ -n "$SERVER_PID" ]; then pkill -TERM -P "$SERVER_PID" 2>/dev/null; kill "$SERVER_PID" 2>/dev/null; fi
    if [ -n "$HTTPD_PID" ]; then kill "$HTTPD_PID" 2>/dev/null; fi
}
trap stop_all EXIT
trap 'exit 0' INT TERM HUP

# Waits up to $2 seconds for a command to succeed
wait_for() {
    local what="$1" seconds="$2" i=0
    shift 2
    while [ "$i" -lt "$seconds" ]; do
        if "$@"; then return 0; fi
        sleep 1
        i=$((i + 1))
    done
    fail "$what did not start within $seconds seconds."
}

# ------------------------------------------------------------------ 1. PHP + network name
step '1. PHP and network name'
find_php || fail 'PHP 8.3+ is needed (see above).'
ok "$PHP  (PHP $("$PHP" -r 'echo PHP_VERSION;'))"

if [ ! -f "$APP/.env" ]; then
    cp "$APP/.env.production.example" "$APP/.env"
    open -e "$APP/.env"
    warn 'First time on this Mac: created backend/.env and opened it in TextEdit.'
    warn 'Check the DB_ lines (XAMPP: DB_USERNAME=root and an empty DB_PASSWORD), save, close it,'
    warn 'then double-click START.command again.'
    read -r -p '   Press Enter to close ' _
    exit 0
fi
cd "$APP" || fail "$APP not found."
# The key is made once and must stay the same afterwards
grep -q '^APP_KEY=base64:' .env || "$PHP" artisan key:generate --force --no-interaction >/dev/null || fail 'Could not create APP_KEY in backend/.env.'

LOCAL_NAME="$(scutil --get LocalHostName 2>/dev/null | tr '[:upper:]' '[:lower:]')"
HOST="$LOCAL_NAME.local"
URL="https://$HOST"
if [ "$LOCAL_NAME" = "$NAME" ]; then
    ok "Network name: $HOST"
else
    warn "Network name: $HOST - double-click network-setup.command once to make it $NAME.local"
fi
IPS="$(local_ips)"
if [ -n "$IPS" ]; then
    ok "Network address today: $(echo $IPS)  (it may change, the name stays)"
else
    warn 'Not connected to any network: only this Mac can open the system. Connect to the hotspot / Wi-Fi.'
fi

# ------------------------------------------------------------------ old copies (window closed without stopping)
mkdir -p "$RUN"
if [ -f "$RUN/httpd.pid" ]; then
    old="$(cat "$RUN/httpd.pid")"
    if ps -o command= -p "$old" 2>/dev/null | grep -qF "$RUN/httpd.conf"; then kill "$old" 2>/dev/null; sleep 1; fi
    rm -f "$RUN/httpd.pid"
fi
for old in $(lsof -nP -t -iTCP:"$APP_PORT" -sTCP:LISTEN 2>/dev/null); do
    if ps -o command= -p "$old" 2>/dev/null | grep -qE 'server\.php|artisan serve'; then pkill -TERM -P "$old" 2>/dev/null; kill "$old" 2>/dev/null; sleep 1; fi
done

# ------------------------------------------------------------------ 2. MySQL
step '2. MySQL'
DB_PORT="$(sed -n 's/^DB_PORT=//p' .env | tr -d '"\r ')"
DB_PORT="${DB_PORT:-3306}"
if port_open "$DB_PORT"; then
    ok 'Already running.'
else
    if [ -x /Applications/XAMPP/xamppfiles/xampp ]; then
        warn 'Starting MySQL from XAMPP - type your Mac password if asked (nothing shows while you type).'
        sudo /Applications/XAMPP/xamppfiles/xampp startmysql
    elif command -v brew >/dev/null && SERVICE="$(brew services list 2>/dev/null | awk '/^(mysql|mariadb)/ {print $1; exit}')" && [ -n "$SERVICE" ]; then
        brew services start "$SERVICE"
    elif [ -d /Applications/DBngin.app ]; then
        open -a DBngin
        warn 'DBngin is open: press Start next to MySQL.'
    else
        fail "MySQL is not running (port $DB_PORT) and no XAMPP, Homebrew or DBngin MySQL was found."
    fi
    wait_for 'MySQL' 60 port_open "$DB_PORT"
    ok 'Started.'
fi

# ------------------------------------------------------------------ 3. https certificate
step '3. https certificate'
OPENSSL="$(command -v openssl)" || fail 'openssl not found.'
mkdir -p "$HTTPS"
CA_KEY="$HTTPS/repo-ca.key"; CA_CRT="$HTTPS/repo-ca.crt"; KEY="$HTTPS/repo.key"; CRT="$HTTPS/repo.crt"
openssl_run() { local out; out="$("$OPENSSL" "$@" 2>&1)" || { echo "$out"; fail "openssl $1 failed (see above)."; }; }

if [ ! -f "$CA_KEY" ] || [ ! -f "$CA_CRT" ]; then
    cat >"$HTTPS/ca.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Equipment Repository CA
O = Equipment Repository
[ext]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF
    openssl_run req -x509 -new -nodes -newkey rsa:2048 -sha256 -days 3650 -keyout "$CA_KEY" -out "$CA_CRT" -config "$HTTPS/ca.cnf"
    rm -f "$HTTPS/ca.cnf"
    chmod 600 "$CA_KEY"
    ok 'Created the certificate authority (phones install it once).'
fi

# Names and addresses the certificate must cover
NAMES=''
add_name() { case ", $NAMES, " in *", $1, "*) ;; *) NAMES="${NAMES:+$NAMES, }$1" ;; esac; }
for n in "$NAME.local" "$NAME" "$HOST" "$LOCAL_NAME" localhost; do add_name "DNS:$n"; done
add_name 'IP:127.0.0.1'
for ip in $IPS; do add_name "IP:$ip"; done

NEED_CERT=yes
if [ -f "$CRT" ] && [ -f "$KEY" ] && "$OPENSSL" x509 -checkend 2592000 -noout -in "$CRT" >/dev/null 2>&1 &&
    "$OPENSSL" verify -CAfile "$CA_CRT" "$CRT" >/dev/null 2>&1; then
    HAVE=",$("$OPENSSL" x509 -noout -text -in "$CRT" | grep -A1 'Subject Alternative Name' | tail -1 | tr -d ' '),"
    NEED_CERT=''
    for n in $(echo "$NAMES" | tr -d ' ' | tr ',' ' '); do
        case "$HAVE" in *",${n/#IP:/IPAddress:},"*) ;; *) NEED_CERT=yes ;; esac
    done
fi
if [ -n "$NEED_CERT" ]; then
    cat >"$HTTPS/repo.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = $NAME.local
[ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = $NAMES
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid, issuer
EOF
    # iPhones refuse https certificates valid for more than 825 days
    openssl_run req -new -nodes -newkey rsa:2048 -keyout "$KEY" -out "$HTTPS/repo.csr" -config "$HTTPS/repo.cnf"
    openssl_run x509 -req -in "$HTTPS/repo.csr" -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial -out "$CRT" -days 825 -sha256 -extfile "$HTTPS/repo.cnf" -extensions ext
    rm -f "$HTTPS/repo.csr" "$HTTPS/repo.cnf"
    chmod 600 "$KEY"
    ok "New certificate for: $NAMES"
else
    ok 'The certificate already covers this name and address.'
fi

# Phones download the authority from http://<name>.local/repo-ca.crt (also a button on the 'Work offline' page)
cp "$CA_CRT" "$APP/public/repo-ca.crt"
if ! security verify-cert -c "$CA_CRT" >/dev/null 2>&1; then
    warn 'macOS will ask for your password to trust the certificate - type it and confirm.'
    if security add-trusted-cert -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$CA_CRT" 2>/dev/null; then
        ok 'This Mac now trusts the certificate.'
    else
        warn 'Certificate not trusted on this Mac (the browser shows a warning; the system still works).'
    fi
fi

# ------------------------------------------------------------------ 4. Apache (http 80 + https 443 -> the system on 127.0.0.1:8000)
step '4. Apache (http + https)'
find_apache || fail 'Apache with https not found. Install it with Homebrew:  brew install httpd'
if port_open 80 || port_open 443; then
    # Usually XAMPP's own Apache. The system brings its own, so XAMPP's is stopped (MySQL keeps running).
    if pgrep -qf '/Applications/XAMPP/xamppfiles/bin/httpd'; then
        warn "XAMPP's Apache uses ports 80/443 - stopping it. Type your Mac password if asked."
        sudo /Applications/XAMPP/xamppfiles/xampp stopapache >/dev/null
        sleep 2
    fi
    if port_open 80 || port_open 443; then
        fail 'Port 80 or 443 is used by another program (another web server?). Stop it, then double-click START.command again.'
    fi
fi

MODULES=''
for m in mpm_prefork unixd authz_core headers proxy proxy_http socache_shmcb ssl; do
    if [ -f "$MODS/mod_$m.so" ]; then MODULES="${MODULES}LoadModule ${m}_module \"$MODS/mod_$m.so\""$'\n'; fi
done
cat >"$RUN/httpd.conf" <<EOF
# Written by START.command each time it starts - changes here are lost.
# Answers phones on http (80) and https (443) and forwards everything to the system,
# which runs on this Mac only (127.0.0.1:$APP_PORT).
$MODULES
Listen 80
Listen 443
ServerName $NAME.local
DefaultRuntimeDir "$RUN"
PidFile "$RUN/httpd.pid"
ErrorLog "$RUN/apache-error.log"
LogLevel warn
StartServers 2
MinSpareServers 2
MaxSpareServers 6
MaxRequestWorkers 60
SSLSessionCache "shmcb:$RUN/ssl_scache(512000)"

<VirtualHost *:80>
    ServerName $NAME.local
    ServerAlias *
    # A serial number with "/" (sent as %2F) must reach the system unchanged
    AllowEncodedSlashes NoDecode
    ProxyPreserveHost On
    ProxyTimeout 600
    ProxyPass / http://127.0.0.1:$APP_PORT/ nocanon
    ProxyPassReverse / http://127.0.0.1:$APP_PORT/
</VirtualHost>

<VirtualHost *:443>
    ServerName $NAME.local
    ServerAlias *
    SSLEngine on
    SSLCertificateFile "$CRT"
    SSLCertificateKeyFile "$KEY"
    RequestHeader set X-Forwarded-Proto "https"
    AllowEncodedSlashes NoDecode
    ProxyPreserveHost On
    ProxyTimeout 600
    ProxyPass / http://127.0.0.1:$APP_PORT/ nocanon
    ProxyPassReverse / http://127.0.0.1:$APP_PORT/
</VirtualHost>
EOF
TEST="$("$HTTPD" -t -f "$RUN/httpd.conf" 2>&1)" || { echo "$TEST"; fail 'Apache refused the settings (see above).'; }
# Apache runs in the background in its own process group: when it stops it signals its whole
# group, which would also stop this window if they shared one (as with -DFOREGROUND)
OUT="$("$HTTPD" -f "$RUN/httpd.conf" 2>&1)" || { echo "$OUT"; tail -5 "$RUN/apache-error.log" 2>/dev/null; fail 'Apache did not start (see above).'; }
apache_up() {
    HTTPD_PID="$(cat "$RUN/httpd.pid" 2>/dev/null)"
    [ -n "$HTTPD_PID" ] && port_open 80 && port_open 443
}
wait_for 'Apache' 20 apache_up
ok "Apache answers on ports 80 and 443 ($HTTPD)."

# ------------------------------------------------------------------ 5. database changes (only adds, never deletes)
step '5. Database'
OUT="$("$PHP" artisan migrate --force --no-interaction 2>&1)" || { echo "$OUT"; fail 'Database step failed - check the DB_ lines in backend/.env.'; }
# The first admin (PIN 1234), only when there is no admin yet
"$PHP" artisan db:seed --force --no-interaction >/dev/null 2>&1
ok 'Up to date.'

# ------------------------------------------------------------------ 6. the system
step '6. Starting the system'
if port_open "$APP_PORT"; then fail "Port $APP_PORT is used by another program. Close it, then double-click START.command again."; fi
# PHP's own web server, as "php artisan serve" runs it, with the upload sizes the Word import
# needs and 4 workers so several phones are served at once
SERVER="$APP/vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php"
if [ -f "$APP/server.php" ]; then SERVER="$APP/server.php"; fi
: >"$RUN/php-server.log"
(cd "$APP/public" && PHP_CLI_SERVER_WORKERS=4 exec "$PHP" -d upload_max_filesize=50M -d post_max_size=200M \
    -d max_file_uploads=100 -d memory_limit=512M -S "127.0.0.1:$APP_PORT" "$SERVER") >>"$RUN/php-server.log" 2>&1 &
SERVER_PID=$!
system_up() {
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        tail -5 "$RUN/php-server.log"
        fail 'The system stopped (see above).'
    fi
    url_ok "http://127.0.0.1:$APP_PORT/api/network/ping"
}
wait_for 'The system' 30 system_up
if url_ok --cacert "$CA_CRT" "$URL/api/network/ping"; then
    ok "$URL works."
elif url_ok --cacert "$CA_CRT" 'https://localhost/api/network/ping'; then
    warn "https works, but $URL did not answer yet on this Mac (the name may take a few seconds)."
else
    warn 'https did not answer the test - check the steps above.'
fi

QR="$("$PHP" artisan repo:qr-address 2>/dev/null | sed -n 's/^QR address: \([^ ]*\).*/\1/p')"
if [ "$QR" = "https://$NAME.local" ]; then
    ok "QR labels print with $QR"
else
    warn "QR labels print with ${QR:-(not set)} - network-setup.command makes it https://$NAME.local"
fi

# No sleep while the system runs (the lid must stay open)
caffeinate -i -w "$SERVER_PID" &

echo
printf '%s' "$C_GREEN"
echo '  ============================================================'
echo "    Open:  $URL"
[ -n "$IPS" ] && echo "    Also:  https://localhost   $(for ip in $IPS; do printf 'http://%s  ' "$ip"; done)"
echo "    Phones, once: open http://$HOST/offline and install the certificate"
echo '    Keep this window open. Close it (or press Ctrl+C) to stop the system.'
echo '  ============================================================'
printf '%s\n' "$C_OFF"
open "$URL"

# ------------------------------------------------------------------ 7. print station
# A browser window of its own that prints each issued voucher on the default printer without
# asking (--kiosk-printing). A phone can ask for it again: the system then writes $STATION_ASK.
step '7. Print station'
STATION_URL=''; STATION_ASK=''; STATION_OPEN=''
while IFS= read -r line; do
    case "$line" in
        'Print station: '*) STATION_URL="${line#Print station: }" ;;
        'Open requests: '*) STATION_ASK="${line#Open requests: }" ;;
        'Open now: yes'*) STATION_OPEN=yes ;;
    esac
done < <("$PHP" artisan repo:print-station --base="http://127.0.0.1:$APP_PORT" 2>/dev/null)
STATION_APP=''
for app in 'Microsoft Edge' 'Google Chrome'; do
    for dir in /Applications "$HOME/Applications"; do
        if [ -z "$STATION_APP" ] && [ -d "$dir/$app.app" ]; then STATION_APP="$dir/$app.app"; fi
    done
done
STATION_NAME="$(basename "$STATION_APP" .app)"
open_station() {
    [ -n "$STATION_APP" ] && [ -n "$STATION_URL" ] || return 1
    # -n with its own profile: a copy of the browser of its own, the one you browse with is not touched
    open -na "$STATION_APP" --args --user-data-dir="$APP/storage/app/print-station/browser" --kiosk-printing \
        --no-first-run --no-default-browser-check --disable-background-timer-throttling \
        --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --app="$STATION_URL" >/dev/null 2>&1
}
if [ -z "$STATION_URL" ]; then
    warn 'The print station address could not be read - vouchers will not print by themselves.'
elif [ -z "$STATION_APP" ]; then
    warn 'Neither Microsoft Edge nor Google Chrome was found - vouchers will not print by themselves.'
else
    [ -n "$STATION_ASK" ] && rm -f "$STATION_ASK"
    if [ -n "$STATION_OPEN" ]; then
        ok 'Already open in another window.'
    elif open_station; then
        ok "Opened in $STATION_NAME: vouchers print on the default printer (put A5 paper in it)."
    else
        warn "$STATION_NAME did not start - vouchers will not print by themselves."
    fi
fi

# Keep running while the system runs; open the print station again when a phone asks for it
while kill -0 "$SERVER_PID" 2>/dev/null; do
    if [ -n "$STATION_ASK" ] && [ -f "$STATION_ASK" ]; then
        rm -f "$STATION_ASK"
        if open_station; then ok "$(date +%H:%M) Print station opened (asked from a phone)."; fi
    fi
    sleep 1
done
echo
warn "The system stopped. Its messages are in $RUN/php-server.log"
