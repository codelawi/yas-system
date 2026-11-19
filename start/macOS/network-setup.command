#!/bin/bash
# ==========================================================================
#  Equipment Repository on a Mac - network setup. Double-click it ONCE, with the
#  START.command window open and this Mac connected to the hotspot / Wi-Fi.
#    1. names this Mac "repo" on the network, so phones open  https://repo.local  on ANY
#       hotspot or Wi-Fi, whatever IP this Mac gets. macOS announces the name itself
#       (Bonjour / mDNS): no IP addresses to update and no hosts file on the phones.
#       The name Finder and AirDrop show does not change.
#    2. lets Apache through the macOS firewall (only when the firewall is on)
#    3. tests the name, then makes it the QR address:  https://repo.local
#  Asks for your Mac password (an administrator account). Safe to run again.
# ==========================================================================
. "$(dirname "$0")/common.sh"
WANT="$NAME.local"
QR_URL="https://$WANT"

# ---------------------------------------------------------------- 1. network name
step "1. Network name = $WANT"
CURRENT="$(scutil --get LocalHostName 2>/dev/null)"
if [ "$(echo "$CURRENT" | tr '[:upper:]' '[:lower:]')" = "$NAME" ]; then
    ok "This Mac is already $WANT"
else
    warn "This Mac is $CURRENT.local on the network. It will become $WANT."
    read -r -p '   Type YES to rename: ' ANSWER
    [ "$ANSWER" = 'YES' ] || fail 'Not renamed. The QR address needs this name - stopping.'
    warn 'Type your Mac password if asked (nothing shows while you type).'
    sudo scutil --set LocalHostName "$NAME" || fail 'Not renamed (wrong password, or not an administrator?).'
    ok "Renamed. Finder and AirDrop still show \"$(scutil --get ComputerName)\"."
    sleep 3
fi

# Another device with the same name on this network (e.g. the Windows PC)? Then the name
# leads there, or macOS gave this Mac another one (repo-2).
RESOLVED="$(ping -c 1 -t 2 "$WANT" 2>/dev/null | sed -n '1s/^PING [^(]*(\([0-9.]*\)).*/\1/p')"
if [ "$(scutil --get LocalHostName 2>/dev/null | tr '[:upper:]' '[:lower:]')" != "$NAME" ]; then
    fail "Another device on this network already uses $WANT, so macOS renamed this Mac. Turn that device off (or take it off this network), then run this again."
elif [ -n "$RESOLVED" ] && [ "$RESOLVED" != '127.0.0.1' ] && ! local_ips | grep -qxF "$RESOLVED"; then
    fail "$WANT leads to $RESOLVED, another device on this network. Turn it off (or take it off this network), then run this again."
fi
if [ -n "$RESOLVED" ]; then
    ok "$WANT leads to this Mac ($(echo $(local_ips)) today - it may change, the name stays)."
else
    warn "$WANT does not answer yet (it can take a few seconds) - step 3 tests it again."
fi

# ---------------------------------------------------------------- 2. firewall
step '2. Firewall'
FW=/usr/libexec/ApplicationFirewall/socketfilterfw
if "$FW" --getglobalstate 2>/dev/null | grep -q 'enabled'; then
    find_apache || fail 'Apache not found - double-click START.command first.'
    sudo "$FW" --add "$HTTPD" >/dev/null && sudo "$FW" --unblockapp "$HTTPD" >/dev/null &&
        ok "Apache ($HTTPD) may receive connections from phones." ||
        warn 'Could not change the firewall: System Settings > Network > Firewall > Options > allow httpd.'
    if "$FW" --getblockall 2>/dev/null | grep -qi 'enabled'; then
        warn 'The firewall blocks ALL incoming connections: System Settings > Network > Firewall > Options > turn off "Block all incoming connections".'
    fi
else
    ok 'The macOS firewall is off - nothing to allow.'
fi

# ---------------------------------------------------------------- 3. test
step '3. Test'
if ! url_ok "http://127.0.0.1:$APP_PORT/api/network/ping"; then
    fail 'The system is not running. Double-click START.command (keep its window open), then run this again.'
fi
ok 'The system is running.'
if url_ok --cacert "$HTTPS/repo-ca.crt" "$QR_URL/api/network/ping"; then
    ok "The system opens through $QR_URL on this Mac."
else
    fail "$QR_URL does not open on this Mac. Close the START.command window, double-click it again, then run this again."
fi

# ---------------------------------------------------------------- 4. QR address
step "4. QR address = $QR_URL"
find_php || fail 'PHP 8.3+ is needed (see above).'
cd "$APP" || fail "$APP not found."
if ! OUT="$("$PHP" artisan repo:qr-address "$QR_URL" 2>&1)"; then
    echo "$OUT"
    case "$OUT" in
    *'labels were printed'*)
        warn 'Labels printed with the old address still open the system, but only while connected.'
        warn 'For labels that open without a connection, the QR address must be https and the labels printed again.'
        read -r -p "   Type YES to change the QR address to $QR_URL: " ANSWER
        if [ "$ANSWER" = 'YES' ]; then
            "$PHP" artisan repo:qr-address "$QR_URL" "--confirm=$QR_URL"
        else
            warn 'QR address not changed.'
        fi
        ;;
    *) fail 'The QR address was not changed (see above).' ;;
    esac
fi
"$PHP" artisan repo:qr-address

# ---------------------------------------------------------------- next
step 'On EACH phone (once)'
echo "   1. Connect to the same hotspot / Wi-Fi and open  http://$WANT/offline"
echo '   2. Tap "Download the certificate" and install it:'
echo '        iPhone : Settings > Profile Downloaded > Install, then'
echo '                 Settings > General > About > Certificate Trust Settings > turn it ON'
echo '        Android: Settings > Security > Encryption & credentials > Install a certificate > CA certificate'
echo "   3. Open  $QR_URL/offline  (no warning must appear) > Download data"
echo '   4. Test: turn Wi-Fi OFF, scan a label printed with https - the page must open.'
echo "   A phone that cannot open $WANT? Use the http://<IP> address START.command shows."
echo
read -r -p '   Done. Press Enter to close ' _
