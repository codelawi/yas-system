@echo off
REM First-time setup. Safe to run again: it never deletes or re-creates data.
setlocal
cd /d "%~dp0.."
call "%~dp0find-php.bat" || (pause & exit /b 1)
echo Using %PHP%

if not exist .env (
  copy .env.production.example .env >nul
  echo.
  echo Created .env - check the DB_ lines in Notepad, save, close Notepad, then run setup.bat again.
  notepad .env
  pause
  exit /b 0
)

REM Only create the key once (it must stay the same afterwards)
findstr /r /c:"^APP_KEY=base64:" .env >nul || "%PHP%" artisan key:generate --force

REM "migrate" only ADDS missing tables/columns. Never use migrate:fresh here.
"%PHP%" artisan migrate --force || (echo [!] Database step failed - is MySQL running, and are the DB_ lines in .env right? & pause & exit /b 1)
REM Creates the first admin (PIN 1234) only when there is no admin yet
"%PHP%" artisan db:seed --force
"%PHP%" artisan config:cache
"%PHP%" artisan route:cache
"%PHP%" artisan repo:backup --reason=after-setup

echo.
echo Done. Now double-click start-server.bat, then open http://localhost
echo First PIN: 1234 (change it on the Users page).
pause
