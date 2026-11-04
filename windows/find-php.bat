@echo off
REM Finds PHP (8.3 or newer) and puts its path in %PHP%. Used by the other scripts.
REM Looks in the PATH first ("where php"), then C:\php and C:\Program Files\PHP.
REM PHP somewhere else? Add its folder to PATH, or type this before running a script:
REM     set PHP=D:\tools\php\php.exe
if defined PHP if exist "%PHP%" goto check
set "PHP="
for /f "delims=" %%P in ('where php 2^>nul') do if not defined PHP set "PHP=%%P"
if not defined PHP for /d %%D in ("C:\php*" "C:\Program Files\PHP\*") do if exist "%%D\php.exe" set "PHP=%%D\php.exe"
if not defined PHP (
  echo [!] PHP not found.
  echo     Add the PHP folder to PATH - check: open a NEW Command Prompt and type  php -v
  echo     or type  set PHP=C:\path\to\php.exe  and run the script again in the same window.
  exit /b 1
)

:check
"%PHP%" -r "exit(version_compare(PHP_VERSION, '8.3.0', '<') ? 1 : 0);"
if errorlevel 1 (
  echo [!] %PHP% is older than PHP 8.3. Install PHP 8.3 or newer.
  exit /b 1
)
REM The extensions the system needs (zip: backups and Word/Excel forms)
"%PHP%" -r "$m = array_filter(['pdo_mysql', 'mbstring', 'zip', 'fileinfo', 'openssl'], fn ($e) => ! extension_loaded($e)); if ($m) { echo '[!] PHP extensions missing: '.implode(', ', $m).PHP_EOL.'    php.ini: '.(php_ini_loaded_file() ?: 'NONE - copy php.ini-production to php.ini in the PHP folder').PHP_EOL.'    In php.ini remove the ; before  extension=pdo_mysql  extension=mbstring  extension=zip  extension=fileinfo  extension=openssl'.PHP_EOL; exit(1); }"
if errorlevel 1 exit /b 1
exit /b 0
