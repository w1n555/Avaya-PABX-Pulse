@echo off
REM Durable OSSI bridge starter ??? uses site-local Python only (IIS-safe)
setlocal EnableExtensions
set "SITE=C:\inetpub\wwwroot\CM"
set "PYTHONPATH=%SITE%\vendor\avaya-ossi\src"
set "PYTHONUNBUFFERED=1"

REM Site venv (created by install.bat from system Python)
set "PY=%SITE%\python\.venv\Scripts\python.exe"
if not exist "%PY%" (
  echo ERROR: No site venv. Run scripts\install.bat first (uses system Python 3.11+).
  exit /b 1
)

REM Must match api\appsettings.json OssiBridge:BaseUrl (default 18776 + data_live)
set "PORT=18776"
set "DATA=%SITE%\data_live"
if not "%~1"=="" set "PORT=%~1"
if not "%~2"=="" (
  REM 2nd arg: leaf under SITE (data / data_live) or absolute path
  echo %~2| findstr /R "^[A-Za-z]:\\.*" >nul
  if errorlevel 1 (set "DATA=%SITE%\%~2") else (set "DATA=%~2")
)
if not exist "%DATA%" mkdir "%DATA%"

cd /d "%SITE%\python"

REM If health already OK, do not start a second process (prevents multi-bridge desync)
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200 -and $r.Content -match 'ossi-bridge') { exit 0 } else { exit 1 } } catch { exit 1 }"
if not errorlevel 1 (
  echo OSSI bridge already healthy on :%PORT%
  endlocal
  exit /b 0
)

REM Drop stale locks from crashed instances
if exist "%DATA%\ossi_bridge_%PORT%.lock" del /f /q "%DATA%\ossi_bridge_%PORT%.lock" >nul 2>&1

REM start: first quoted token is window title
start "CM-OSSI-Bridge" /B "%PY%" "%SITE%\python\ossi_service.py" --host 0.0.0.0 --port %PORT% --data-dir "%DATA%"
endlocal
exit /b 0

