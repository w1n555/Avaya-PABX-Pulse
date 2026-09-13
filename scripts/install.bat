@echo off
REM Avaya PABX Pulse — run as Administrator.
REM Prechecks (Admin / IIS / ANCM / Python 3.11|3.12) BEFORE install.ps1.
REM Bypasses Windows "running scripts is disabled".
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo ============================================================
echo   Avaya PABX Pulse — install prechecks
echo ============================================================
echo.

REM --- Admin ---
net session >nul 2>&1
if errorlevel 1 (
  echo [X] EN: Please run as Administrator ^(right-click PowerShell/CMD -^> Run as administrator^).
  echo [X] 繁中: 請以系統管理員身分執行（對 PowerShell/CMD 按右鍵 → 以系統管理員身分執行）。
  exit /b 1
)
echo [OK] Administrator / 系統管理員

REM --- IIS / appcmd ---
if not exist "%windir%\System32\inetsrv\appcmd.exe" (
  echo [X] EN: IIS not found ^(appcmd.exe missing^). Install IIS via Windows Features, then re-run.
  echo [X] 繁中: 找不到 IIS（缺少 appcmd.exe）。請先用「Windows 功能」安裝 IIS，然後再執行。
  echo     Include: IIS Management Console, World Wide Web Services.
  exit /b 2
)
"%windir%\System32\inetsrv\appcmd.exe" list site >nul 2>&1
if errorlevel 1 (
  echo [X] EN: IIS appcmd present but cannot list sites. Repair IIS, then re-run.
  echo [X] 繁中: 已有 appcmd 但無法列出網站。請修復 IIS 後再執行。
  exit /b 2
)
echo [OK] IIS / appcmd

REM --- .NET 8 Hosting Bundle / ANCM ---
set "ANCM="
if exist "%ProgramFiles%\IIS\Asp.Net Core Module\V2\aspnetcorev2.dll" set "ANCM=1"
if exist "%ProgramFiles(x86)%\IIS\Asp.Net Core Module\V2\aspnetcorev2.dll" set "ANCM=1"
if not defined ANCM (
  echo [X] EN: .NET 8 Hosting Bundle / ASP.NET Core Module ^(ANCM^) not found.
  echo     Install Hosting Bundle ^(not the SDK^) from:
  echo     https://dotnet.microsoft.com/download/dotnet/8.0
  echo     Then re-run install.bat. ^(No CDN auto-download — offline servers^)
  echo [X] 繁中: 找不到 .NET 8 Hosting Bundle / ASP.NET Core Module ^(ANCM^)。
  echo     請手動安裝 Hosting Bundle（不是 SDK）：
  echo     https://dotnet.microsoft.com/download/dotnet/8.0
  echo     然後再執行 install.bat。（離線環境不會自動下載）
  exit /b 3
)
echo [OK] .NET Hosting Bundle / ANCM

REM --- Python 3.11 or 3.12 only (reject missing and 3.13+) ---
set "PYOK="
set "PYVER="
REM Prefer py launcher pins
where py >nul 2>&1
if not errorlevel 1 (
  for %%V in (3.12 3.11) do (
    if not defined PYOK (
      py -%%V -c "import sys; v=sys.version_info; raise SystemExit(0 if (v.major==3 and v.minor in (11,12)) else 1)" >nul 2>&1
      if not errorlevel 1 (
        for /f "delims=" %%P in ('py -%%V -c "import sys; print(sys.executable)" 2^>nul') do (
          set "PYOK=%%P"
          set "PYVER=%%V"
        )
      )
    )
  )
)
if not defined PYOK (
  where python >nul 2>&1
  if not errorlevel 1 (
    for /f "delims=" %%P in ('where python 2^>nul') do (
      if not defined PYOK (
        "%%P" -c "import sys; v=sys.version_info; raise SystemExit(0 if (v.major==3 and v.minor in (11,12)) else 1)" >nul 2>&1
        if not errorlevel 1 (
          set "PYOK=%%P"
          for /f "delims=" %%V in ('"%%P" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2^>nul') do set "PYVER=%%V"
        )
      )
    )
  )
)

REM Detect rejected 3.13+ for a clearer message
set "PYBAD="
where python >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%P in ('where python 2^>nul') do (
    if not defined PYBAD (
      "%%P" -c "import sys; v=sys.version_info; raise SystemExit(0 if (v.major==3 and v.minor>=13) else 1)" >nul 2>&1
      if not errorlevel 1 set "PYBAD=%%P"
    )
  )
)

if not defined PYOK (
  if defined PYBAD (
    echo [X] EN: Python 3.13+ is not supported. Offline wheels in python\wheels are built for 3.11/3.12 ABI only.
    echo     Uninstall 3.13+ or install Python 3.12 ^(prefer^) / 3.11, tick "Add python.exe to PATH", then re-run.
    echo [X] 繁中: 不支援 Python 3.13+。python\wheels 離線套件僅適用 3.11/3.12 ABI。
    echo     請改用 Python 3.12（建議）或 3.11，安裝時勾選 Add to PATH，然後再執行。
  ) else (
    echo [X] EN: Python 3.11 or 3.12 not found. Install from https://www.python.org ^(prefer 3.12^), tick Add to PATH, then re-run.
    echo     This installer does NOT download Python ^(no CDN on production servers^).
    echo [X] 繁中: 找不到 Python 3.11 或 3.12。請先自行安裝（建議 3.12），勾選 Add to PATH，然後再執行。
    echo     安裝程式不會自動下載 Python（生產環境通常無 CDN）。
  )
  exit /b 4
)
echo [OK] Python !PYVER! — !PYOK!

echo.
echo [OK] Prechecks passed / 預檢通過 — starting install.ps1 ...
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "RC=!ERRORLEVEL!"
exit /b !RC!
