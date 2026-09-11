# Single-port OSSI bridge restart - MUST match api\appsettings.json (18776 only).
# Prefer Admin when killing zombies / recycling IIS.
$log = "C:\inetpub\wwwroot\CM\data_live\logs\restart-bridge.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
function L($m){ Add-Content $log ("{0} {1}" -f (Get-Date -Format o), $m) }

$PORT = 18776
L "restart begin (ONLY port $PORT / data_live)"

# Kill ALL legacy + current bridge ports so only one process owns the OSSI SSH
Get-NetTCPConnection -LocalPort 18765,18766,18767,18768,18769,18770,18771,18772,18773,18774,18775,18776,18777,18778,18779,18780 -State Listen -EA SilentlyContinue | ForEach-Object {
  L "kill listen port=$($_.LocalPort) pid=$($_.OwningProcess)"
  taskkill /F /PID $_.OwningProcess 2>&1 | ForEach-Object { L $_ }
}
Get-CimInstance Win32_Process -EA SilentlyContinue | Where-Object { $_.CommandLine -like '*ossi_service.py*' } | ForEach-Object {
  L "kill ossi pid=$($_.ProcessId)"
  taskkill /F /PID $_.ProcessId 2>&1 | ForEach-Object { L $_ }
}
Start-Sleep 3

$env:PYTHONPATH = "C:\inetpub\wwwroot\CM\vendor\avaya-ossi\src"
$env:PYTHONUNBUFFERED = "1"
$py = "C:\inetpub\wwwroot\CM\python\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) { throw "python\.venv missing. Run scripts\install.bat (system Python 3.11+)." }

# Keep appsettings on the single port
$cfgPath = "C:\inetpub\wwwroot\CM\api\appsettings.json"
@"
{
  "Logging": { "LogLevel": { "Default": "Warning", "Microsoft.AspNetCore": "Warning", "CmApi.Services": "Information" } },
  "AllowedHosts": "*",
  "OssiBridge": {
    "BaseUrl": "http://127.0.0.1:$PORT",
    "SiteRoot": "C:\\inetpub\\wwwroot\\CM",
    "DataDir": "C:\\inetpub\\wwwroot\\CM\\data_live",
    "OssiSrc": "C:\\inetpub\\wwwroot\\CM\\vendor\\avaya-ossi\\src",
    "Python": "C:\\inetpub\\wwwroot\\CM\\python\\.venv\\Scripts\\python.exe"
  }
}
"@ | Set-Content $cfgPath -Encoding UTF8
L "appsettings BaseUrl :$PORT"

$p = Start-Process -FilePath $py -ArgumentList @(
  "C:\inetpub\wwwroot\CM\python\ossi_service.py",
  "--host", "0.0.0.0",
  "--port", "$PORT",
  "--data-dir", "C:\inetpub\wwwroot\CM\data_live"
) -WorkingDirectory "C:\inetpub\wwwroot\CM\python" -WindowStyle Hidden -PassThru
L "started pid=$($p.Id) port=$PORT data_live"
Start-Sleep 3
try {
  $r = Invoke-RestMethod "http://127.0.0.1:$PORT/health" -TimeoutSec 5
  L ("health=" + ($r | ConvertTo-Json -Compress))
} catch { L "health err $_" }
try {
  $r = Invoke-RestMethod "http://127.0.0.1:$PORT/monitored" -TimeoutSec 5
  L ("monitored keys=" + ($r.PSObject.Properties.Name -join ','))
} catch { L "monitored err $_" }
L "restart end - ONLY port $PORT"
