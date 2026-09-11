#Requires -RunAsAdministrator
<#
.SYNOPSIS
  One-click IIS setup for Avaya PABX Pulse (easy path).

  User installs IIS themselves. This script:
    1) Detects IIS
    2) Checks / installs .NET 8 Hosting Bundle if missing
    3) Checks / installs Python 3.12 (with PATH) if missing
    4) Asks local ROOT path (ZIP extract folder)
    5) Points IIS site + /api to that path
    6) OPTIONAL: pull latest code from GitHub if folder is a git repo (or -Update)
    7) Site venv + bundled vendor/avaya-ossi + bridge autostart
    8) Re-publish API, recycle pool, restart bridge
    9) Prints browser URL

  ONE command for both first install AND upgrade (auto-detect):
    powershell -ExecutionPolicy Bypass -File .\install.ps1

  If folder is a git clone -> auto git pull + republish + restart services.
  If already configured -> safe re-run (idempotent upgrade).
  data_live\monitored_trunks.json is kept.

.EXAMPLE
  cd C:\inetpub\wwwroot\CM\scripts
  powershell -ExecutionPolicy Bypass -File .\install.ps1

  .\install.ps1 -RootPath "C:\inetpub\wwwroot\CM" -SitePort 8888 -NonInteractive
#>

[CmdletBinding()]
param(
    [string]$RootPath = "",
    [int]$SitePort = 0,
    # Nested under existing site (default): URL like http://host:port/CM/ and /CM/api
    # Dedicated: create a new site that owns the whole port (only if you really want that)
    [ValidateSet("Nested", "Dedicated")]
    [string]$IisMode = "Nested",
    [string]$ParentSiteName = "",
    [string]$AppAlias = "",
    [string]$SiteName = "CM-NOC",
    [string]$AppPoolName = "CmApiNoManaged",
    [switch]$SkipPublish,
    [switch]$SkipDotNetInstall,
    [switch]$SkipPythonInstall,
    [switch]$SkipUpdate,
    [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"

# Single OSSI bridge — MUST match live api\appsettings.json
$script:OssiBridgePort = 18776
$script:OssiBridgeLegacyPort = 18765  # kill leftover only; never start
$script:OssiDataLeaf = "data_live"

function Write-Info([string]$m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "[OK] $m" -ForegroundColor Green }
function Write-Warn([string]$m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Write-Err([string]$m)  { Write-Host "[X] $m" -ForegroundColor Red }

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Please run PowerShell as Administrator."
    }
}

function Get-AppCmd {
    $p = Join-Path $env:windir "System32\inetsrv\appcmd.exe"
    if (-not (Test-Path $p)) { return $null }
    return $p
}

function Test-IisInstalled {
    $appcmd = Get-AppCmd
    if (-not $appcmd) { return $false }
    try {
        & $appcmd list site 2>$null | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Refresh-Path {
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")
}

function Get-DownloadDir {
    $d = Join-Path $env:TEMP "cm-noc-install"
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    return $d
}

function Test-Winget {
    return [bool](Get-Command winget -ErrorAction SilentlyContinue)
}

function Test-AspNetCoreModule {
    $p1 = Join-Path $env:ProgramFiles "IIS\Asp.Net Core Module\V2\aspnetcorev2.dll"
    $p2 = Join-Path ${env:ProgramFiles(x86)} "IIS\Asp.Net Core Module\V2\aspnetcorev2.dll"
    return (Test-Path $p1) -or (Test-Path $p2)
}

function Test-DotNetHosting {
    if (Test-AspNetCoreModule) { return $true }
    $fx = Join-Path $env:ProgramFiles "dotnet\shared\Microsoft.AspNetCore.App"
    if (Test-Path $fx) {
        $v8 = Get-ChildItem $fx -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "8.*" }
        if ($v8) { return $true }
    }
    return $false
}

function Restart-IisSafe {
    Write-Info "Restarting IIS so ASP.NET Core Module loads..."
    try {
        & iisreset 2>&1 | Out-Host
    } catch {
        try {
            Restart-Service W3SVC -Force -ErrorAction SilentlyContinue
            Restart-Service WAS -Force -ErrorAction SilentlyContinue
        } catch {
            Write-Warn "Could not restart IIS automatically: $_"
        }
    }
}

function Install-DotNetHostingBundle {
    if ($SkipDotNetInstall) {
        Write-Warn "SkipDotNetInstall set - not installing Hosting Bundle"
        return
    }
    Write-Info ".NET 8 Hosting Bundle / ANCM not found - installing..."

    if (Test-Winget) {
        Write-Info "Trying winget: Microsoft.DotNet.HostingBundle.8"
        try {
            & winget install -e --id Microsoft.DotNet.HostingBundle.8 --accept-package-agreements --accept-source-agreements --silent 2>&1 | Out-Host
            Start-Sleep -Seconds 2
            if (Test-DotNetHosting) {
                Write-Ok ".NET Hosting Bundle installed via winget"
                Restart-IisSafe
                return
            }
        } catch {
            Write-Warn "winget Hosting Bundle failed: $_"
        }
    }

    $dl = Get-DownloadDir
    $installer = Join-Path $dl "dotnet-hosting-win.exe"
    $urls = @(
        "https://builds.dotnet.microsoft.com/dotnet/aspnetcore/Runtime/8.0.14/dotnet-hosting-8.0.14-win.exe",
        "https://builds.dotnet.microsoft.com/dotnet/aspnetcore/Runtime/8.0.11/dotnet-hosting-8.0.11-win.exe"
    )
    $ok = $false
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    foreach ($url in $urls) {
        try {
            Write-Info "Downloading Hosting Bundle..."
            Write-Host "  $url"
            Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing
            if ((Get-Item $installer).Length -gt 1MB) { $ok = $true; break }
        } catch {
            Write-Warn "Download failed: $_"
        }
    }
    if (-not $ok) {
        throw "Could not download .NET Hosting Bundle. Install manually from https://dotnet.microsoft.com/download/dotnet/8.0 (Hosting Bundle), then re-run."
    }

    Write-Info "Running Hosting Bundle installer (quiet)..."
    $p = Start-Process -FilePath $installer -ArgumentList @("/install", "/quiet", "/norestart") -Wait -PassThru
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
        Write-Warn "Hosting Bundle installer exit code $($p.ExitCode)"
    }
    Restart-IisSafe
    if (-not (Test-DotNetHosting)) {
        throw "Hosting Bundle still not detected. Install manually from https://dotnet.microsoft.com/download/dotnet/8.0 then re-run."
    }
    Write-Ok ".NET Hosting Bundle ready"
}

function Ensure-DotNetHosting {
    if (Test-DotNetHosting) {
        Write-Ok ".NET ASP.NET Core Hosting / ANCM present"
        return
    }
    Write-Warn ".NET 8 Hosting Bundle not detected"
    if (-not $NonInteractive) {
        $ans = Read-Host "Install .NET 8 Hosting Bundle now? [Y/n]"
        if ($ans -match '^[nN]') {
            throw "Hosting Bundle is required for /api. Install from https://dotnet.microsoft.com/download/dotnet/8.0 and re-run."
        }
    }
    Install-DotNetHostingBundle
}

function Find-Python {
    param([string]$Root = "")
    Refresh-Path
    $cands = @()
    if ($Root) {
        $cands += (Join-Path $Root "python\runtime\python.exe")
        $cands += (Join-Path $Root "python\.venv\Scripts\python.exe")
    }
    $cands += @(
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\python.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"),
        "C:\Program Files\Python313\python.exe",
        "C:\Program Files\Python312\python.exe",
        "C:\Program Files\Python311\python.exe",
        "C:\Python313\python.exe",
        "C:\Python312\python.exe",
        "C:\Python311\python.exe"
    )
    foreach ($c in $cands) {
        if (-not (Test-Path $c)) { continue }
        try {
            $ver = & $c --version 2>&1 | Out-String
            if ($ver -match "Python 3\.(1[1-9]|[2-9]\d)") { return $c }
        } catch {}
    }
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) {
        try {
            $ver = & $cmd.Source --version 2>&1 | Out-String
            if ($ver -match "Python 3\.(1[1-9]|[2-9]\d)") { return $cmd.Source }
        } catch {}
    }
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        foreach ($v in @("-3.12", "-3.11", "-3")) {
            try {
                $out = & py $v -c "import sys; print(sys.executable)" 2>$null
                if ($out -and (Test-Path $out.Trim())) { return $out.Trim() }
            } catch {}
        }
    }
    return $null
}

