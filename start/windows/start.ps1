# Equipment Repository - starts everything. Run it with START.bat (double-click), not directly.
#   MySQL (XAMPP)  ->  https certificate for this PC's network address
#   ->  XAMPP Apache on http 80 + https 443  ->  the system (PHP 8.3+)
# Keep the window open while the system is used. Closing it stops the system.
#
# This is a normal .ps1 file on purpose. START.bat used to be a batch/PowerShell hybrid that
# read itself and ran the text with "iex"; Windows Defender blocks that pattern as malicious
# ("ScriptContainedMaliciousContent").
# ------------------------------------------------------------------ settings
$Xampp     = 'C:\xampp'
$Root      = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # the system folder, two levels above this start\windows folder
$App       = Join-Path $Root 'backend'
$Win       = $PSScriptRoot
$Https     = Join-Path $App 'storage\https'
$IpPrefix  = '172.20.10.'      # preferred network (phone hotspot); any other IPv4 is used if missing
$SetQr     = $true             # print QR labels with https://<this IP>

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Host.UI.RawUI.WindowTitle = 'Equipment Repository - keep this window open'
function Step($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "   [OK] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "   [!]  $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host "   [X]  $t" -ForegroundColor Red; Read-Host 'Press Enter to close' | Out-Null; exit 1 }
# $rest must stay a list: with "$p, $rest = $args" a single argument (httpd -t) became a plain
# string, which @rest splatted wrongly - httpd printed its help, exit 1 = "Apache refused".
function Invoke-Native { $ErrorActionPreference = 'Continue'; $p = $args[0]; $rest = @($args | Select-Object -Skip 1); & $p @rest 2>&1 | ForEach-Object { "$_" } }
function Test-Url($u) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri $u | Out-Null; $true } catch { $false } }
function Test-Port($p) { [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) }
function Wait-For($what, $seconds, [scriptblock]$check) {
    for ($i = 0; $i -lt $seconds; $i++) { if (& $check) { return $true }; Start-Sleep -Seconds 1 }
    Fail "$what did not start within $seconds seconds."
}

