#Requires -RunAsAdministrator
<#
.SYNOPSIS
  IIS setup for Avaya PABX Pulse (Nested default, Dedicated optional).

  MANUAL PREREQS (install yourself — no winget/CDN auto-download):
    - Windows IIS (appcmd)
    - .NET 8 Hosting Bundle (ANCM) — not the SDK
    - Python 3.11 or 3.12 only (prefer 3.12; Add to PATH)
  Prefer scripts\install.bat — it prechecks those before this script.

  Then this script: Nested /CM (or Dedicated site), venv + offline python\wheels,
  prebuilt api\CmApi.dll, loopback OSSI bridge (127.0.0.1:18776), scheduled task.

  ONE command for first install AND upgrade (auto-detect):
    install.bat
  data_live\monitored_trunks.json is kept across upgrades.

.EXAMPLE
  cd C:\inetpub\wwwroot\CM\scripts
  install.bat

  .\install.ps1 -RootPath "C:\inetpub\wwwroot\CM" -SitePort 8888 -NonInteractive
  .\install.ps1 -IisMode Dedicated -SitePort 8890
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
    [switch]$SkipUpdate,
    [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"

# Single OSSI bridge - MUST match live api\appsettings.json
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

function Ensure-DotNetHosting {
    if (Test-DotNetHosting) {
        Write-Ok ".NET ASP.NET Core Hosting / ANCM present"
        return
    }
    throw "Missing .NET 8 Hosting Bundle. Install it, then re-run install.bat. https://dotnet.microsoft.com/download/dotnet/8.0 (Hosting Bundle, not the SDK)"
}

function Test-PythonVersionOk([string]$exe) {
    if (-not $exe -or -not (Test-Path $exe)) { return $false }
    try {
        $ver = & $exe --version 2>&1 | Out-String
        # Offline wheels: cp311 / cp312 only — reject 3.13+
        return [bool]($ver -match 'Python 3\.(11|12)(\D|$)')
    } catch {
        return $false
    }
}

function Find-Python {
    param([string]$Root = "")
    Refresh-Path
    $cands = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"),
        "C:\Program Files\Python312\python.exe",
        "C:\Program Files\Python311\python.exe",
        "C:\Python312\python.exe",
        "C:\Python311\python.exe"
    )
    foreach ($c in $cands) {
        if (Test-PythonVersionOk $c) { return $c }
    }
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd -and (Test-PythonVersionOk $cmd.Source)) { return $cmd.Source }
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        foreach ($v in @("-3.12", "-3.11")) {
            try {
                $out = & py $v -c "import sys; print(sys.executable)" 2>$null
                if ($out -and (Test-PythonVersionOk $out.Trim())) { return $out.Trim() }
            } catch {}
        }
    }
    return $null
}

function Find-PythonRejected313 {
    # Surface a clear ABI error when only 3.13+ is installed
    Refresh-Path
    $cands = @()
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $cands += $cmd.Source }
    foreach ($ver in @("Python313", "Python314")) {
        $cands += (Join-Path $env:LOCALAPPDATA "Programs\Python\$ver\python.exe")
        $cands += "C:\Program Files\$ver\python.exe"
        $cands += "C:\$ver\python.exe"
    }
    foreach ($c in $cands) {
        if (-not $c -or -not (Test-Path $c)) { continue }
        try {
            $ver = & $c --version 2>&1 | Out-String
            if ($ver -match 'Python 3\.(1[3-9]|[2-9]\d)') { return $c }
        } catch {}
    }
    return $null
}

function Ensure-Python {
    param([string]$Root = "")
    $py = Find-Python -Root $Root
    if ($py) {
        Write-Ok "Python 3.11/3.12 found: $py"
        return
    }
    $bad = Find-PythonRejected313
    if ($bad) {
        throw "Python 3.13+ is not supported ($bad). Offline wheels in python\wheels are built for 3.11/3.12 ABI only. Install Python 3.12 (prefer) or 3.11, tick Add to PATH, then re-run install.bat."
    }
    throw "Missing Python 3.11 or 3.12. Install from https://www.python.org (prefer 3.12; tick Add python.exe to PATH), then re-run install.bat. This installer does not download Python."
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

function Test-DotNetSdk([string]$dotnet) {
    if (-not $dotnet) { return $false }
    $sdks = & $dotnet --list-sdks 2>$null
    return [bool]($sdks | Where-Object { $_ -match '\d+\.\d+' })
}

function Find-DotNet {
    $cands = @(
        (Join-Path $env:LOCALAPPDATA "Microsoft\dotnet\dotnet.exe")
    )
    $cmd = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($cmd) { $cands += $cmd.Source }
    foreach ($c in $cands) {
        if ($c -and (Test-Path $c) -and (Test-DotNetSdk $c)) { return $c }
    }
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
            Bind     = "127.0.0.1"
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
    $stubs = @{
        "gateways_cache.json"   = '{"ok":true,"connected":false,"items":[],"summary":{}}'
        "alarms_cache.json"     = '{"ok":true,"connected":false,"active":[],"resolved":[],"mtceTypes":[],"summary":{}}'
        "extensions_cache.json" = '{"ok":true,"connected":false,"items":[],"summary":{}}'
    }
    foreach ($name in $stubs.Keys) {
        $fp = Join-Path $root $name
        if (-not (Test-Path $fp)) {
            Set-Content -Path $fp -Value $stubs[$name] -Encoding UTF8
        }
    }
}

function Test-AvayaOssiImport([string]$py, [string]$root) {
    if (-not $py -or -not (Test-Path $py)) { return $false }
    $src = Join-Path $root 'vendor\avaya-ossi\src'
    $prev = $env:PYTHONPATH
    try {
        $env:PYTHONPATH = $src
        $out = & $py -c "import avaya_ossi, paramiko; print('ok')" 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) { return $true }
        Write-Warn ("import avaya_ossi/paramiko failed:`n" + $out.Trim())
        return $false
    } catch {
        Write-Warn "import test: $($_.Exception.Message)"
        return $false
    } finally {
        $env:PYTHONPATH = $prev
    }
}

