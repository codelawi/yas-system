@echo off
REM ==========================================================================
REM  Equipment Repository - ONE file that starts everything (double-click it).
REM    MySQL (XAMPP)  ->  https certificate for this PC's network address
REM    ->  XAMPP Apache on http 80 + https 443  ->  the system (PHP 8.3+)
REM  Keep this window open while the system is used. Closing it stops the system.
REM  The steps are in start\windows\start.ps1.
REM ==========================================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start\windows\start.ps1"
echo.
echo The system stopped.
pause