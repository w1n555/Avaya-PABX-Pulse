@echo off
REM Start Avaya CDR logger — CM pushes to this host:9000
setlocal
set "DIR=C:\inetpub\wwwroot\CM\cdr-link"
set "PY=C:\inetpub\wwwroot\CM\python\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

if not exist "%DIR%\cdr" mkdir "%DIR%\cdr"
if not exist "%DIR%\logs" mkdir "%DIR%\logs"

cd /d "%DIR%"
echo Starting CDR logger on 0.0.0.0:9000 ...
echo Daily files: %DIR%\cdr\YYYYMMDD.txt
echo.
"%PY%" "%DIR%\cdr_logger.py" --host 0.0.0.0 --port 9000 --log-dir "%DIR%\cdr"
endlocal
