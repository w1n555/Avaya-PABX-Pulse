@echo off
REM Portable: skip if port already LISTENING, else start cdr_logger.py detached.
REM Args: [port] [bind]   defaults 9000  0.0.0.0
REM Do NOT taskkill. Paths are relative to this script (any install root).
setlocal EnableExtensions
set "DIR=%~dp0"
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"
set "SITE=%DIR%\.."
set "PORT=9000"
if not "%~1"=="" set "PORT=%~1"
set "BIND=0.0.0.0"
if not "%~2"=="" set "BIND=%~2"

set "PY=%SITE%\python\.venv\Scripts\pythonw.exe"
if not exist "%PY%" set "PY=%SITE%\python\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

netstat -ano | findstr /C:":%PORT% " >nul
if errorlevel 1 goto START
netstat -ano | findstr /C:":%PORT% " | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo CDR logger already listening on :%PORT%
  endlocal
  exit /b 0
)

:START
if not exist "%DIR%\cdr" mkdir "%DIR%\cdr"
if not exist "%DIR%\logs" mkdir "%DIR%\logs"
start "CM-CDR-Logger" /B "%PY%" "%DIR%\cdr_logger.py" --host %BIND% --port %PORT% --log-dir "%DIR%\cdr"
endlocal
exit /b 0
