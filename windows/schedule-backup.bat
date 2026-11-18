@echo off
REM Adds a Windows scheduled task: a backup every day at 14:00, even if nobody uses the system that day.
REM (The system also backs up by itself once a day while it is being used.)
setlocal
cd /d "%~dp0..\backend"
call "%~dp0find-php.bat" || (pause & exit /b 1)
schtasks /create /f /tn "Equipment Repository Backup" /sc daily /st 14:00 /tr "\"%PHP%\" \"%CD%\artisan\" repo:backup --reason=scheduled"
echo.
echo Scheduled. Check it in Task Scheduler: "Equipment Repository Backup".
pause
