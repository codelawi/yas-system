@echo off
REM Makes a backup now (database + original Word files) into the backup folder set in Settings.
setlocal
cd /d "%~dp0.."
call "%~dp0find-php.bat" || (pause & exit /b 1)
"%PHP%" artisan repo:backup --reason=manual
pause
