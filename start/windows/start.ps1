# Equipment Repository - starts everything. Run it with START.bat (double-click), not directly.
#   MySQL (XAMPP)  ->  https certificate for repo.local (and this PC's addresses)
#   ->  XAMPP Apache on http 80 + https 443  ->  the system (PHP 8.3+)
#   ->  check that https://repo.local works, and print QR labels with it
#   ->  the print station: an Edge window that prints issue vouchers by itself
# Phones open the system at https://repo.local on any hotspot, whatever IP this PC gets:
# Windows announces its computer name on the network (mDNS), so the PC must be called "repo"
# (hotspot-setup.ps1 renames it, once).
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
$Name      = 'repo'            # network name: https://repo.local (the same name as the Mac and the guide)
$IpPrefix  = '172.20.10.'      # preferred address to show (iPhone hotspot); any other IPv4 is used if missing
$SetQr     = $true             # print QR labels with https://repo.local (only when this PC is called repo)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Host.UI.RawUI.WindowTitle = 'Equipment Repository - keep this window open'
function Step($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "   [OK] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "   [!]  $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host "   [X]  $t" -ForegroundColor Red; Read-Host 'Press Enter to close' | Out-Null; exit 1 }
function Bad($t)  { Write-Host "   [X]  $t" -ForegroundColor Red }   # like Fail, but the system keeps running
# $rest must stay a list: with "$p, $rest = $args" a single argument (httpd -t) became a plain
# string, which @rest splatted wrongly - httpd printed its help, exit 1 = "Apache refused".
function Invoke-Native { $ErrorActionPreference = 'Continue'; $p = $args[0]; $rest = @($args | Select-Object -Skip 1); & $p @rest 2>&1 | ForEach-Object { "$_" } }
function Test-Url($u) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri $u | Out-Null; $true } catch { $false } }
function Test-Port($p) { [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) }
function Wait-For($what, $seconds, [scriptblock]$check) {
    for ($i = 0; $i -lt $seconds; $i++) { if (& $check) { return $true }; Start-Sleep -Seconds 1 }
    Fail "$what did not start within $seconds seconds."
}
# https to Apache on this PC, asking for $name the way a phone does: tests the certificate and
# that the system answers, even when this PC cannot look the name up itself.
# Returns Problem (why it fails, or $null), Trusted (this PC trusts the certificate).
function Test-Https($name) {
    $r = @{ Problem = $null; Trusted = $false }
    $tcp = New-Object Net.Sockets.TcpClient
    try {
        if (-not $tcp.ConnectAsync('127.0.0.1', 443).Wait(3000)) { $r.Problem = 'Apache does not answer on port 443.'; return $r }
        # The check below only records what Windows thinks of the certificate, and goes on
        $script:SslErrors = 0
        $keep = [Net.Security.RemoteCertificateValidationCallback] { param($s, $c, $ch, $e) $script:SslErrors = [int]$e; $true }
        $ssl = New-Object Net.Security.SslStream($tcp.GetStream(), $false, $keep)
        $ssl.ReadTimeout = 15000
        $ssl.AuthenticateAsClient($name, (New-Object Security.Cryptography.X509Certificates.X509CertificateCollection), [Security.Authentication.SslProtocols]::Tls12, $false)
        # SslPolicyErrors: 2 = the certificate is for another name, 4 = not signed by an authority this PC trusts
        if ($script:SslErrors -band 2) { $r.Problem = "The certificate Apache uses does not cover $name - run START.bat again."; return $r }
        $r.Trusted = -not ($script:SslErrors -band 4)
        $req = [Text.Encoding]::ASCII.GetBytes("GET /api/network/ping HTTP/1.1`r`nHost: $name`r`nConnection: close`r`n`r`n")
        $ssl.Write($req, 0, $req.Length)
        $ssl.Flush()
        $status = (New-Object IO.StreamReader $ssl).ReadLine()
        if ($status -notmatch '^HTTP/\S+\s+200\b') { $r.Problem = "Apache answered '$status' instead of the system (502/503 = the system does not run on 127.0.0.1:8000)." }
    } catch {
        $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
        $r.Problem = "https failed: $($e.Message)"
    } finally { $tcp.Close() }
    $r
}
# The IPv4 addresses a name leads to, looked up like a browser on this PC does (mDNS for .local)
function Resolve-Name($name) {
    try { @([Net.Dns]::GetHostAddresses($name) | Where-Object { $_.AddressFamily -eq 'InterNetwork' } | ForEach-Object { $_.IPAddressToString }) }
    catch { @() }
}

