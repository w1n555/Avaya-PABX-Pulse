#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Install Windows Scheduled Task so OSSI bridge auto-starts at logon.
  Portable: paths derived from this script location (any install root).
  Port/data must match api\appsettings.json (ONLY 18776 + data_live).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-bridge-autostart.ps1
#>

param([string]$Root = "")

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Root) { $Root = (Resolve-Path (Join-Path $scriptDir "..")).Path }

$TaskName = "CM-NOC-OSSI-Bridge"
$Py = Join-Path $Root "python\.venv\Scripts\python.exe"
$Script = Join-Path $Root "python\ossi_service.py"
$DataDir = Join-Path $Root "data_live"
$WorkDir = Join-Path $Root "python"
$Port = 18776

if (-not (Test-Path $Py)) {
    throw "Site venv missing: python\.venv — run scripts\install.bat first (system Python 3.11+)."
}
if (-not (Test-Path $Script)) { throw "Missing $Script" }
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null }

$arg = "`"$Script`" --host 0.0.0.0 --port $Port --data-dir `"$DataDir`""
$action = New-ScheduledTaskAction -Execute $Py -Argument $arg -WorkingDirectory $WorkDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 5
    Write-Host "OK: bridge healthy port=$Port — $($r.Content)"
} catch {
    Write-Warning "Task registered but health not yet OK: $_"
}
Write-Host "Done. Task: $TaskName  Root: $Root  Port: $Port  Data: $DataDir"
