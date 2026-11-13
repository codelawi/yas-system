<#
  Equipment Repository - setup for a laptop that joins PHONE HOTSPOTS (no router).
  The QR codes get the laptop's own name  http://repo.local  which follows the laptop on
  ANY hotspot, whatever IP it receives (Windows announces its name with mDNS).

  Run in PowerShell AS ADMINISTRATOR, from the windows folder:

    powershell -ExecutionPolicy Bypass -File .\hotspot-setup.ps1

  -Name     Computer name to use (default: repo  ->  http://repo.local)
  -Port     Web port (default 80)
  -AppPath  System folder (default: the folder above this windows folder)

  Run it, restart when asked, then run it again: everything must be [OK].
#>
#Requires -RunAsAdministrator
param(
    [string]$Name = 'repo',
    [int]$Port = 80,
    [string]$AppPath = ''
)
if (-not $AppPath) { $AppPath = Split-Path -Parent $PSScriptRoot }

$ErrorActionPreference = 'Stop'
function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "   [OK] $text" -ForegroundColor Green }
function Warn($text) { Write-Host "   [!]  $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "   [X]  $text" -ForegroundColor Red }

$Name = $Name.ToLower()
$portPart = ''
if ($Port -ne 80) { $portPart = ":$Port" }
$qrUrl = "http://$Name.local$portPart"
$needRestart = $false

# ---------------------------------------------------------------- 1. computer name
Step "1. Computer name = $Name"
if ($env:COMPUTERNAME.ToLower() -eq $Name) {
    Ok "This laptop is already called $Name  ->  $Name.local"
} else {
    Warn "This laptop is called $($env:COMPUTERNAME). It will be renamed to $Name (needs a restart)."
    $answer = Read-Host '   Type YES to rename'
    if ($answer -eq 'YES') {
        Rename-Computer -NewName $Name -Force
        Ok "Renamed to $Name."
        $needRestart = $true
    } else {
        Fail 'Not renamed. The QR address needs this name - stopping.'
        exit 1
    }
}

# ---------------------------------------------------------------- 2. mDNS on
Step '2. Name announcement (mDNS)'
$dnsParams = 'HKLM:\SYSTEM\CurrentControlSet\Services\Dnscache\Parameters'
$current = (Get-ItemProperty -Path $dnsParams -Name EnableMDNS -ErrorAction SilentlyContinue).EnableMDNS
if ($current -eq 0) {
    Set-ItemProperty -Path $dnsParams -Name EnableMDNS -Value 1 -Type DWord
    Ok 'mDNS was turned off - turned it back on.'
    $needRestart = $true
} else {
    Ok 'mDNS is on.'
}

# ---------------------------------------------------------------- 3. firewall on EVERY network
Step '3. Firewall (all networks - every new hotspot counts as a new network)'
foreach ($rule in @(
        @{ Name = 'Equipment Repository (web)'; Protocol = 'TCP'; Port = $Port },
        @{ Name = 'Equipment Repository (name)'; Protocol = 'UDP'; Port = 5353 })) {
    Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Protocol $rule.Protocol -LocalPort $rule.Port -Action Allow -Profile Any | Out-Null
    Ok "$($rule.Protocol) $($rule.Port) allowed on every network."
}
# The old rule from network-setup.ps1 is replaced by the ones above
Get-NetFirewallRule -DisplayName 'Equipment Repository' -ErrorAction SilentlyContinue | Remove-NetFirewallRule

# ---------------------------------------------------------------- 4. never sleep
Step '4. Power'
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
Ok 'No sleep / hibernate on mains power. (Keep the laptop plugged in.)'

if ($needRestart) {
    Step 'Restart needed'
    Warn 'Restart the laptop, run start-server.bat, connect to a hotspot, then run this script again.'
    exit 0
}

# ---------------------------------------------------------------- 5. system + name test
Step '5. Test'
$cfg = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
if ($cfg) {
    Ok "Connected: $($cfg.InterfaceAlias) - today's IP $(($cfg.IPv4Address | Select-Object -First 1).IPAddress) (it may change, the name stays)"
} else {
    Warn 'Not connected to any hotspot right now - connect one to test from a phone.'
}
try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri "http://127.0.0.1$portPart/api/network/ping" | Out-Null
    Ok "The system answers on port $Port."
} catch {
    Fail "The system does not answer on http://127.0.0.1$portPart - run start-server.bat (keep it open) and run this again."
    exit 1
}
try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri "$qrUrl/api/network/ping" | Out-Null
    Ok "The system opens through $qrUrl on this laptop."
} catch {
    Warn "$qrUrl does not open on this laptop itself (phones may still work - test them)."
}

# ---------------------------------------------------------------- 6. QR address
# After https-setup.ps1 the labels use https (needed to open them without a connection): keep it
if (Test-Path (Join-Path $AppPath 'storage\https\repo.crt')) { $qrUrl = "https://$Name.local" }
Step "6. QR address = $qrUrl"
# The same PHP 8.3+ the other scripts use (find-php.bat: PATH, C:\php, Program Files\PHP)
Push-Location $PSScriptRoot
$php = cmd /v:on /c "call find-php.bat >nul 2>&1 && echo !PHP!" | Select-Object -Last 1
Pop-Location
if (-not $php -or -not (Test-Path $php)) { Fail 'PHP 8.3+ not found (run find-php.bat to see why) - set the QR address on the Network page instead.'; exit 1 }
& $php "$AppPath\artisan" repo:qr-address $qrUrl
if ($LASTEXITCODE -eq 0) { & $php "$AppPath\artisan" repo:qr-address } else { Fail 'The QR address was not changed (see above).' }

# ---------------------------------------------------------------- next
Step 'Before printing - test with REAL phones'
Write-Host "   On each phone open:  $qrUrl" -ForegroundColor White
Write-Host '   Test 1: the phone that SHARES the hotspot (iPhone and Android)'
Write-Host '   Test 2: another phone CONNECTED to the same hotspot'
Write-Host '   Test 3: switch to a different phone hotspot - the same address must still open'
Write-Host '   All OK -> print ONE label, scan it, then print all.'
Write-Host '   An Android fails? See START-HERE.txt, PLAN B (laptop hotspot, fixed 192.168.137.1).'