# ------------------------------------------------------------------ 1. PHP + network name + address
Step '1. PHP, network name and address'
Push-Location $Win
$Php = cmd /v:on /c "call `"$Win\find-php.bat`" >nul 2>&1 && echo !PHP!" | Select-Object -Last 1
Pop-Location
if (-not $Php -or -not (Test-Path $Php)) { Fail 'PHP 8.3+ not found - run start\windows\find-php.bat to see why.' }
Ok $Php
$PcName   = $env:COMPUTERNAME.ToLower()
$RepoHost = "$Name.local"
$RepoUrl  = "https://$RepoHost"
if ($PcName -eq $Name) { Ok "Network name: $RepoHost" }
else { Warn "This PC is called $PcName, so phones cannot open $RepoUrl. Run hotspot-setup.ps1 once as administrator (it renames the PC to $Name)." }
$mdns = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\Dnscache\Parameters' -Name EnableMDNS -ErrorAction SilentlyContinue).EnableMDNS
if ($mdns -eq 0) { Warn "mDNS is off: Windows does not announce $RepoHost to phones. Run hotspot-setup.ps1 once as administrator." }
$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress)
$Ip = ($ips | Where-Object { $_ -like "$IpPrefix*" } | Select-Object -First 1)
if (-not $Ip) { $Ip = $ips | Select-Object -First 1; if ($Ip) { Warn "No $IpPrefix* address - using $Ip" } }
if ($Ip) { Ok "Network address today: $Ip  (it may change, $RepoHost stays)" }
else { Warn 'Not connected to any network: only this PC can open the system. Connect to the hotspot / Wi-Fi.' }

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

$newCa = -not ((Test-Path $caKey) -and (Test-Path $caCrt))
if ($newCa) {
    @('[req]','distinguished_name = dn','x509_extensions = ext','prompt = no','[dn]','CN = Equipment Repository CA','O = Equipment Repository',
      '[ext]','basicConstraints = critical, CA:TRUE, pathlen:0','keyUsage = critical, keyCertSign, cRLSign','subjectKeyIdentifier = hash') |
        Set-Content -Encoding Ascii "$Https\ca.cnf"
    Invoke-OpenSsl req -x509 -new -nodes -newkey rsa:2048 -sha256 -days 3650 -keyout $caKey -out $caCrt -config "$Https\ca.cnf"
    Remove-Item "$Https\ca.cnf"
    Ok 'Created the certificate authority (phones install it once).'
}

# Names and addresses the certificate must cover (repo.local first: the address on the labels)
$names = @("DNS:$RepoHost", "DNS:$Name", 'DNS:localhost', "DNS:$PcName", "DNS:$PcName.local", 'IP:127.0.0.1', 'IP:192.168.137.1')
foreach ($a in $ips) { $names += "IP:$a" }
$names = @($names | Select-Object -Unique)
$needCert = $true
if (-not $newCa -and (Test-Path $crt) -and (Test-Path $key)) {
    $x = New-Object Security.Cryptography.X509Certificates.X509Certificate2 $crt
    # e.g. "DNS Name=repo.local, DNS Name=repo, ..., IP Address=172.20.10.2" (the words before "=" may be translated)
    $san = ($x.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | ForEach-Object { $_.Format($false) }) -join ', '
    # Made again when a name or today's address is missing (not for every other address: some
    # virtual network cards get a new one at each restart)
    $must = @($names | Where-Object { $_ -like 'DNS:*' }) + 'IP:127.0.0.1' + @($Ip | Where-Object { $_ } | ForEach-Object { "IP:$_" })
    $missing = @($must | Where-Object { $san -notmatch ('(^|[=:,\s])' + [regex]::Escape(($_ -split ':', 2)[1]) + '(,|\s|$)') })
    $needCert = ($x.NotAfter -lt (Get-Date).AddDays(30)) -or ($missing.Count -gt 0)
}
if ($needCert) {
    @('[req]','distinguished_name = dn','prompt = no','[dn]',"CN = $RepoHost",'[ext]','basicConstraints = critical, CA:FALSE',
      'keyUsage = critical, digitalSignature, keyEncipherment','extendedKeyUsage = serverAuth',"subjectAltName = $($names -join ', ')",
      'subjectKeyIdentifier = hash','authorityKeyIdentifier = keyid, issuer') | Set-Content -Encoding Ascii "$Https\repo.cnf"
    Invoke-OpenSsl req -new -nodes -newkey rsa:2048 -keyout $key -out "$Https\repo.csr" -config "$Https\repo.cnf"
    Invoke-OpenSsl x509 -req -in "$Https\repo.csr" -CA $caCrt -CAkey $caKey -CAcreateserial -out $crt -days 825 -sha256 -extfile "$Https\repo.cnf" -extensions ext
    Remove-Item "$Https\repo.csr", "$Https\repo.cnf"
    Ok "New certificate for: $($names -join ' ')"
} else { Ok "The certificate already covers $RepoHost and this PC's addresses." }

Copy-Item $caCrt "$App\public\repo-ca.crt" -Force
$caThumb = (New-Object Security.Cryptography.X509Certificates.X509Certificate2 $caCrt).Thumbprint
if (-not (Test-Path "Cert:\LocalMachine\Root\$caThumb") -and -not (Test-Path "Cert:\CurrentUser\Root\$caThumb")) {
    Warn 'Windows will ask to install the certificate - click YES.'
    try { Import-Certificate -FilePath $caCrt -CertStoreLocation Cert:\CurrentUser\Root -ErrorAction Stop | Out-Null; Ok 'This PC now trusts the certificate.' }
    catch { Warn 'Certificate not trusted on this PC (the browser shows a warning; the system still works).' }
}

# ------------------------------------------------------------------ 5. firewall (web ports, and UDP 5353 so phones can look up repo.local)
foreach ($r in @(
        @{ Name = 'Equipment Repository (port 80)'; Protocol = 'TCP'; Port = 80 },
        @{ Name = 'Equipment Repository (port 443)'; Protocol = 'TCP'; Port = 443 },
        @{ Name = 'Equipment Repository (name)'; Protocol = 'UDP'; Port = 5353 })) {   # the same rule hotspot-setup.ps1 makes
    if (-not (Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue)) {
        try { New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Protocol $r.Protocol -LocalPort $r.Port -Action Allow -Profile Any -ErrorAction Stop | Out-Null }
        catch { Warn "Firewall rule for $($r.Protocol) $($r.Port) needs an administrator - phones may not reach $RepoHost." }
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
Ok 'The system runs on 127.0.0.1:8000.'

# ------------------------------------------------------------------ 9. check https://repo.local
Step "7. Check $RepoUrl"
# a) Apache + certificate + the system, asked for repo.local the way a phone asks
$https = Test-Https $RepoHost
if ($https.Problem) { Bad $https.Problem } else {
    Ok "https for $RepoHost works: Apache, the certificate and the system."
    if (-not $https.Trusted) { Warn "This PC does not trust the certificate, so its browser warns (phones that installed it do not). Run START.bat again and click YES." }
}
# b) the name: this PC must be called repo, and repo.local must lead to this PC
$found = @(); $here = $false
if ($PcName -ne $Name) { Bad "This PC is called $PcName, not $Name - phones cannot find $RepoHost. Run hotspot-setup.ps1 once as administrator." } else {
    $found = @(Resolve-Name $RepoHost)
    $mine = @($ips) + '127.0.0.1'
    $here = [bool]($found | Where-Object { $mine -contains $_ })
    $others = @($found | Where-Object { $mine -notcontains $_ })
    if ($others) { Warn "$RepoHost also leads to $($others -join ', '), which is not this PC: is another device on this network called $Name? Phones may open it instead." }
    if ($here) { Ok "$RepoHost leads to this PC ($(@($found | Where-Object { $mine -contains $_ }) -join ', '))." }
    elseif (-not $others) { Warn "This PC could not look up $RepoHost itself. Phones usually still can: open $RepoUrl on a phone to be sure." }
}
if ($mdns -eq 0) { Bad "mDNS is off, so phones cannot look up $RepoHost. Run hotspot-setup.ps1 once as administrator." }
$repoReady = (-not $https.Problem) -and ($PcName -eq $Name) -and ($mdns -ne 0)
# c) QR labels print with https://repo.local
$qr = if (((Invoke-Native $Php artisan repo:qr-address) -join ' ') -match 'QR address: (\S+)') { $Matches[1] } else { '(unknown)' }
if ($qr -eq $RepoUrl) { Ok "QR labels print with $RepoUrl" }
elseif ($SetQr -and $PcName -eq $Name) {
    # Refused when labels were printed with the old address: they would stop opening
    $out = Invoke-Native $Php artisan repo:qr-address $RepoUrl
    if ($LASTEXITCODE -eq 0) { Ok "QR labels now print with $RepoUrl (before: $qr)" }
    else { Warn ($out -join ' '); Warn "QR labels still print with $qr - change it on the QR codes page if you want $RepoUrl." }
} else { Warn "QR labels print with $qr. Do not print labels until this PC is called $Name and they print with $RepoUrl." }
Pop-Location

# This PC's own browser: repo.local when this PC can look it up, otherwise localhost (same system)
$openUrl = if ($https.Problem) { 'http://localhost' } elseif ($here) { $RepoUrl } else { 'https://localhost' }
$phoneHost = if ($repoReady -or -not $Ip) { $RepoHost } else { $Ip }
$color = if ($repoReady) { 'Green' } else { 'Yellow' }
Write-Host ''
Write-Host '  ============================================================' -ForegroundColor $color
if ($repoReady) { Write-Host "    Phones and QR labels:  $RepoUrl" -ForegroundColor $color }
else { Write-Host "    $RepoUrl is NOT ready - see the [X] and [!] lines above." -ForegroundColor $color }
Write-Host "    On this PC:  $openUrl" -ForegroundColor $color
if ($Ip) { Write-Host "    Also:  https://$Ip   http://$Ip  (today's address, it may change)" -ForegroundColor $color }
Write-Host "    Phones, once: open http://$phoneHost/offline and install the certificate" -ForegroundColor $color
Write-Host '    Keep this window open. Close it to stop the system.' -ForegroundColor $color
Write-Host '  ============================================================' -ForegroundColor $color
Write-Host ''
Start-Process $openUrl

# ------------------------------------------------------------------ 10. print station
# Edge in its own profile with silent printing (--kiosk-printing): issue vouchers print on the
# default printer (with A5 paper in it) without a dialog. Opened now, and again whenever a phone
# asks for it (the system leaves a file for this window to see). Your own Edge is not touched.
Step '8. Print station'
$StationUrl = $null; $StationAsk = $null; $StationOpen = $false
foreach ($line in (Invoke-Native $Php "$App\artisan" repo:print-station)) {
    if ($line -match '^Print station: (\S+)') { $StationUrl = $Matches[1] }
    elseif ($line -match '^Open requests: (.+)$') { $StationAsk = $Matches[1].Trim() }
    elseif ($line -match '^Open now: yes') { $StationOpen = $true }
}
function Find-Edge {
    $paths = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe", "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe")
    $reg = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe' -ErrorAction SilentlyContinue).'(default)'
    @($paths + $reg) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
$Edge = Find-Edge
$EdgeProfile = Join-Path $App 'storage\app\print-station\edge'   # git ignores storage\app
function Open-Station {
    if (-not $Edge -or -not $StationUrl) { return $false }
    # One string: Windows PowerShell does not quote list items that contain spaces
    $edgeArgs = "--user-data-dir=`"$EdgeProfile`" --kiosk-printing --no-first-run --no-default-browser-check " +
        "--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --app=`"$StationUrl`""
    try { Start-Process -FilePath $Edge -ArgumentList $edgeArgs | Out-Null; $true } catch { $false }
}
if (-not $StationUrl) { Bad 'The print station address could not be read - vouchers will not print by themselves.' }
elseif (-not $Edge) { Bad 'Microsoft Edge was not found - vouchers will not print by themselves.' }
else {
    if ($StationAsk) { Remove-Item $StationAsk -Force -ErrorAction SilentlyContinue }
    if ($StationOpen) { Ok 'Already open in another window.' }
    elseif (Open-Station) { Ok 'Opened in Edge: vouchers print on the default printer (put A5 paper in it).' }
    else { Bad 'Edge did not start - vouchers will not print by themselves.' }
}

# Keep running while the system runs; open the print station again when a phone asks for it
while (-not $server.HasExited) {
    if ($StationAsk -and (Test-Path $StationAsk)) {
        Remove-Item $StationAsk -Force -ErrorAction SilentlyContinue
        if (Open-Station) { Write-Host "   [OK] $(Get-Date -Format HH:mm) Print station opened (asked from a phone)." -ForegroundColor Green }
    }
    Start-Sleep -Seconds 1
}
