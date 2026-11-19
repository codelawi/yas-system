@echo off
REM Run after copying a NEW VERSION of the system over the old one.
REM Keep your .env and the storage folder when copying. A backup is made first.
setlocal
cd /d "%~dp0..\..\backend"
call "%~dp0find-php.bat" || (pause & exit /b 1)

"%PHP%" artisan repo:backup --reason=before-update || (echo [!] Backup failed - update stopped, nothing was changed. & pause & exit /b 1)
"%PHP%" artisan optimize:clear
"%PHP%" artisan migrate --force || (echo [!] Database update failed. Your data is in the backup above. & pause & exit /b 1)
"%PHP%" artisan config:cache
"%PHP%" artisan route:cache

echo.
echo Update done.
pause
