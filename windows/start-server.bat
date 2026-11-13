@echo off
REM Runs the system with PHP's own web server (no Apache / IIS needed).
REM Keep this window open while the system is used - closing it stops the system.
REM Port 80 = the address has no port (http://repo.local). Port 80 busy? Change PORT below,
REM but do it BEFORE printing labels: the port becomes part of the QR address.
setlocal
cd /d "%~dp0.."
call "%~dp0find-php.bat" || (pause & exit /b 1)
set "HOST=0.0.0.0"
set "PORT=80"
REM After https-setup.ps1 with XAMPP: XAMPP's Apache answers phones on port 80 (http) and
REM 443 (https) and forwards here, so this window serves this PC only, on port 8000.
if exist "storage\https\apache-proxy.txt" (
  set "HOST=127.0.0.1"
  set "PORT=8000"
)

echo Starting the system on %HOST%:%PORT% ...
if "%PORT%"=="8000" (
  echo   Behind XAMPP's Apache - keep Apache running ^(green^) in the XAMPP Control Panel.
  echo   Phones:      http://^<this PC's name^>.local  and  https://^<this PC's name^>.local
) else (
  echo   On this PC:  http://localhost
  echo   Phones:      http://^<this PC's name^>.local  or  http://^<this PC's IP^>
)
echo Keep this window open.
"%PHP%" artisan serve --host=%HOST% --port=%PORT%
echo.
echo [!] The system stopped. If it says the port is in use, another program uses port %PORT%.
pause
