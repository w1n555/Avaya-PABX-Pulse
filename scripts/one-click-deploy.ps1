#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Deprecated. The live UI is the site root (index.html, app.js, …), not a web\ copy.

  Use:
    powershell -ExecutionPolicy Bypass -File .\install.ps1

  See INSTALL.txt and README.md.
#>

Write-Host ""
Write-Host "one-click-deploy.ps1 is retired." -ForegroundColor Yellow
Write-Host "It used to copy web\* onto the IIS site root. That duplicate folder is gone."
Write-Host "Install / upgrade with:"
Write-Host ""
Write-Host "  cd <package>\scripts"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\install.ps1"
Write-Host ""
exit 1
