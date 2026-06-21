#requires -Version 5.1
<#
.SYNOPSIS
    Installs the SyncroNow AI CLI (@syncro-now-ai/core) on Windows.

.DESCRIPTION
    Verifies the Node.js / npm prerequisites and installs the CLI globally from
    npm. Credential storage on Windows uses the Windows Credential Manager
    natively through the optional @napi-rs/keyring dependency (enable with
    SYNCRONA_USE_KEYCHAIN=1); no extra setup is required.

    Native Windows is supported in addition to WSL. WSL remains the recommended
    path for parity with the documented Unix workflows.

.PARAMETER Version
    Optional npm dist-tag or version to install (default: latest).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1 -Version alpha
#>
[CmdletBinding()]
param(
    [string]$Version = "latest"
)

$ErrorActionPreference = "Stop"
$MinNodeMajor = 22
$Package = "@syncro-now-ai/core"

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host "SyncroNow AI - Windows installer" -ForegroundColor Cyan

if (-not (Test-Command "node")) {
    throw "Node.js is not installed. Install Node.js >= $MinNodeMajor from https://nodejs.org and re-run."
}
if (-not (Test-Command "npm")) {
    throw "npm is not available on PATH. Reinstall Node.js (which bundles npm) and re-run."
}

$nodeVersion = (& node --version).TrimStart("v")
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt $MinNodeMajor) {
    throw "Node.js $nodeVersion found, but >= $MinNodeMajor is required. Upgrade and re-run."
}
Write-Host "Node.js $nodeVersion detected (>= $MinNodeMajor) - OK" -ForegroundColor Green

$spec = if ($Version -eq "latest") { $Package } else { "$Package@$Version" }
Write-Host "Installing $spec globally via npm..." -ForegroundColor Cyan
& npm install -g $spec
if ($LASTEXITCODE -ne 0) {
    throw "npm install failed with exit code $LASTEXITCODE."
}

if (Test-Command "syncro-now-ai") {
    Write-Host "Installed. Run 'syncro-now-ai --help' to get started." -ForegroundColor Green
    Write-Host "Tip: set SYNCRONA_USE_KEYCHAIN=1 to store credentials in Windows Credential Manager." -ForegroundColor Yellow
} else {
    Write-Warning "Install completed but 'syncro-now-ai' is not on PATH yet. Open a new terminal or check your npm global bin path (npm config get prefix)."
}