function Install-Python311 {
    if ($SkipPythonInstall) {
        Write-Warn "SkipPythonInstall set - not installing Python"
        return
    }
    Write-Info "Python 3.11+ not found - installing..."

    if (Test-Winget) {
        Write-Info "Trying winget: Python.Python.3.12"
        try {
            & winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements --silent 2>&1 | Out-Host
            Start-Sleep -Seconds 2
            Refresh-Path
            if (Find-Python) {
                Write-Ok "Python installed via winget: $(Find-Python)"
                return
            }
        } catch {
            Write-Warn "winget Python install failed: $_"
        }
    }

    $dl = Get-DownloadDir
    $ver = "3.12.8"
    $url = "https://www.python.org/ftp/python/$ver/python-$ver-amd64.exe"
    $exe = Join-Path $dl "python-$ver-amd64.exe"
    Write-Info "Downloading Python $ver from python.org..."
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
    } catch {
        throw "Failed to download Python. Install Python 3.11+ manually (check Add to PATH), then re-run. $_"
    }
    Write-Info "Running Python installer (quiet, AllUsers, PrependPath)..."
    $p = Start-Process -FilePath $exe -ArgumentList @(
        "/quiet",
        "InstallAllUsers=1",
        "PrependPath=1",
        "Include_test=0",
        "Include_launcher=1",
        "SimpleInstall=1"
    ) -Wait -PassThru
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
        Write-Warn "Python installer exit code $($p.ExitCode)"
    }
    Refresh-Path
    if (-not (Find-Python)) {
        throw "Python still not found after install. Open a NEW Admin PowerShell and re-run install.ps1."
    }
    Write-Ok "Python ready: $(Find-Python)"
}

function Ensure-Python {
    param([string]$Root = "")
    $py = Find-Python -Root $Root
    if ($py) {
        Write-Ok "Python 3.11+ found: $py"
        return
    }
    Write-Warn "Python 3.11+ not detected (no bundled python\runtime and no system Python)"
    if (-not $NonInteractive) {
        $ans = Read-Host "Install Python 3.12 now? [Y/n]"
        if ($ans -match '^[nN]') {
            throw @"
Python is required for OSSI.

Offline: copy python\runtime from a working Pulse PC (or GitHub Release python-runtime.zip)
into: $Root\python\runtime
Then re-run install.bat.

Online: install Python 3.12 from https://www.python.org (Add to PATH) and re-run.
"@
        }
    }
    Install-Python311
}

function Read-UserPath([string]$defaultPath) {
    if ($RootPath) {
        $p = $RootPath.Trim().Trim('"')
        if (Test-Path $p) { return (Resolve-Path $p).Path }
        throw "RootPath not found: $p"
    }
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor White
    Write-Host "  Avaya PABX Pulse - one-click IIS setup" -ForegroundColor White
    Write-Host "============================================================" -ForegroundColor White
    Write-Host ""
    Write-Host "Where did you put this app? (ZIP extract / local root path)"
    Write-Host "  Example: C:\inetpub\wwwroot\CM"
    Write-Host "  Default: $defaultPath"
    Write-Host ""
    $ans = Read-Host "Local ROOT path [Enter = default]"
    if ([string]::IsNullOrWhiteSpace($ans)) { $ans = $defaultPath }
    $ans = $ans.Trim().Trim('"')
    if (-not (Test-Path $ans)) {
        throw "Path does not exist: $ans  (extract the ZIP there first, then re-run)"
    }
    return (Resolve-Path $ans).Path
}