function Repair-VenvHome([string]$root, [string]$basePython) {
    $cfg = Join-Path $root "python\.venv\pyvenv.cfg"
    if (-not (Test-Path $cfg)) { return }
    if (-not $basePython -or -not (Test-Path $basePython)) { return }
    $pyHome = Split-Path $basePython
    $lines = Get-Content $cfg
    $out = foreach ($line in $lines) {
        if ($line -match '^\s*home\s*=') { "home = $pyHome" }
        else { $line }
    }
    Set-Content -Path $cfg -Value $out -Encoding ASCII
}

function Ensure-PythonVenv([string]$root, [string]$basePython) {
    $venvPy = Join-Path $root 'python\.venv\Scripts\python.exe'
    $vendor = Join-Path $root 'vendor\avaya-ossi'
    if (-not (Test-Path $vendor)) {
        throw 'Missing vendor\avaya-ossi - ZIP incomplete. Re-download full package.'
    }
    if (-not (Test-Path $venvPy)) {
        Write-Info 'Creating Python venv under site (first time)...'
        & $basePython -m venv (Join-Path $root 'python\.venv')
        if ($LASTEXITCODE -ne 0) { throw 'python -m venv failed' }
    }
    Repair-VenvHome -root $root -basePython $basePython
    Write-Info "Checking venv import: $venvPy"
    if (Test-AvayaOssiImport -py $venvPy -root $root) {
        Write-Ok "Python OSSI ready (existing venv): $venvPy"
        return ,$venvPy
    }
    $wheelDir = Join-Path $root 'python\wheels'
    $whl = @()
    if (Test-Path $wheelDir) {
        $whl = @(Get-ChildItem -Path $wheelDir -Filter '*.whl' -File -ErrorAction SilentlyContinue)
    }
    if ($whl.Count -gt 0) {
        Write-Info ("Installing paramiko from {0} wheel file(s) (offline, no PyPI)..." -f $whl.Count)
        & $venvPy -m pip install --no-index --find-links $wheelDir setuptools wheel paramiko python-dotenv
        if ($LASTEXITCODE -ne 0) {
            throw "Offline pip failed (setuptools/paramiko). Copy python\wheels\*.whl from Pulse v1.0.4 zip into $wheelDir"
        }
        & $venvPy -m pip install --no-index --no-build-isolation --find-links $wheelDir -e $vendor
        if ($LASTEXITCODE -ne 0) {
            throw "Offline pip of vendor\avaya-ossi failed. Need setuptools wheel in python\wheels."
        }
        if (Test-AvayaOssiImport -py $venvPy -root $root) {
            Write-Ok "Python OSSI ready (wheels): $venvPy"
            return ,$venvPy
        }
        throw "Wheels installed but import avaya_ossi/paramiko failed. Recreate python\.venv and re-run."
    }
    Write-Warn "python\wheels has no .whl files (need v1.0.4 package). Trying PyPI (needs internet)..."
    & $venvPy -m pip install --no-build-isolation -e $vendor
    if ($LASTEXITCODE -ne 0) {
        throw "No python\wheels and PyPI unreachable. Copy python\wheels from v1.0.4 zip, then re-run install.bat."
    }
    if (Test-AvayaOssiImport -py $venvPy -root $root) {
        Write-Ok "Python OSSI ready: $venvPy"
        return ,$venvPy
    }
    throw 'Could not import paramiko. Copy python\wheels from the Pulse zip (v1.0.4+).'
}