# ------------------------------------------------------------------ 1. PHP + network address
Step '1. PHP and network address'
Push-Location $Win
$Php = cmd /v:on /c "call `"$Win\find-php.bat`" >nul 2>&1 && echo !PHP!" | Select-Object -Last 1
Pop-Location
if (-not $Php -or -not (Test-Path $Php)) { Fail 'PHP 8.3+ not found - run start\windows\find-php.bat to see why.' }
Ok $Php
$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress)
$Ip = ($ips | Where-Object { $_ -like "$IpPrefix*" } | Select-Object -First 1)
if (-not $Ip) { $Ip = $ips | Select-Object -First 1; if ($Ip) { Warn "No $IpPrefix* address - using $Ip" } }
if (-not $Ip) { Fail 'No network address. Connect to the network / hotspot first.' }
Ok "Network address: $Ip"

# ------------------------------------------------------------------ 2. stop old copies of the system
Get-CimInstance Win32_Process -Filter "name='php.exe'" |
    Where-Object { $_.CommandLine -match 'artisan"?\s+serve|resources[\\/]server\.php' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# ------------------------------------------------------------------ 3. MySQL
Step '2. MySQL'
if (Test-Port 3306) { Ok 'Already running.' } else {
    $svc = Get-Service -Name mysql -ErrorAction SilentlyContinue
    if ($svc) { Start-Service mysql } else {
        Start-Process -WindowStyle Hidden -FilePath "$Xampp\mysql\bin\mysqld.exe" -ArgumentList "--defaults-file=$Xampp\mysql\bin\my.ini", '--standalone' -WorkingDirectory $Xampp
    }
    Wait-For 'MySQL' 30 { Test-Port 3306 } | Out-Null
    Ok 'Started.'
}

# ------------------------------------------------------------------ 4. https certificate
Step '3. https certificate'
$openssl = "$Xampp\apache\bin\openssl.exe"
if (-not (Test-Path $openssl)) { Fail "$openssl not found." }
New-Item -ItemType Directory -Force -Path $Https | Out-Null
$caKey = "$Https\repo-ca.key"; $caCrt = "$Https\repo-ca.crt"; $key = "$Https\repo.key"; $crt = "$Https\repo.crt"
$env:OPENSSL_CONF = ''   # XAMPP's openssl.cnf path is often wrong; our own config is passed each time
function Invoke-OpenSsl { $out = Invoke-Native $openssl @args; if ($LASTEXITCODE -ne 0) { $out; Fail "openssl $($args[0]) failed." } }

if (-not ((Test-Path $caKey) -and (Test-Path $caCrt))) {
    @('[req]','distinguished_name = dn','x509_extensions = ext','prompt = no','[dn]','CN = Equipment Repository CA','O = Equipment Repository',
      '[ext]','basicConstraints = critical, CA:TRUE, pathlen:0','keyUsage = critical, keyCertSign, cRLSign','subjectKeyIdentifier = hash') |
        Set-Content -Encoding Ascii "$Https\ca.cnf"
    Invoke-OpenSsl req -x509 -new -nodes -newkey rsa:2048 -sha256 -days 3650 -keyout $caKey -out $caCrt -config "$Https\ca.cnf"
    Remove-Item "$Https\ca.cnf"
    Ok 'Created the certificate authority (phones install it once).'
}

$needCert = $true
if ((Test-Path $crt) -and (Test-Path $key)) {
    $x = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $crt
    $san = ($x.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | ForEach-Object { $_.Format($false) }) -join ' '
    $needCert = ($x.NotAfter -lt (Get-Date).AddDays(30)) -or ($san -notmatch ([regex]::Escape($Ip) + '\b'))
}
if ($needCert) {
    $names = @('DNS:repo.local', 'DNS:repo', 'DNS:localhost', "DNS:$($env:COMPUTERNAME.ToLower())", "DNS:$($env:COMPUTERNAME.ToLower()).local", 'IP:127.0.0.1', 'IP:192.168.137.1')
    foreach ($a in $ips) { if ($names -notcontains "IP:$a") { $names += "IP:$a" } }
    @('[req]','distinguished_name = dn','prompt = no','[dn]',"CN = $Ip",'[ext]','basicConstraints = critical, CA:FALSE',
      'keyUsage = critical, digitalSignature, keyEncipherment','extendedKeyUsage = serverAuth',"subjectAltName = $($names -join ', ')",
      'subjectKeyIdentifier = hash','authorityKeyIdentifier = keyid, issuer') | Set-Content -Encoding Ascii "$Https\repo.cnf"
    Invoke-OpenSsl req -new -nodes -newkey rsa:2048 -keyout $key -out "$Https\repo.csr" -config "$Https\repo.cnf"
    Invoke-OpenSsl x509 -req -in "$Https\repo.csr" -CA $caCrt -CAkey $caKey -CAcreateserial -out $crt -days 825 -sha256 -extfile "$Https\repo.cnf" -extensions ext
    Remove-Item "$Https\repo.csr", "$Https\repo.cnf"
    Ok "New certificate for: $($names -join ' ')"
} else { Ok "Certificate already covers $Ip" }

Copy-Item $caCrt "$App\public\repo-ca.crt" -Force
$caThumb = (New-Object Security.Cryptography.X509Certificates.X509Certificate2 $caCrt).Thumbprint
if (-not (Test-Path "Cert:\LocalMachine\Root\$caThumb") -and -not (Test-Path "Cert:\CurrentUser\Root\$caThumb")) {
    Warn 'Windows will ask to install the certificate - click YES.'
    try { Import-Certificate -FilePath $caCrt -CertStoreLocation Cert:\CurrentUser\Root -ErrorAction Stop | Out-Null; Ok 'This PC now trusts the certificate.' }
    catch { Warn 'Certificate not trusted on this PC (the browser shows a warning; the system still works).' }
}

# ------------------------------------------------------------------ 5. firewall
foreach ($p in 80, 443) {
    $rule = "Equipment Repository (port $p)"
    if (-not (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue)) {
        try { New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $p -Action Allow -Profile Any -ErrorAction Stop | Out-Null }
        catch { Warn "Firewall rule for port $p needs an administrator - phones may not reach this PC." }
    }
}

# ------------------------------------------------------------------ 6. Apache (http 80 + https 443 -> system on 127.0.0.1:8000)
Step '4. Apache (http + https)'
$httpdConf = "$Xampp\apache\conf\httpd.conf"
$repoConf  = "$Xampp\apache\conf\extra\httpd-repo.conf"
$httpd     = "$Xampp\apache\bin\httpd.exe"
if (-not (Test-Path $httpdConf)) { Fail "$httpdConf not found." }
$wantRepo = (Get-Content -Raw "$Win\apache-proxy.conf").Replace('__APP__', ($App -replace '\\', '/'))
$oldRepo = if (Test-Path $repoConf) { [IO.File]::ReadAllText($repoConf) } else { $null }
$original = [IO.File]::ReadAllText($httpdConf)
$lines = New-Object 'System.Collections.Generic.List[string]'
$lines.AddRange([string[]](Get-Content $httpdConf))
for ($i = 0; $i -lt $lines.Count; $i++) {
    foreach ($m in 'proxy_module', 'proxy_http_module', 'ssl_module', 'socache_shmcb_module', 'headers_module') {
        if ($lines[$i] -match "^\s*#\s*(LoadModule\s+$m\s.*)$") { $lines[$i] = $Matches[1] }
    }
    if ($lines[$i] -match '^\s*#\s*(Include\s+"?conf/extra/httpd-ssl\.conf"?\s*)$') { $lines[$i] = $Matches[1] }
}
if (-not ($lines | Where-Object { $_ -match 'httpd-repo\.conf' })) {
    $at = $lines.Count
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*Include\s+"?conf/extra/httpd-(vhosts|ssl)\.conf') { $at = $i; break } }
    $lines.InsertRange($at, [string[]]@('# Equipment Repository (START.bat)', 'Include "conf/extra/httpd-repo.conf"', ''))
}
$newConf = ($lines -join "`r`n") + "`r`n"
$changed = ($newConf -ne $original) -or ($oldRepo -ne $wantRepo) -or $needCert
if ($changed) {
    if (-not (Test-Path "$httpdConf.before-repo")) { Copy-Item $httpdConf "$httpdConf.before-repo" }
    [IO.File]::WriteAllText($repoConf, $wantRepo)
    [IO.File]::WriteAllText($httpdConf, $newConf)
    $test = Invoke-Native $httpd -t
    if ($LASTEXITCODE -ne 0) {
        [IO.File]::WriteAllText($httpdConf, $original)
        if ($oldRepo) { [IO.File]::WriteAllText($repoConf, $oldRepo) } else { Remove-Item $repoConf }
        $test; Fail 'Apache refused the settings (see above) - httpd.conf put back as it was.'
    }
    Ok 'Apache settings updated.'
}
# start-server.bat / https-setup.ps1 use this marker too
Set-Content -Path "$Https\apache-proxy.txt" -Encoding Ascii -Value 'XAMPP Apache forwards to 127.0.0.1:8000 (written by START.bat).'

$svc = Get-Service -Name 'Apache2.4' -ErrorAction SilentlyContinue
$running = (Get-Process httpd -ErrorAction SilentlyContinue) -and (Test-Port 443)
if ($svc) {
    if ($changed -or $svc.Status -ne 'Running') { Restart-Service 'Apache2.4' -Force }
} elseif ($changed -or -not $running) {
    $others = @(Get-NetTCPConnection -State Listen -LocalPort 80, 443 -ErrorAction SilentlyContinue |
        ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } |
        Where-Object { $_ -and $_ -ne 'httpd' } | Select-Object -Unique)
    if ($others) { Fail "Port 80/443 is used by: $($others -join ', '). Close it and run START.bat again." }
    Get-Process httpd -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1
    Start-Process -WindowStyle Hidden -FilePath $httpd -WorkingDirectory "$Xampp\apache"
}
Wait-For 'Apache' 20 { (Test-Port 80) -and (Test-Port 443) } | Out-Null
Ok 'Apache answers on ports 80 and 443.'

# ------------------------------------------------------------------ 7. database changes (only adds, never deletes)
Step '5. Database'
Push-Location $App
$mig = Invoke-Native $Php artisan migrate --force
if ($LASTEXITCODE -ne 0) { $mig; Pop-Location; Fail 'Database step failed - check the DB_ lines in backend\.env.' }
Ok 'Up to date.'

# ------------------------------------------------------------------ 8. the system
Step '6. Starting the system'
$server = Start-Process -NoNewWindow -PassThru -FilePath $Php -ArgumentList 'artisan', 'serve', '--host=127.0.0.1', '--port=8000' -WorkingDirectory $App
Wait-For 'The system' 30 { Test-Url 'http://127.0.0.1:8000/api/network/ping' } | Out-Null
$url = "https://$Ip"
if (Test-Url "$url/api/network/ping") { Ok "$url works." } else { Warn "$url did not answer the test - check the steps above." }

if ($SetQr) {
    $qr = Invoke-Native $Php artisan repo:qr-address $url
    if ($LASTEXITCODE -eq 0) { Ok "QR labels print with $url" }
    else { Warn ($qr -join ' '); Warn 'QR address not changed (change it on the Network page if you want).' }
}
Pop-Location

Write-Host ''
Write-Host '  ============================================================' -ForegroundColor Green
Write-Host "    Open:  $url" -ForegroundColor Green
Write-Host "    Also:  http://$Ip   https://localhost" -ForegroundColor Green
Write-Host "    Phones, once: open http://$Ip/repo-ca.crt and install/trust it" -ForegroundColor Green
Write-Host '    Keep this window open. Close it to stop the system.' -ForegroundColor Green
Write-Host '  ============================================================' -ForegroundColor Green
Write-Host ''
Start-Process $url
Wait-Process -Id $server.Id