function Read-Port([int]$defaultPort) {
    if ($SitePort -gt 0) { return $SitePort }
    if ($NonInteractive) { return $defaultPort }
    Write-Host ""
    Write-Host "Which IIS PORT already hosts your main web service?"
    Write-Host "  We will ONLY add nested apps under that site (e.g. /CM + /CM/api)."
    Write-Host "  We will NOT change that site's root physical path or homepage."
    Write-Host "  Default: $defaultPort"
    Write-Host ""
    $ans = Read-Host "Existing IIS site port [Enter = $defaultPort]"
    if ([string]::IsNullOrWhiteSpace($ans)) { return $defaultPort }
    $n = 0
    if (-not [int]::TryParse($ans, [ref]$n) -or $n -lt 1 -or $n -gt 65535) {
        throw "Invalid port: $ans"
    }
    return $n
}

function Find-DotNet {
    $local = Join-Path $env:LOCALAPPDATA "Microsoft\dotnet\dotnet.exe"
    if (Test-Path $local) { return $local }
    $cmd = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Set-JsonAppSettings([string]$root, [string]$pythonExe) {
    # Guard: PowerShell may pass Object[] if earlier function leaked stdout
    if ($pythonExe -is [Array]) {
        $pythonExe = ($pythonExe | Where-Object { $_ -and "$_" -match 'python\.exe$' } | Select-Object -Last 1)
    }
    $pythonExe = "$pythonExe".Trim()
    if (-not $pythonExe -or -not (Test-Path $pythonExe)) {
        $fallback = Join-Path $root "python\.venv\Scripts\python.exe"
        if (Test-Path $fallback) { $pythonExe = $fallback }
        else { throw "Invalid Python path for appsettings: '$pythonExe'" }
    }
    $payload = @{
        Logging = @{
            LogLevel = @{
                Default = "Warning"
                "Microsoft.AspNetCore" = "Warning"
                "CmApi.Services" = "Information"
            }
        }
        AllowedHosts = "*"
        OssiBridge = @{
            BaseUrl  = "http://127.0.0.1:$($script:OssiBridgePort)"
            Bind     = "0.0.0.0"
            SiteRoot = $root
            DataDir  = (Join-Path $root $script:OssiDataLeaf)
            OssiSrc  = (Join-Path $root "vendor\avaya-ossi\src")
            Python   = $pythonExe
        }
        CdrLogger = @{
            Enabled = $true
            Port    = 9000
            Bind    = "0.0.0.0"
        }
    } | ConvertTo-Json -Depth 6

    foreach ($rel in @("api\appsettings.json", "src\CmApi\appsettings.json")) {
        $p = Join-Path $root $rel
        $dir = Split-Path $p -Parent
        if (-not (Test-Path $dir)) { continue }
        [System.IO.File]::WriteAllText($p, $payload + "`r`n", [System.Text.UTF8Encoding]::new($false))
        Write-Ok "Wrote $p"
    }
}

function Ensure-DataFiles([string]$root) {
    $data = Join-Path $root $script:OssiDataLeaf
    New-Item -ItemType Directory -Force -Path $data | Out-Null
    $mon = Join-Path $data "monitored_trunks.json"
    $td  = Join-Path $data "trunk_data.json"
    if (-not (Test-Path $mon)) {
        $monJson = @{ trunks = @(1); updatedAt = $null } | ConvertTo-Json -Compress
        Set-Content -Path $mon -Value $monJson -Encoding UTF8
    }
    if (-not (Test-Path $td)) {
        $tdObj = [ordered]@{
            lastUpdate = $null
            host = $null
            username = $null
            connected = $false
            error = $null
            source = "avaya-ossi"
            items = @()
        }
        Set-Content -Path $td -Value ($tdObj | ConvertTo-Json -Depth 4) -Encoding UTF8
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $data "logs") | Out-Null
}

function Test-AvayaOssiImport([string]$py, [string]$root) {
    if (-not $py -or -not (Test-Path $py)) { return $false }
    $src = Join-Path $root "vendor\avaya-ossi\src"
    $prev = $env:PYTHONPATH
    try {
        $env:PYTHONPATH = $src
        $null = & $py -c "import avaya_ossi, paramiko" 2>&1
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    } finally {
        $env:PYTHONPATH = $prev
    }
}

function Repair-VenvHome([string]$root, [string]$basePython) {
    $cfg = Join-Path $root "python\.venv\pyvenv.cfg"
    if (-not (Test-Path $cfg)) { return }
    $home = $null
    $runtimePy = Join-Path $root "python\runtime\python.exe"
    if (Test-Path $runtimePy) { $home = Split-Path $runtimePy }
    elseif ($basePython -and (Test-Path $basePython)) { $home = Split-Path $basePython }
    if (-not $home) { return }
    $lines = Get-Content $cfg
    $out = foreach ($line in $lines) {
        if ($line -match '^\s*home\s*=') { "home = $home" }
        else { $line }
    }
    Set-Content -Path $cfg -Value $out -Encoding ASCII
}

function Ensure-PythonVenv([string]$root, [string]$basePython) {
    $runtimePy = Join-Path $root "python\runtime\python.exe"
    if (Test-AvayaOssiImport -py $runtimePy -root $root) {
        Write-Ok "Python OSSI ready (bundled python\runtime): $runtimePy"
        return ,$runtimePy
    }
    $venvPy = Join-Path $root "python\.venv\Scripts\python.exe"
    $vendor = Join-Path $root "vendor\avaya-ossi"
    if (-not (Test-Path $vendor)) {
        throw "Missing vendor\avaya-ossi - ZIP incomplete. Re-download full package."
    }
    if (-not (Test-Path $venvPy)) {
        Write-Info "Creating Python venv under site (first time)..."
        & $basePython -m venv (Join-Path $root "python\.venv")
        if ($LASTEXITCODE -ne 0) { throw "python -m venv failed" }
    }
    Repair-VenvHome -root $root -basePython $basePython
    if (Test-AvayaOssiImport -py $venvPy -root $root) {
        Write-Ok "Python OSSI ready (existing venv): $venvPy"
        return ,$venvPy
    }
    $wheelDir = Join-Path $root "python\wheels"
    if (Test-Path $wheelDir) {
        Write-Info "Installing paramiko from python\wheels (offline, no PyPI)..."
        try {
            & $venvPy -m pip install --no-index --find-links $wheelDir setuptools wheel paramiko python-dotenv
            & $venvPy -m pip install --no-index --no-build-isolation --find-links $wheelDir -e $vendor
        } catch {
            Write-Warn "offline pip: $($_.Exception.Message)"
        }
        if (Test-AvayaOssiImport -py $venvPy -root $root) {
            Write-Ok "Python OSSI ready (wheels): $venvPy"
            return ,$venvPy
        }
    }
    Write-Info "python\wheels miss or incomplete — trying PyPI..."
    try {
        & $venvPy -m pip install -U pip -q
        & $venvPy -m pip install -e $vendor -q
    } catch {
        Write-Warn "pip install failed: $($_.Exception.Message)"
    }
    if (Test-AvayaOssiImport -py $venvPy -root $root) {
        Write-Ok "Python OSSI ready: $venvPy"
        return ,$venvPy
    }
    throw @"
Could not install paramiko/avaya-ossi.

This PC needs either:
  - python\wheels\ (comes with the Pulse package) so pip can install offline, or
  - internet to PyPI.

You install Python 3.11+ yourself (Add to PATH), then re-run install.bat.
Do not need a portable python\runtime.
"@
}

function Ensure-ApiPublish([string]$root, [switch]$Force) {
    $apiDll = Join-Path $root "api\CmApi.dll"
    $csproj = Join-Path $root "src\CmApi\CmApi.csproj"
    if ((Test-Path $apiDll) -and $SkipPublish -and -not $Force) {
        Write-Ok "Using existing api\ publish"
        return
    }
    if (-not (Test-Path $csproj)) {
        if (Test-Path $apiDll) {
            Write-Warn "No src project; using prebuilt api\"
            return
        }
        throw "Neither api\CmApi.dll nor src\CmApi found."
    }
    $dotnet = Find-DotNet
    if (-not $dotnet) {
        if (Test-Path $apiDll) {
            Write-Warn "dotnet SDK not found; using existing api\"
            return
        }
        throw "dotnet not found. Install .NET 8 SDK (or ship prebuilt api\)."
    }
    Write-Info "Publishing CmApi..."
    $out = Join-Path $root "api"
    $appcmd = Get-AppCmd
    try { & $appcmd stop apppool /apppool.name:"$AppPoolName" 2>$null | Out-Null } catch {}
    Start-Sleep -Seconds 1
    & $dotnet publish $csproj -c Release -o $out --nologo
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }
    Write-Ok "Published to $out"
}

