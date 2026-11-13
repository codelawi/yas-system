<#
  Equipment Repository - HTTPS, so phones can keep the data and open labels WITHOUT a connection.
  Phones keep a website for offline use only when it is https. This script:
    1. finds OpenSSL (it comes with Laragon's Apache)
    2. creates the system's own certificate authority - ONCE (phones trust it once)
    3. creates the https certificate for repo.local, repo, localhost and the laptop's addresses
    4. puts the authority at  http://repo.local/repo-ca.crt  so phones can install it
    5. trusts it on this laptop and opens port 443 in the firewall
    6. tests https and sets the QR address to  https://repo.local

  Before running it:
    - Laragon menu > Apache > SSL > Enabled
    - copy apache-vhost.conf again to C:\laragon\etc\apache2\sites-enabled\00-repo.conf
      (it has an https part that starts once the certificate exists)

  Run in PowerShell AS ADMINISTRATOR, from the windows folder:

    powershell -ExecutionPolicy Bypass -File .\https-setup.ps1

  -Name     Computer name (default: repo  ->  https://repo.local)
  -AppPath  System folder (default: the folder above this windows folder)

  Safe to run again: the authority is kept (phones keep trusting it) and the certificate is
  made again with today's addresses. Run it again before the date it prints (about 2 years).
  The files are in storage\https - keep a copy of that folder with the backups:
  a new laptop with the same authority needs nothing new on the phones.
#>
#Requires -RunAsAdministrator
param(
    [string]$Name = 'repo',
    [string]$AppPath = ''
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
    $found = @(Get-ChildItem -Path 'C:\laragon\bin\apache\*\bin\openssl.exe', 'C:\laragon\bin\git\usr\bin\openssl.exe', 'C:\Program Files\Git\usr\bin\openssl.exe' -ErrorAction SilentlyContinue)
    if ($found.Count -gt 0) { $openssl = $found[0].FullName }
}
if (-not $openssl) {
    Fail 'openssl.exe not found. It comes with Laragon (C:\laragon\bin\apache\...\bin) and with Git for Windows.'
    exit 1
}
Ok $openssl

function Invoke-OpenSsl {
    & $openssl @args
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

# ---------------------------------------------------------------- 6. test + QR address
Step '6. Test'
$vhost = 'C:\laragon\etc\apache2\sites-enabled\00-repo.conf'
if ((Test-Path $vhost) -and -not (Select-String -Path $vhost -Pattern 'SSLEngine' -Quiet)) {
    Warn "$vhost has no https part: copy windows\apache-vhost.conf over it again."
}
try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri 'https://localhost/api/network/ping' | Out-Null
    Ok 'The system answers on https.'
} catch {
    Fail 'No answer on https://localhost. Check, then run this script again:'
    Write-Host '        - Laragon menu > Apache > SSL > Enabled'
    Write-Host '        - windows\apache-vhost.conf copied to C:\laragon\etc\apache2\sites-enabled\00-repo.conf'
    Write-Host '        - Laragon menu > Apache > Reload (Apache must stay green)'
    exit 1
}
try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri "$qrUrl/api/network/ping" | Out-Null
    Ok "The system opens through $qrUrl on this laptop."
} catch {
    Warn "$qrUrl does not open on this laptop itself (phones may still work - test them)."
}

Step "7. QR address = $qrUrl"
$php = $null
if ($env:PHP -and (Test-Path $env:PHP)) { $php = $env:PHP }
if (-not $php) { $cmd = Get-Command php -ErrorAction SilentlyContinue; if ($cmd) { $php = $cmd.Source } }
if (-not $php) { $found = @(Get-ChildItem -Path 'C:\laragon\bin\php\*\php.exe' -ErrorAction SilentlyContinue | Sort-Object FullName); if ($found.Count -gt 0) { $php = $found[-1].FullName } }
if (-not $php) { Fail "PHP not found - set the QR address to $qrUrl on the QR codes page instead."; exit 1 }
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
