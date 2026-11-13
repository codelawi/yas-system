<#
  Equipment Repository - HTTPS, so phones can keep the data and open labels WITHOUT a connection.
  Phones keep a website for offline use only when it is https. This script:
    1. finds OpenSSL (it comes with XAMPP's and Laragon's Apache)
    2. creates the system's own certificate authority - ONCE (phones trust it once)
    3. creates the https certificate for repo.local, repo, localhost and the laptop's addresses
    4. puts the authority at  http://repo.local/repo-ca.crt  so phones can install it
    5. trusts it on this laptop and opens port 443 in the firewall
    6. web server:
         XAMPP  : sets up XAMPP's Apache in front of the system - it answers phones on
                  http (80) and https (443) and forwards to start-server.bat, which then
                  runs on 127.0.0.1:8000. XAMPP's PHP version does not matter.
         Laragon: checks Laragon's Apache (Apache > SSL > Enabled, apache-vhost.conf copied)
    7. tests http and https
    8. sets the QR address to  https://repo.local

  Run in PowerShell AS ADMINISTRATOR, from the windows folder:

    powershell -ExecutionPolicy Bypass -File .\https-setup.ps1

  -Name     Computer name (default: repo  ->  https://repo.local)
  -AppPath  System folder (default: the folder above this windows folder)
  -Xampp    XAMPP folder (default: C:\xampp)

  Safe to run again: the authority is kept (phones keep trusting it) and the certificate is
  made again with today's addresses. Run it again before the date it prints (about 2 years).
  The files are in storage\https - keep a copy of that folder with the backups:
  a new laptop with the same authority needs nothing new on the phones.
#>
#Requires -RunAsAdministrator
param(
    [string]$Name = 'repo',
    [string]$AppPath = '',
    [string]$Xampp = 'C:\xampp'
)
if (-not $AppPath) { $AppPath = Split-Path -Parent $PSScriptRoot }

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 may still try old TLS versions, which Apache refuses
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   [OK] $text" -ForegroundColor Green }
function Warn($text) { Write-Host "   [!]  $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "   [X]  $text" -ForegroundColor Red }

$Name = $Name.ToLower()
$hostName = "$Name.local"
$qrUrl = "https://$hostName"
$dir = Join-Path $AppPath 'storage\https'
# iPhones refuse https certificates valid for more than 825 days
$days = 825

# ---------------------------------------------------------------- 1. OpenSSL
Step '1. OpenSSL'
$openssl = $null
$cmd = Get-Command openssl -ErrorAction SilentlyContinue
if ($cmd) { $openssl = $cmd.Source }
if (-not $openssl) {
    $found = @(Get-ChildItem -Path (Join-Path $Xampp 'apache\bin\openssl.exe'), 'C:\laragon\bin\apache\*\bin\openssl.exe', 'C:\laragon\bin\git\usr\bin\openssl.exe', 'C:\Program Files\Git\usr\bin\openssl.exe' -ErrorAction SilentlyContinue)
    if ($found.Count -gt 0) { $openssl = $found[0].FullName }
}
if (-not $openssl) {
    Fail 'openssl.exe not found. It comes with XAMPP (C:\xampp\apache\bin), Laragon and Git for Windows.'
    exit 1
}
Ok $openssl

# Runs a program; its normal messages on stderr (OpenSSL, Apache) must not stop the script
function Invoke-Native {
    $ErrorActionPreference = 'Continue'
    $program, $rest = $args
    & $program @rest
}

function Invoke-OpenSsl {
    Invoke-Native $openssl @args
    if ($LASTEXITCODE -ne 0) { Fail "openssl $($args[0]) failed (see above)."; exit 1 }
}

New-Item -ItemType Directory -Force -Path $dir | Out-Null
$caKey = Join-Path $dir 'repo-ca.key'
$caCrt = Join-Path $dir 'repo-ca.crt'
$key = Join-Path $dir 'repo.key'
$crt = Join-Path $dir 'repo.crt'

# ---------------------------------------------------------------- 2. authority (once)
Step '2. Certificate authority (made once - phones trust it once)'
if ((Test-Path $caKey) -and (Test-Path $caCrt)) {
    Ok 'Kept the existing authority: phones that trust it keep working.'
} else {
    $caConfig = Join-Path $dir 'ca.cnf'
    @(
        '[req]'
        'distinguished_name = dn'
        'x509_extensions = ext'
        'prompt = no'
        '[dn]'
        'CN = Equipment Repository CA'
        'O = Equipment Repository'
        '[ext]'
        'basicConstraints = critical, CA:TRUE, pathlen:0'
        'keyUsage = critical, keyCertSign, cRLSign'
        'subjectKeyIdentifier = hash'
    ) | Set-Content -Encoding Ascii -Path $caConfig
    Invoke-OpenSsl req -x509 -new -nodes -newkey rsa:2048 -sha256 -days 3650 -keyout $caKey -out $caCrt -config $caConfig
    Remove-Item $caConfig
    Ok 'Created (valid 10 years). Every phone installs it once.'
}

# ---------------------------------------------------------------- 3. https certificate
Step "3. https certificate for $hostName"
$names = @("DNS:$hostName", "DNS:$Name", 'DNS:localhost', 'IP:127.0.0.1', 'IP:192.168.137.1')
foreach ($ip in (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' })) {
    if ($names -notcontains "IP:$($ip.IPAddress)") { $names += "IP:$($ip.IPAddress)" }
}
$config = Join-Path $dir 'repo.cnf'
@(
    '[req]'
    'distinguished_name = dn'
    'prompt = no'
    '[dn]'
    "CN = $hostName"
    '[ext]'
    'basicConstraints = critical, CA:FALSE'
    'keyUsage = critical, digitalSignature, keyEncipherment'
    'extendedKeyUsage = serverAuth'
    "subjectAltName = $($names -join ', ')"
    'subjectKeyIdentifier = hash'
    'authorityKeyIdentifier = keyid, issuer'
) | Set-Content -Encoding Ascii -Path $config
$request = Join-Path $dir 'repo.csr'
Invoke-OpenSsl req -new -nodes -newkey rsa:2048 -keyout $key -out $request -config $config
Invoke-OpenSsl x509 -req -in $request -CA $caCrt -CAkey $caKey -CAcreateserial -out $crt -days $days -sha256 -extfile $config -extensions ext
Remove-Item $request, $config
$renewBy = (Get-Date).AddDays($days - 30).ToString('yyyy-MM-dd')
Ok "For: $($names -join '  ')"
Ok "Run this script again before $renewBy (phones need nothing new)."

# ---------------------------------------------------------------- 4. for the phones
Step '4. Certificate for the phones'
Copy-Item $caCrt (Join-Path $AppPath 'public\repo-ca.crt') -Force
Ok "Phones download it from  http://$hostName/repo-ca.crt  (also a button on the system's 'Work offline' page)."

# ---------------------------------------------------------------- 5. this laptop + firewall
Step '5. This laptop and the firewall'
Import-Certificate -FilePath $caCrt -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Ok 'This laptop trusts the authority (its browsers open https without a warning).'
$rule = 'Equipment Repository (https)'
Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -Profile Any | Out-Null
Ok 'TCP 443 allowed on every network.'

# ---------------------------------------------------------------- 6. web server
$httpdConf = Join-Path $Xampp 'apache\conf\httpd.conf'
$proxyMarker = Join-Path $dir 'apache-proxy.txt'
$systemUrl = 'http://127.0.0.1:8000/api/network/ping'
function Test-Url($url) {
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri $url | Out-Null; return $true } catch { return $false }
}
function Get-PortOwners($port) {
    @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } | Select-Object -Unique)
}

