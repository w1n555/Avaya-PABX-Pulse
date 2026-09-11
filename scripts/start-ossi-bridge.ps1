# Start local OSSI bridge (127.0.0.1:18776 ONLY) - match api\appsettings.json.
# Prefer: install.ps1 (auto). This script is for manual troubleshooting only.

param(
    [string]$Root = "",
    [int]$Port = 18776
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Root) { $Root = (Resolve-Path (Join-Path $scriptDir "..")).Path }

$DataDir = Join-Path $Root "data_live"
$Script = Join-Path $Root "python\ossi_service.py"
$WorkDir = Join-Path $Root "python"
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null }

$pythonCandidates = @(
    (Join-Path $Root "python\.venv\Scripts\python.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"),
    "C:\Python312\python.exe",
    "C:\Python311\python.exe",
    "python"
)
$py = $null
foreach ($c in $pythonCandidates) {
    if ($c -eq "python") {
        $cmd = Get-Command python -ErrorAction SilentlyContinue
        if ($cmd) { $py = $cmd.Source; break }
        continue
    }
    if (Test-Path $c) {
        & $c -c "import avaya_ossi" 2>$null
        if ($LASTEXITCODE -eq 0) { $py = $c; break }
        if (-not $py) { $py = $c }
    }
}
if (-not $py) { throw "Python not found. Run scripts\install.ps1 first." }
if (-not (Test-Path $Script)) { throw "Missing $Script" }

try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) {
        Write-Host "OSSI bridge already running on :$Port"
        exit 0
    }
} catch { }

Write-Host "Starting OSSI bridge with $py ..."
$argList = @($Script, "--host", "0.0.0.0", "--port", "$Port", "--data-dir", $DataDir)
Start-Process -FilePath $py -ArgumentList $argList -WorkingDirectory $WorkDir -WindowStyle Hidden
Start-Sleep -Seconds 1
try {
    $r2 = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 5
    Write-Host "Bridge health: $($r2.Content)"
} catch {
    Write-Warning "Bridge may still be starting: $_"
}