function Ensure-AppPool {
    $appcmd = Get-AppCmd
    $pools = @(& $appcmd list apppool /text:APPPOOL.NAME 2>$null)
    if ($pools -notcontains $AppPoolName) {
        Write-Info "Creating app pool $AppPoolName (No Managed Code)"
        & $appcmd add apppool /name:"$AppPoolName" /managedRuntimeVersion:"" /managedPipelineMode:Integrated | Out-Null
    } else {
        Write-Info "App pool exists: $AppPoolName"
    }
    & $appcmd set apppool /apppool.name:"$AppPoolName" /managedRuntimeVersion:"" | Out-Null
    & $appcmd start apppool /apppool.name:"$AppPoolName" 2>$null | Out-Null
}

function Write-ApiWebConfig([string]$apiPath) {
    $wc = Join-Path $apiPath "web.config"
    $webConfig = @"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <location path="." inheritInChildApplications="false">
    <system.webServer>
      <handlers>
        <add name="aspNetCore" path="*" verb="*" modules="AspNetCoreModuleV2" resourceType="Unspecified" />
      </handlers>
      <aspNetCore processPath="dotnet" arguments=".\CmApi.dll" stdoutLogEnabled="false" stdoutLogFile=".\logs\stdout" hostingModel="InProcess" />
    </system.webServer>
  </location>
</configuration>
"@
    Set-Content -Path $wc -Value $webConfig -Encoding UTF8
}

function Find-SiteOnPort([int]$port) {
    $appcmd = Get-AppCmd
    foreach ($n in @(& $appcmd list site /text:SITE.NAME 2>$null)) {
        if (-not $n) { continue }
        $binds = & $appcmd list site "/site.name:$n" /text:bindings 2>$null
        if ("$binds" -match [regex]::Escape(":${port}:")) { return $n }
    }
    return $null
}

