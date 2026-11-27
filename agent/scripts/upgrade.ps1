# Purpose: Upgrade an installed CSLite Windows agent binary or PowerShell lite script in place.
# Context: Invoked manually via `irm .../u.ps1 | iex` or detached by POST /api/devices/:id/upgrade.
# Usage: upgrade.ps1 [-Server <url>] [-Version <tag>] [-BinUrl <url>] [-Lite] [-DryRun]
# Requires: Windows PowerShell 5.1+ / pwsh, existing config.json (or -Server).
[CmdletBinding()]
param(
    [string]$Server = "",
    [string]$Version = "",
    [string]$BinUrl = "",
    [switch]$Lite,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11 -bor [Net.SecurityProtocolType]::Tls
} catch {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$DefaultServer = "__CSLITE_DEFAULT_SERVER__"
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_VERSION)) { $env:CSLITE_VERSION } else { "latest" }
}
if ([string]::IsNullOrWhiteSpace($BinUrl)) { $BinUrl = $env:CSLITE_BIN_URL }

$cfgCandidates = @(
    $(if ($env:CSLITE_CONFIG) { $env:CSLITE_CONFIG }),
    $(if ($env:CSLITE_CONFIG_DIR) { Join-Path $env:CSLITE_CONFIG_DIR "config.json" }),
    $(if ($env:ProgramData) { Join-Path $env:ProgramData "cslite-agent\config.json" }),
    $(if ($env:APPDATA) { Join-Path $env:APPDATA "cslite-agent\config.json" }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "cslite-agent\config.json" })
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$foundCfg = $cfgCandidates | Select-Object -First 1

if ([string]::IsNullOrWhiteSpace($Server) -and $foundCfg) {
    try {
        $cfgData = Get-Content -LiteralPath $foundCfg -Raw | ConvertFrom-Json
        if ($cfgData.server) { $Server = [string]$cfgData.server }
    } catch {}
}
if ([string]::IsNullOrWhiteSpace($Server) -and $DefaultServer -match '^https?://') { $Server = $DefaultServer }
$ServerBase = $Server.Trim().TrimEnd('/')
if ($ServerBase.EndsWith('/api')) { $ServerBase = $ServerBase.Substring(0, $ServerBase.Length - 4) }

$dirCandidates = @(
    $env:CSLITE_INSTALL_DIR,
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles "cslite-agent" }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "cslite-agent" })
) | Where-Object { $_ }

$fullPath = ($dirCandidates | ForEach-Object { Join-Path $_ "cslite-agent.exe" } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1)
$litePath = ($dirCandidates | ForEach-Object { Join-Path $_ "cslite-agent-lite.ps1" } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1)

if ($Lite.IsPresent -or $env:CSLITE_LITE -eq "1") {
    $mode = "lite"
    $targetPath = if ($litePath) { $litePath } else { throw "Installed cslite-agent-lite.ps1 not found." }
} elseif ($fullPath) {
    $mode = "full"
    $targetPath = $fullPath
} elseif ($litePath) {
    $mode = "lite"
    $targetPath = $litePath
} else {
    throw "Installed cslite-agent.exe or cslite-agent-lite.ps1 not found."
}

$arch = if ($env:PROCESSOR_ARCHITEW6432 -match "ARM64" -or $env:PROCESSOR_ARCHITECTURE -match "ARM64") { "arm64" } else { "amd64" }
$dlUrl = $BinUrl
if ([string]::IsNullOrWhiteSpace($dlUrl)) {
    if ($mode -eq "lite") {
        if ([string]::IsNullOrWhiteSpace($ServerBase)) { throw "Server URL required for lite upgrade." }
        $dlUrl = "$ServerBase/agent-lite.ps1"
    } elseif ($Version -eq "latest") {
        $dlUrl = "https://github.com/XRSec/Cslite/releases/latest/download/cslite-agent-windows-$arch.exe"
    } else {
        $dlUrl = "https://github.com/XRSec/Cslite/releases/download/$Version/cslite-agent-windows-$arch.exe"
    }
}

if ($DryRun.IsPresent) {
    Write-Output "mode=$mode"
    Write-Output "target=$targetPath"
    Write-Output "url=$dlUrl"
    Write-Output "config=$foundCfg"
    return
}

$tmp = "$targetPath.new.$PID"
$headers = @{}
if (-not [string]::IsNullOrWhiteSpace($ServerBase) -and $dlUrl.StartsWith("$ServerBase/")) {
    $headers["Referer"] = "$ServerBase/upgrade"
}
if ($dlUrl -match '^file://') {
    Copy-Item -LiteralPath ([Uri]$dlUrl).LocalPath -Destination $tmp -Force
} elseif (Test-Path -LiteralPath $dlUrl) {
    Copy-Item -LiteralPath $dlUrl -Destination $tmp -Force
} else {
    $iwrParams = @{ Uri = $dlUrl; OutFile = $tmp; UserAgent = "CSLite-Installer/1.1"; Headers = $headers; TimeoutSec = 30 }
    if (-not $PSVersionTable -or $PSVersionTable.PSVersion.Major -lt 6) { $iwrParams["UseBasicParsing"] = $true }
    Invoke-WebRequest @iwrParams
}

if ($mode -eq "full") {
    $bytes = [System.IO.File]::ReadAllBytes($tmp)
    if ($bytes.Length -lt 1024 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        throw "Downloaded PE binary failed MZ verification."
    }
} else {
    $txt = [System.IO.File]::ReadAllText($tmp)
    if ([string]::IsNullOrWhiteSpace($txt) -or $txt -match '<html|<!doctype') {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        throw "Downloaded PowerShell script failed validation."
    }
}

if ($env:CSLITE_SKIP_SERVICE_EXEC -eq "1") {
    Move-Item -LiteralPath $tmp -Destination $targetPath -Force
    Write-Host "Upgraded $mode agent -> $targetPath"
    return
}

try {
    if ($mode -eq "full") { & $targetPath stop | Out-Null }
} catch {}
try { Stop-ScheduledTask -TaskName "CsliteAgent" -ErrorAction SilentlyContinue } catch {}
try { Get-Process -Name "cslite-agent" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}

Move-Item -LiteralPath $tmp -Destination $targetPath -Force

try {
    $task = Get-ScheduledTask -TaskName "CsliteAgent" -ErrorAction SilentlyContinue
    if ($task) {
        Start-ScheduledTask -TaskName "CsliteAgent"
        Write-Host "Upgraded and restarted Scheduled Task CsliteAgent ($targetPath)"
        return
    }
} catch {}
if ($mode -eq "full") {
    try { & $targetPath start | Out-Null; Write-Host "Upgraded and started $targetPath"; return } catch {}
}
$cfgArg = if ($foundCfg) { "run --config `"$foundCfg`"" } else { "run" }
$exe = if ($mode -eq "full") { $targetPath } else { "powershell.exe" }
$args = if ($mode -eq "full") { $cfgArg } else { "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$targetPath`" $cfgArg" }
Start-Process -FilePath $exe -ArgumentList $args -WindowStyle Hidden | Out-Null
Write-Host "Upgraded and launched $targetPath"