function Ensure-ApiPublish([string]$root, [switch]$Force) {
    $apiDll = Join-Path $root 'api\CmApi.dll'
    $csproj = Join-Path $root 'src\CmApi\CmApi.csproj'
    if ((Test-Path $apiDll) -and -not $Force) {
        Write-Ok 'Using prebuilt api\CmApi.dll'
        return
    }
    if (-not (Test-Path $csproj)) {
        if (Test-Path $apiDll) {
            Write-Warn 'No src project; using prebuilt api folder'
            return
        }
        throw 'Neither api\CmApi.dll nor src\CmApi found.'
    }
    $dotnet = Find-DotNet
    if (-not $dotnet) {
        if (Test-Path $apiDll) {
            Write-Ok 'No .NET SDK (Hosting Bundle is enough) - using prebuilt api\CmApi.dll'
            return
        }
        throw 'Need api\CmApi.dll from the Pulse zip, or install .NET 8 SDK to publish.'
    }
    Write-Info "Publishing CmApi..."
    $out = Join-Path $root "api"
    $appcmd = Get-AppCmd
    try { & $appcmd stop apppool /apppool.name:"$AppPoolName" 2>$null | Out-Null } catch {}
    Start-Sleep -Seconds 1
    & $dotnet publish $csproj -c Release -o $out --nologo
    if ($LASTEXITCODE -ne 0) {
        if (Test-Path $apiDll) {
            Write-Warn 'dotnet publish failed; using existing api\CmApi.dll'
            return
        }
        throw 'dotnet publish failed'
    }
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
    # Older install.ps1 created a dedicated "CM-NOC" site on the same port as other apps - remove it
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
        throw "Could not find an IIS site on port $port. Nested mode only adds /CM under an existing site. Pass -ParentSiteName or use -IisMode Dedicated -SitePort 8890 on a free port."
    }

    # SAFETY: snapshot parent root path BEFORE we touch anything - must be unchanged after
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
    # ONLY with explicit -IisMode Dedicated - owns a whole port (not for shared servers)
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
    $src = Join-Path $root "vendor\avaya-ossi\src"
    $vbs = Join-Path $root "scripts\run-hidden.vbs"
    $bind = "127.0.0.1"

    if (-not (Test-Path $script)) { throw "Missing bridge script: $script" }
    if (-not (Test-Path $venvPy)) { throw "Missing venv python: $venvPy" }
    New-Item -ItemType Directory -Force -Path $data | Out-Null

    $exe = $venvPy
    if ($exe -match 'pythonw\.exe$') {
        $exe2 = [regex]::Replace([string]$exe, 'pythonw\.exe$', 'python.exe')
        if (Test-Path $exe2) { $exe = $exe2 }
    }

    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

    # Absolute paths + existing files (avoids WSH 80070002 on first install)
    if ((Test-Path $vbs) -and (Test-Path $exe) -and (Test-Path $script)) {
        $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//nologo `"$vbs`" `"$exe`" `"$script`" $bind $($script:OssiBridgePort) `"$data`" `"$src`"" -WorkingDirectory $work
    } else {
        $arg = "`"$script`" --host $bind --port $($script:OssiBridgePort) --data-dir `"$data`""
        $action = New-ScheduledTaskAction -Execute $exe -Argument $arg -WorkingDirectory $work
    }

    # Headless NOC: AtStartup as SYSTEM (not AtLogOn Interactive)
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -RestartCount 5 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -StartWhenAvailable `
        -Hidden
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    try { Start-ScheduledTask -TaskName $TaskName } catch { Write-Warn "Task start: $_" }
    Write-Ok "Scheduled task $TaskName (AtStartup SYSTEM, bind $bind)"
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
    # Never fail the whole install if bridge start has issues - Login can retry.
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

        Write-Info "Starting bridge (hidden): $py"
        $vbs = Join-Path $root "scripts\run-hidden.vbs"
        $src = Join-Path $root "vendor\avaya-ossi\src"
        if (Test-Path $vbs) {
            Start-Process -FilePath "wscript.exe" -ArgumentList @(
                "//nologo", $vbs, $py, $script, "127.0.0.1", "$($script:OssiBridgePort)", $data, $src
            ) -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
        } else {
            Start-Process -FilePath $py -ArgumentList @(
                $script, "--host", "127.0.0.1", "--port", "$($script:OssiBridgePort)", "--data-dir", $data
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
    Write-Info "Recycling app pool $AppPoolName (max 12s)..."
    try {
        $p = Start-Process -FilePath $appcmd -ArgumentList @("stop", "apppool", "/apppool.name:$AppPoolName") -PassThru -WindowStyle Hidden
        if ($p -and -not $p.WaitForExit(12000)) {
            Write-Warn "apppool stop timed out - not waiting (website may still drain)"
        } else {
            Start-Sleep -Seconds 1
        }
        & $appcmd start apppool /apppool.name:"$AppPoolName" 2>$null | Out-Null
        Write-Ok "App pool $AppPoolName start requested"
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
        Write-Host "Then install .NET 8 Hosting Bundle + Python 3.12 yourself and re-run install.bat."
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
    if (-not $basePy) { throw "Python 3.11/3.12 still not found." }
    Write-Ok "System Python: $basePy"
    Write-Info "Preparing site venv (python\.venv) from that interpreter..."
    $venvPy = Ensure-PythonVenv -root $root -basePython $basePy
    Write-Ok "Bridge will run: $venvPy"

    Ensure-ApiPublish -root $root
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
    Write-Host "  Bridge auto-starts at Windows startup (task CM-NOC-OSSI-Bridge, SYSTEM, 127.0.0.1)"
    Write-Host "  Bridge:      127.0.0.1:18776 (loopback only; firewall/restrict IIS exposure)"
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