function Find-SiteByPhysicalPath([string]$path) {
    $appcmd = Get-AppCmd
    $norm = $path.TrimEnd('\')
    foreach ($line in @(& $appcmd list vdir 2>$null)) {
        # VDIR "Default Web Site/" (physicalPath:C:\inetpub\wwwroot)
        if ($line -match 'VDIR\s+"([^"]+)"\s+\(physicalPath:([^)]+)\)') {
            $vdir = $Matches[1]
            $pp = $Matches[2].TrimEnd('\')
            if ($pp -ieq $norm -and $vdir -match '^([^/]+)/$') {
                return $Matches[1]
            }
        }
    }
    return $null
}

function Remove-DedicatedCmNocSiteIfConflicting([int]$port) {
    # Older install.ps1 created a dedicated "CM-NOC" site on the same port as other apps — remove it
    $appcmd = Get-AppCmd
    $sites = @(& $appcmd list site /text:SITE.NAME 2>$null)
    if ($sites -notcontains "CM-NOC") { return }
    $binds = & $appcmd list site "/site.name:CM-NOC" /text:bindings 2>$null
    if ("$binds" -match [regex]::Escape(":${port}:")) {
        Write-Warn "Removing old dedicated site 'CM-NOC' on port $port (it conflicts with your main web service)"
        try {
            & $appcmd delete site /site.name:"CM-NOC" 2>$null | Out-Null
        } catch {
            Write-Warn "Could not delete CM-NOC site: $_"
        }
    }
}

function Get-SiteRootPhysicalPath([string]$siteName) {
    $appcmd = Get-AppCmd
    $p = & $appcmd list vdir "/vdir.name:${siteName}/" /text:physicalPath 2>$null
    if ($p) { return "$p".Trim() }
    return $null
}

function Set-IisNested([string]$root, [int]$port, [string]$alias) {
    # ============================================================
    # PARASITE MODE (default for all machines)
    # - NEVER change the parent site root physical path
    # - NEVER replace http://host:port/ homepage
    # - ONLY add applications under the user path folder name:
    #     /CM     -> <user RootPath>
    #     /CM/api -> <user RootPath>\api
    # ============================================================
    $appcmd = Get-AppCmd
    $apiPath = Join-Path $root "api"
    if (-not (Test-Path $apiPath)) { throw "api folder missing: $apiPath" }
    if (-not $alias) { $alias = Split-Path $root -Leaf }  # e.g. CM
    if ($alias.StartsWith("/")) { $alias = $alias.TrimStart("/") }

    Ensure-AppPool
    Remove-DedicatedCmNocSiteIfConflicting -port $port

    $parent = $ParentSiteName
    if (-not $parent) {
        $parent = Find-SiteOnPort -port $port
    }
    if (-not $parent) {
        $parentPath = Split-Path $root -Parent
        $parent = Find-SiteByPhysicalPath -path $parentPath
    }
    if (-not $parent) {
        throw @"
Could not find an existing IIS site on port $port (or parent folder of your ROOT).
Nested mode needs an existing site — we only attach /CM under it.

Fix: IIS Manager -> note Site name that uses port $port, then:
  .\install.ps1 -ParentSiteName `"ThatSiteName`" -SitePort $port

Only if you want a SEPARATE full site on a FREE port (not shared):
  .\install.ps1 -IisMode Dedicated -SitePort 8890
"@
    }

    # SAFETY: snapshot parent root path BEFORE we touch anything — must be unchanged after
    $parentRootBefore = Get-SiteRootPhysicalPath -siteName $parent
    Write-Info "Parent site: $parent (port $port)"
    Write-Info "Parent ROOT path (will NOT be changed): $parentRootBefore"
    Write-Info "Parasite apps only: /$alias -> $root ; /$alias/api -> $apiPath"

    # Hard rule: never set vdir for parent site root
    # (we only touch ${parent}/$alias and ${parent}/$alias/api)

    $apps = @(& $appcmd list app /text:APP.NAME 2>$null)
    $uiApp = "${parent}/$alias"
    $apiApp = "${parent}/$alias/api"

    if ($apps -notcontains $uiApp) {
        Write-Info "Creating nested application /$alias -> $root"
        & $appcmd add app /site.name:"$parent" /path:"/$alias" /physicalPath:"$root" /applicationPool:"$AppPoolName" | Out-Null
    } else {
        Write-Info "Updating nested application /$alias path only"
        & $appcmd set app /app.name:"$uiApp" /applicationPool:"$AppPoolName" | Out-Null
        & $appcmd set vdir /vdir.name:"${uiApp}/" /physicalPath:"$root" | Out-Null
    }

    if ($apps -notcontains $apiApp) {
        Write-Info "Creating nested application /$alias/api -> $apiPath"
        & $appcmd add app /site.name:"$parent" /path:"/$alias/api" /physicalPath:"$apiPath" /applicationPool:"$AppPoolName" | Out-Null
    } else {
        Write-Info "Updating nested application /$alias/api path only"
        & $appcmd set app /app.name:"$apiApp" /applicationPool:"$AppPoolName" | Out-Null
        & $appcmd set vdir /vdir.name:"${apiApp}/" /physicalPath:"$apiPath" | Out-Null
    }

    Write-ApiWebConfig -apiPath $apiPath
    & $appcmd start site /site.name:"$parent" 2>$null | Out-Null
    & $appcmd start apppool /apppool.name:"$AppPoolName" 2>$null | Out-Null

    $parentRootAfter = Get-SiteRootPhysicalPath -siteName $parent
    if ($parentRootBefore -and $parentRootAfter -and ($parentRootBefore.TrimEnd('\') -ne $parentRootAfter.TrimEnd('\'))) {
        throw "SAFETY STOP: parent site root path changed unexpectedly from '$parentRootBefore' to '$parentRootAfter'. Please fix IIS manually."
    }
    if ($parentRootAfter -and ($parentRootAfter.TrimEnd('\') -ieq $root.TrimEnd('\'))) {
        throw "SAFETY STOP: parent site root equals app folder. Install aborted to avoid hijacking site root. Put app in a subfolder (e.g. ...\wwwroot\CM)."
    }

    $uiPath = & $appcmd list vdir "/vdir.name:${uiApp}/" /text:physicalPath 2>$null
    $apiV = & $appcmd list vdir "/vdir.name:${apiApp}/" /text:physicalPath 2>$null
    Write-Info "Verified /$alias path: $uiPath"
    Write-Info "Verified /$alias/api path: $apiV"
    Write-Info "Verified parent ROOT still: $parentRootAfter"
    Write-Ok "Parasite OK on '$parent': http://127.0.0.1:${port}/$alias/  (site root homepage unchanged)"
    return "/$alias"
}

function Set-IisDedicated([string]$root, [int]$port) {
    # ONLY with explicit -IisMode Dedicated — owns a whole port (not for shared servers)
    Write-Warn "Dedicated mode: will create/use a FULL site on port $port (not parasite)."
    Write-Warn "If port already has another product, use Nested mode instead."
    $appcmd = Get-AppCmd
    $apiPath = Join-Path $root "api"
    if (-not (Test-Path $apiPath)) { throw "api folder missing: $apiPath" }

    Ensure-AppPool

    $other = Find-SiteOnPort -port $port
    if ($other -and $other -ne $SiteName) {
        throw "Port $port is already used by site '$other'. Pick a FREE -SitePort or use default Nested mode (parasite under existing site)."
    }

    $sites = @(& $appcmd list site /text:SITE.NAME 2>$null)
    $bindingInfo = "*:${port}:"
    if ($sites -notcontains $SiteName) {
        Write-Info "Creating dedicated site $SiteName on port $port -> $root"
        & $appcmd add site /name:"$SiteName" "/bindings:http/$bindingInfo" /physicalPath:"$root" | Out-Null
    } else {
        & $appcmd set vdir /vdir.name:"${SiteName}/" /physicalPath:"$root" | Out-Null
    }
    try {
        & $appcmd set site "/site.name:$SiteName" "/+bindings.[protocol='http',bindingInformation='$bindingInfo']" 2>$null | Out-Null
    } catch {}

    & $appcmd set app /app.name:"${SiteName}/" /applicationPool:"$AppPoolName" | Out-Null
    $apps = @(& $appcmd list app /text:APP.NAME 2>$null)
    $apiApp = "${SiteName}/api"
    if ($apps -notcontains $apiApp) {
        & $appcmd add app /site.name:"$SiteName" /path:/api /physicalPath:"$apiPath" /applicationPool:"$AppPoolName" | Out-Null
    } else {
        & $appcmd set vdir /vdir.name:"${apiApp}/" /physicalPath:"$apiPath" | Out-Null
        & $appcmd set app /app.name:"$apiApp" /applicationPool:"$AppPoolName" | Out-Null
    }
    Write-ApiWebConfig -apiPath $apiPath
    & $appcmd start site /site.name:"$SiteName" 2>$null | Out-Null
    Write-Ok "Dedicated IIS site $SiteName -> $root (port $port), /api -> $apiPath"
    return ""
}

function Set-IisSite([string]$root, [int]$port) {
    if ($IisMode -eq "Dedicated") {
        return Set-IisDedicated -root $root -port $port
    }
    $alias = $AppAlias
    if (-not $alias) { $alias = Split-Path $root -Leaf }
    return Set-IisNested -root $root -port $port -alias $alias
}

function Set-Acls([string]$root) {
    Write-Info "Setting folder permissions for IIS..."
    foreach ($rel in @("", $script:OssiDataLeaf, "python", "api")) {
        $p = if ($rel) { Join-Path $root $rel } else { $root }
        if (-not (Test-Path $p)) { continue }
        & icacls $p /grant "IIS_IUSRS:(OI)(CI)M" /T /C /Q 2>$null | Out-Null
        & icacls $p /grant "IUSR:(OI)(CI)RX" /T /C /Q 2>$null | Out-Null
    }
    Write-Ok "ACLs updated"
}

function Install-BridgeTask([string]$root, [string]$venvPy) {
    $TaskName = "CM-NOC-OSSI-Bridge"
    $script = Join-Path $root "python\ossi_service.py"
    $data = Join-Path $root $script:OssiDataLeaf
    $work = Join-Path $root "python"
    $arg = "`"$script`" --host 0.0.0.0 --port $($script:OssiBridgePort) --data-dir `"$data`""

    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    $action = New-ScheduledTaskAction -Execute $venvPy -Argument $arg -WorkingDirectory $work
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -RestartCount 5 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    try { Start-ScheduledTask -TaskName $TaskName } catch { Write-Warn "Task start: $_" }
    Write-Ok "Scheduled task $TaskName (auto-start bridge at logon)"
}

function Test-BridgeHealth([int]$port = 0) {
    if ($port -le 0) { $port = $script:OssiBridgePort }
    try {
        $r = Invoke-WebRequest "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200 -and "$($r.Content)" -match 'ossi-bridge')
    } catch {
        return $false
    }
}

function Stop-BridgeOnPort([int]$port = 0) {
    if ($port -le 0) { $port = $script:OssiBridgePort }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        # $PID is a PowerShell automatic variable (read-only). Never assign it.
        if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
            Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
                ForEach-Object {
                    $procId = $_.OwningProcess
                    if ($procId -and $procId -gt 4) {
                        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
                    }
                }
        }
    } catch {}
    finally { $ErrorActionPreference = $prev }
}

function Start-BridgeNow([string]$root, [string]$venvPy, [switch]$ForceRestart) {
    # Never fail the whole install if bridge start has issues — Login can retry.
    try {
        if ($ForceRestart) {
            Write-Info "Restarting OSSI bridge..."
            Stop-BridgeOnPort $script:OssiBridgeLegacyPort
            Stop-BridgeOnPort $script:OssiBridgePort
            Start-Sleep -Seconds 1
        } elseif (Test-BridgeHealth) {
            Write-Ok "OSSI bridge already running"
            return
        }

        $script = Join-Path $root "python\ossi_service.py"
        $data = Join-Path $root $script:OssiDataLeaf
        $work = Join-Path $root "python"
        New-Item -ItemType Directory -Force -Path $data | Out-Null

        if (-not (Test-Path $script)) {
            Write-Warn "Bridge script missing: $script"
            return
        }

        # Resolve a runnable python (site venv preferred)
        $py = $venvPy
        if (-not $py -or -not (Test-Path $py)) {
            $py = Join-Path $root "python\.venv\Scripts\python.exe"
        }
        if (-not (Test-Path $py)) {
            $py = Find-Python
        }
        if (-not $py -or -not (Test-Path $py)) {
            Write-Warn "No python.exe to start bridge. Login may still start it later."
            return
        }

        Write-Info "Starting bridge: $py"
        $arg = "`"$script`" --host 0.0.0.0 --port $($script:OssiBridgePort) --data-dir `"$data`""
        # Use cmd start so short-lived wrappers / venv stubs work on more machines
        $cmd = "start `"`" /B `"$py`" $arg"
        $p = Start-Process -FilePath "$env:ComSpec" -ArgumentList @("/c", $cmd) -WorkingDirectory $work -WindowStyle Hidden -PassThru -ErrorAction SilentlyContinue
        if (-not $p) {
            # Fallback: direct Start-Process
            Start-Process -FilePath $py -ArgumentList @(
                $script, "--host", "0.0.0.0", "--port", "$($script:OssiBridgePort)", "--data-dir", $data
            ) -WorkingDirectory $work -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
        }

        # Also try scheduled task if registered
        if (-not (Test-BridgeHealth)) {
            try { Start-ScheduledTask -TaskName "CM-NOC-OSSI-Bridge" -ErrorAction SilentlyContinue } catch {}
        }

        $ok = $false
        for ($i = 0; $i -lt 10; $i++) {
            Start-Sleep -Milliseconds 500
            if (Test-BridgeHealth) { $ok = $true; break }
        }
        if ($ok) {
            Write-Ok "OSSI bridge is healthy on 127.0.0.1:$($script:OssiBridgePort)"
        } else {
            Write-Warn "Bridge not healthy yet. You can still open the web UI - Login will try auto-start."
            Write-Warn ("Manual: {0} {1} --data-dir {2}" -f $py, $script, $data)
        }
    } catch {
        Write-Warn ("Bridge start skipped: {0}" -f $_.Exception.Message)
    }
}

function Test-GitRepo([string]$root) {
    return (Test-Path (Join-Path $root ".git"))
}

function Test-ExistingInstall([string]$root) {
    # Heuristics: already deployed before
    if (Test-Path (Join-Path $root "api\CmApi.dll")) { return $true }
    if (Test-Path (Join-Path $root "python\.venv\Scripts\python.exe")) { return $true }
    if (Test-Path (Join-Path $root "$($script:OssiDataLeaf)\monitored_trunks.json")) { return $true }
    if (Test-GitRepo $root) { return $true }
    return $false
}

function Invoke-Git {
    # Run git without PowerShell treating stderr (CRLF warnings) as terminating errors
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & git @GitArgs 2>&1
        $code = $LASTEXITCODE
        foreach ($line in @($output)) {
            $t = "$line"
            if ($t -match '^(fatal|error):') { Write-Warn $t }
            elseif ($t.Trim()) { Write-Host "  $t" }
        }
        return $code
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Update-CodeFromGit([string]$root) {
    # Default: AUTO upgrade when possible. One command for new + old machines.
    if ($SkipUpdate) {
        Write-Info "SkipUpdate set - leaving files as-is on disk"
        return $false
    }

    $isGit = Test-GitRepo $root
    $existing = Test-ExistingInstall $root

    if (-not $isGit) {
        if ($existing) {
            Write-Info "Existing install detected (no .git) - will reconfigure IIS/venv/API using files already on disk."
            Write-Info "To auto-pull code next time, use a git clone once."
        } else {
            Write-Info "Fresh install (no git) - using files on disk."
        }
        return $existing
    }

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Warn "git not found - skip pull. Install Git for Windows for auto code update."
        return $existing
    }

    Write-Info "Git repo detected - auto-updating code from GitHub..."
    $dataDir = Join-Path $root $script:OssiDataLeaf
    $backup = Join-Path $env:TEMP ("cm-noc-data-backup-" + [guid]::NewGuid().ToString("N"))

    Push-Location $root
    try {
        $appcmd = Get-AppCmd
        try { & $appcmd stop apppool /apppool.name:"$AppPoolName" 2>$null | Out-Null } catch {}
        Stop-BridgeOnPort $script:OssiBridgeLegacyPort
        Stop-BridgeOnPort $script:OssiBridgePort
        Start-Sleep -Seconds 1

        foreach ($srcDir in @($dataDir)) {
            if (-not (Test-Path $srcDir)) { continue }
            try {
                New-Item -ItemType Directory -Force -Path $backup | Out-Null
                Copy-Item (Join-Path $srcDir "*") $backup -Recurse -Force -ErrorAction SilentlyContinue
                Write-Info "Backed up $(Split-Path $srcDir -Leaf)\ to $backup"
            } catch {
                Write-Warn "Backup $(Split-Path $srcDir -Leaf) skipped (file in use): $($_.Exception.Message)"
            }
        }

        # Drop local build junk that blocks clean pull (never needed in git)
        foreach ($junk in @("api_publish_tmp", "api\CmApi.dll.new", "api\CmApi.exe.new")) {
            $jp = Join-Path $root $junk
            if (Test-Path $jp) {
                Remove-Item $jp -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        [void](Invoke-Git fetch --all --prune)
        $branch = (& git rev-parse --abbrev-ref HEAD 2>$null)
        if (-not $branch) { $branch = "main" }

        # Prefer autostash pull - avoids hard fail on local dirty tree / CRLF noise
        Write-Info "Pulling origin/$branch (autostash)..."
        $code = Invoke-Git -c "core.autocrlf=true" pull --ff-only --autostash origin $branch
        if ($code -ne 0) {
            Write-Warn "ff-only+autostash failed (exit $code) - trying plain pull --autostash"
            $code = Invoke-Git -c "core.autocrlf=true" pull --autostash origin $branch
        }
        if ($code -ne 0) {
            Write-Warn "git pull exit $code - continuing with files on disk (still reconfigure IIS/API)"
        } else {
            $head = & git log -1 --oneline 2>$null
            Write-Ok "Code updated: $head"
        }
    } catch {
        Write-Warn "Git update had an issue: $($_.Exception.Message) - continuing with on-disk files"
    } finally {
        Pop-Location
    }

    if (Test-Path $backup) {
        $monSrc = Join-Path $backup "monitored_trunks.json"
        $monDst = Join-Path $dataDir "monitored_trunks.json"
        if (Test-Path $monSrc) {
            New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
            Copy-Item $monSrc $monDst -Force
            Write-Ok "Restored data_live\monitored_trunks.json"
        }
    }
    return $true
}

function Restart-AppPool {
    $appcmd = Get-AppCmd
    if (-not $appcmd) { return }
    try {
        & $appcmd stop apppool /apppool.name:"$AppPoolName" 2>$null | Out-Null
        Start-Sleep -Seconds 2
        & $appcmd start apppool /apppool.name:"$AppPoolName" 2>$null | Out-Null
        Write-Ok "Recycled app pool $AppPoolName"
    } catch {
        Write-Warn "Could not recycle app pool: $_"
    }
}

# ---------------- main ----------------
try {
    Assert-Admin

    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $defaultRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path

    if (-not (Test-IisInstalled)) {
        Write-Err "IIS not detected (appcmd missing or not working)."
        Write-Host ""
        Write-Host "Please install IIS yourself first, for example:"
        Write-Host "  - Windows Features -> Internet Information Services"
        Write-Host "  - Include: IIS Management Console, World Wide Web Services"
        Write-Host "Then re-run this script (it can install Hosting Bundle + Python for you)."
        exit 2
    }
    Write-Ok "IIS detected"

    Ensure-DotNetHosting

    $root = Read-UserPath -defaultPath $defaultRoot
    $port = Read-Port -defaultPort 8888
    Ensure-Python -Root $root

    # Auto-detect: git pull if clone; existing install => full refresh
    $isUpgrade = Update-CodeFromGit -root $root
    if (-not $isUpgrade) { $isUpgrade = Test-ExistingInstall $root }

    $need = @("index.html", "app.js", "python\ossi_service.py")
    foreach ($rel in $need) {
        $p = Join-Path $root $rel
        if (-not (Test-Path $p)) {
            throw "Missing $rel under $root - wrong folder or incomplete package?"
        }
    }
    if (-not (Test-Path (Join-Path $root "vendor\avaya-ossi"))) {
        Write-Warn "vendor\avaya-ossi missing - OSSI package may be incomplete after old install"
    }
    Write-Ok "App files found under $root"

    Ensure-DataFiles -root $root

    $basePy = Find-Python -Root $root
    if (-not $basePy) { throw "Python still not found after install step." }
    Write-Ok "Python: $basePy"
    $venvPy = Ensure-PythonVenv -root $root -basePython $basePy

    # Always Force publish on re-run so one command upgrades C# too
    Ensure-ApiPublish -root $root -Force
    Set-JsonAppSettings -root $root -pythonExe $venvPy
    $urlPrefix = Set-IisSite -root $root -port $port
    if ($null -eq $urlPrefix) { $urlPrefix = "" }
    Set-Acls -root $root
    Install-BridgeTask -root $root -venvPy $venvPy
    Start-BridgeNow -root $root -venvPy $venvPy -ForceRestart
    Restart-AppPool

    Start-Sleep -Seconds 2
    # Nested default: http://127.0.0.1:8888/CM/  and  .../CM/api/health
    $baseUrl = "http://127.0.0.1:${port}$urlPrefix"
    if (-not $baseUrl.EndsWith("/")) { $baseUrl += "/" }
    $apiHealth = "http://127.0.0.1:${port}$urlPrefix/api/health".Replace("//api", "/api")
    # Fix accidental double slash
    $apiHealth = $apiHealth -replace '(?<!:)/{2,}', '/'
    try {
        $h = Invoke-WebRequest $apiHealth -UseBasicParsing -TimeoutSec 15
        Write-Ok "API health: $($h.Content)"
    } catch {
        Write-Warn "API not answering yet at $apiHealth : $_"
    }

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Green
    if ($isUpgrade) {
        Write-Host "  DONE - install/upgrade complete (auto-detected existing setup)" -ForegroundColor Green
    } else {
        Write-Host "  DONE - fresh install complete" -ForegroundColor Green
    }
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Dashboard:  $baseUrl"
    Write-Host "  API:        ${baseUrl}api/health"
    Write-Host "  (Your other site on http://127.0.0.1:${port}/ is left alone)"
    Write-Host ""
    Write-Host "  1. Open Dashboard URL above"
    Write-Host "  2. Enter your CM Host + Password"
    Write-Host "  3. Click Login  ->  monitoring starts"
    Write-Host ""
    Write-Host "  Root folder:  $root"
    Write-Host "  IIS mode:     $IisMode  (Nested = /CM under existing site)"
    Write-Host "  Bridge auto-starts at Windows logon (task CM-NOC-OSSI-Bridge)"
    Write-Host ""
    Write-Host "Later upgrade: same command"
    Write-Host "  powershell -ExecutionPolicy Bypass -File .\install.ps1"
    Write-Host ""
}
catch {
    Write-Err $_.Exception.Message
    if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray }
    exit 1
}
