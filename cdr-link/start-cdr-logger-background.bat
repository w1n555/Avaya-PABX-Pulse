@echo off
REM Detached CDR logger — survives closing the console
setlocal
set "DIR=C:\inetpub\wwwroot\CM\cdr-link"
set "PY=C:\inetpub\wwwroot\CM\python\.venv\Scripts\pythonw.exe"
if not exist "%PY%" set "PY=C:\inetpub\wwwroot\CM\python\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
if not exist "%DIR%\cdr" mkdir "%DIR%\cdr"
if not exist "%DIR%\logs" mkdir "%DIR%\logs"

REM Kill previous logger on 9000 if any
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":9000" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%P >nul 2>&1
)

cd /d "%DIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p=Start-Process -FilePath '%PY%' -ArgumentList '\"%DIR%\cdr_logger.py\"','--host','0.0.0.0','--port','9000','--log-dir','\"%DIR%\cdr\"' -WorkingDirectory '%DIR%' -WindowStyle Hidden -PassThru; Write-Output ('PID='+$p.Id)"

timeout /t 2 /nobreak >nul
netstat -ano | findstr ":9000" | findstr "LISTENING"
echo.
echo CDR logger should be listening on port 9000.
echo Daily files: %DIR%\cdr\YYYYMMDD.txt
echo Log: %DIR%\logs\cdr_logger.log
endlocal