if (Test-Path $httpdConf) {
    Step "6. XAMPP's Apache in front of the system (http 80 + https 443)"
    $apache = Join-Path $Xampp 'apache'
    $httpd = Join-Path $apache 'bin\httpd.exe'

    # Apache takes port 80 from now on: the old start-server.bat window (php on port 80) must close
    if ((Get-PortOwners 80) -contains 'php') {
        Warn 'start-server.bat is running on port 80. Close its window now - Apache answers on port 80 from now on.'
        Read-Host '   Press Enter when it is closed' | Out-Null
    }
    $others = @(Get-PortOwners 443 | Where-Object { $_ -ne 'httpd' })
    if ($others.Count -gt 0) {
        Fail "Port 443 is used by: $($others -join ', '). Close or reconfigure it (often VMware, Skype or IIS), then run this again."
        exit 1
    }

    # Our settings in their own file; httpd.conf only gets the modules, https and one Include
    $repoConf = Join-Path $apache 'conf\extra\httpd-repo.conf'
    $template = Get-Content -Raw -Path (Join-Path $PSScriptRoot 'apache-proxy.conf')
    [IO.File]::WriteAllText($repoConf, $template.Replace('__APP__', ($AppPath -replace '\\', '/')))

    $original = [IO.File]::ReadAllText($httpdConf)
    if (-not (Test-Path "$httpdConf.before-repo")) { Copy-Item $httpdConf "$httpdConf.before-repo" }
    $lines = New-Object 'System.Collections.Generic.List[string]'
    $lines.AddRange([string[]](Get-Content -Path $httpdConf))
    for ($i = 0; $i -lt $lines.Count; $i++) {
        foreach ($module in 'proxy_module', 'proxy_http_module', 'ssl_module', 'socache_shmcb_module', 'headers_module') {
            if ($lines[$i] -match "^\s*#\s*(LoadModule\s+$module\s.*)$") { $lines[$i] = $Matches[1] }
        }
        if ($lines[$i] -match '^\s*#\s*(Include\s+"?conf/extra/httpd-ssl\.conf"?\s*)$') { $lines[$i] = $Matches[1] }
    }
    if (-not ($lines | Where-Object { $_ -match 'httpd-repo\.conf' })) {
        # Before XAMPP's own sites, so the system is the default site on 80 and 443
        $at = $lines.Count
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match '^\s*Include\s+"?conf/extra/httpd-(vhosts|ssl)\.conf') { $at = $i; break }
        }
        $lines.InsertRange($at, [string[]]@('# Equipment Repository (windows\https-setup.ps1)', 'Include "conf/extra/httpd-repo.conf"', ''))
    }
    [IO.File]::WriteAllLines($httpdConf, $lines)

    Invoke-Native $httpd -t
    if ($LASTEXITCODE -ne 0) {
        [IO.File]::WriteAllText($httpdConf, $original)
        Remove-Item $repoConf
        Fail 'Apache refused the settings (see above). httpd.conf was put back as it was.'
        exit 1
    }
    Ok "Apache settings: $repoConf  (httpd.conf before: httpd.conf.before-repo)"
    Set-Content -Path $proxyMarker -Encoding Ascii -Value 'XAMPP Apache forwards to 127.0.0.1:8000, where start-server.bat runs the system (written by https-setup.ps1).'
    Ok 'start-server.bat now runs the system on 127.0.0.1:8000, behind Apache.'

    $service = Get-Service -Name 'Apache2.4' -ErrorAction SilentlyContinue
    if ($service) {
        Restart-Service -Name 'Apache2.4'
        Ok 'Apache restarted (Windows service).'
    } else {
        Warn 'XAMPP Control Panel: Apache > Stop, then Start. It must turn green.'
        Warn 'Tip: tick the "Service" box next to Apache there, so it starts with Windows.'
        Read-Host '   Press Enter when Apache is green' | Out-Null
    }
    if (-not (Test-Url $systemUrl)) {
        Warn 'Now start the system: double-click start-server.bat and keep its window open.'
        Read-Host '   Press Enter when it runs' | Out-Null
    }
    if (Test-Url $systemUrl) { Ok 'The system runs on 127.0.0.1:8000.' } else { Fail 'The system does not answer on 127.0.0.1:8000 - is start-server.bat running?'; exit 1 }
} elseif (Test-Path 'C:\laragon') {
    Step "6. Laragon's Apache"
    $vhost = 'C:\laragon\etc\apache2\sites-enabled\00-repo.conf'
    if (-not (Test-Path $vhost) -or -not (Select-String -Path $vhost -Pattern 'SSLEngine' -Quiet)) {
        Warn "Copy windows\apache-vhost.conf to $vhost (it has the https part), then Laragon > Apache > Reload."
    } else {
        Ok "$vhost has the https part."
    }
} else {
    Step '6. Web server'
    Warn "Neither XAMPP ($Xampp) nor Laragon (C:\laragon) found. Use -Xampp <folder>, or set up https by hand with storage\https\repo.crt and repo.key."
}

