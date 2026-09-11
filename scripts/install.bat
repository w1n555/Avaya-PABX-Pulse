@echo off
REM Avaya PABX Pulse — run as Administrator.
REM Bypasses Windows "running scripts is disabled" so you do not need -ExecutionPolicy.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %ERRORLEVEL%