# ---------------------------------------------------------------- 7. test
Step '7. Test'
if (Test-Url 'http://127.0.0.1/api/network/ping') { Ok 'The system answers on http (port 80).' } else { Warn 'No answer on http://127.0.0.1 (port 80).' }
if (Test-Url 'https://localhost/api/network/ping') {
    Ok 'The system answers on https (port 443).'
} else {
    Fail 'No answer on https://localhost. Check the steps above, then run this script again.'
    if (Test-Path 'C:\laragon') { Write-Host '        Laragon: Apache > SSL > Enabled, apache-vhost.conf copied, Apache > Reload.' }
    exit 1
}
if (Test-Url "$qrUrl/api/network/ping") {
    Ok "The system opens through $qrUrl on this laptop."
} else {
    Warn "$qrUrl does not open on this laptop itself (phones may still work - test them)."
}

# ---------------------------------------------------------------- 8. QR address
Step "8. QR address = $qrUrl"
# The same PHP 8.3+ the other scripts use (find-php.bat)
Push-Location $PSScriptRoot
$php = cmd /v:on /c "call find-php.bat >nul 2>&1 && echo !PHP!" | Select-Object -Last 1
Pop-Location
if (-not $php -or -not (Test-Path $php)) { Fail "PHP 8.3+ not found (run find-php.bat to see why) - set the QR address to $qrUrl on the QR codes page instead."; exit 1 }
& $php "$AppPath\artisan" repo:qr-address $qrUrl
if ($LASTEXITCODE -ne 0) {
    Warn 'Labels printed with the old address still open the system, but only while connected.'
    Warn 'For labels that open without a connection, the QR address must be https and the labels printed again.'
    $answer = Read-Host "   Type YES to change the QR address to $qrUrl"
    if ($answer -eq 'YES') {
        & $php "$AppPath\artisan" repo:qr-address $qrUrl "--confirm=$qrUrl"
    } else {
        Warn 'QR address not changed.'
    }
}
& $php "$AppPath\artisan" repo:qr-address

# ---------------------------------------------------------------- next
Step 'On EACH phone (once)'
Write-Host "   1. Connect to the hotspot and open  http://$hostName/offline" -ForegroundColor White
Write-Host '   2. Tap "Download the certificate" and install it:'
Write-Host '        iPhone : Settings > Profile Downloaded > Install, then'
Write-Host '                 Settings > General > About > Certificate Trust Settings > turn it ON'
Write-Host '        Android: Settings > Security > Encryption & credentials > Install a certificate > CA certificate'
Write-Host "   3. Open  $qrUrl/offline  (no warning must appear) > Download data"
Write-Host '   4. Test: turn Wi-Fi OFF, scan a label printed with https - the page must open.'
Write-Host '   Before each trip: open the Work offline page again and tap Update data.'
