<#
.SYNOPSIS
    Auto-detecting Windows installer for Cslite Agent (Go binary or PowerShell lite fallback).
.EXAMPLE
    .\install.ps1 -Server https://ctrl.example.com -Key ak_live_xxx
    $k="ak_live_xxx";$d="dev_123";irm https://ctrl.example.com/i.ps1|iex
#>
[CmdletBinding()]
param(
    [string]$Server = "",
    [Alias("ApiKey")]
    [string]$Key = "",
    [string]$Name = "",
    [string]$DeviceId = "",
    [int]$PollInterval = 0,
    [int]$HeartbeatInterval = 0,
    [string]$BinUrl = "",
    [string]$Version = "",
    [switch]$Lite,
    [switch]$User
)

$ErrorActionPreference = "Stop"
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11 -bor [Net.SecurityProtocolType]::Tls
} catch {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$DefaultServer = "__CSLITE_DEFAULT_SERVER__"

function Get-CallerStringVar {
    param([string]$VarName)
    $val = Get-Variable -Name $VarName -ValueOnly -ErrorAction SilentlyContinue
    if ($val -is [string] -and -not [string]::IsNullOrWhiteSpace($val)) {
        return $val.Trim()
    }
    return ""
}

# Environment variable & short-variable fallbacks (enables `$k="...";$d="...";irm .../i.ps1|iex`).
if ([string]::IsNullOrWhiteSpace($Server)) {
    if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_SERVER)) {
        $Server = $env:CSLITE_SERVER.Trim()
    } elseif ($DefaultServer -match '^https?://') {
        $Server = $DefaultServer
    }
}
if ([string]::IsNullOrWhiteSpace($Key)) {
    if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_API_KEY)) { $Key = $env:CSLITE_API_KEY.Trim() }
    elseif (-not [string]::IsNullOrWhiteSpace($env:CSLITE_KEY)) { $Key = $env:CSLITE_KEY.Trim() }
    else { $Key = Get-CallerStringVar -VarName "k" }
}
if ([string]::IsNullOrWhiteSpace($DeviceId)) {
    if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_DEVICE_ID)) { $DeviceId = $env:CSLITE_DEVICE_ID.Trim() }
    else { $DeviceId = Get-CallerStringVar -VarName "d" }
}
if ([string]::IsNullOrWhiteSpace($Name)) {
    if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_NAME)) { $Name = $env:CSLITE_NAME.Trim() }
    else { $Name = Get-CallerStringVar -VarName "n" }
}
if ($PollInterval -le 0 -and -not [string]::IsNullOrWhiteSpace($env:CSLITE_POLL_INTERVAL)) {
    [void][int]::TryParse($env:CSLITE_POLL_INTERVAL, [ref]$PollInterval)
}
if ($HeartbeatInterval -le 0 -and -not [string]::IsNullOrWhiteSpace($env:CSLITE_HEARTBEAT_INTERVAL)) {
    [void][int]::TryParse($env:CSLITE_HEARTBEAT_INTERVAL, [ref]$HeartbeatInterval)
}
if ([string]::IsNullOrWhiteSpace($BinUrl)) { $BinUrl = $env:CSLITE_BIN_URL }
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_VERSION)) { $env:CSLITE_VERSION } else { "latest" }
}
$explicitLite = $Lite.IsPresent
if (-not $explicitLite -and ($env:CSLITE_LITE -eq "1" -or $env:CSLITE_LITE -eq "true")) {
    $Lite = [switch]$true
    $explicitLite = $true
}
if (-not $User.IsPresent -and ($env:CSLITE_USER -eq "1" -or $env:CSLITE_USER -eq "true")) {
    $User = [switch]$true
}

if ([string]::IsNullOrWhiteSpace($Server) -or [string]::IsNullOrWhiteSpace($Key)) {
    throw "Server and API key are required. Pass -Server and -Key, or set `$env:CSLITE_SERVER and `$env:CSLITE_API_KEY."
}

$ServerBase = $Server.Trim().TrimEnd('/')
if ($ServerBase.EndsWith('/api')) {
    $ServerBase = $ServerBase.Substring(0, $ServerBase.Length - 4)
}

function Test-IsAdmin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($id)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Get-TargetArch {
    $raw = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrWhiteSpace($raw)) { $raw = $env:PROCESSOR_ARCHITECTURE }
    if ($raw -match "ARM64") { return "arm64" }
    return "amd64"
}

function Test-PeExecutable {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    try {
        $fs = [System.IO.File]::OpenRead($Path)
        try {
            if ($fs.Length -lt 64) { return $false }
            $b0 = $fs.ReadByte()
            $b1 = $fs.ReadByte()
            return ($b0 -eq 0x4D -and $b1 -eq 0x5A)
        } finally {
            $fs.Dispose()
        }
    } catch {
        return $false
    }
}

function Test-PowerShellScript {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    try {
        $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
        if ([string]::IsNullOrWhiteSpace($raw)) { return $false }
        $trimmed = $raw.TrimStart([char]0xFEFF, ' ', "`t", "`r", "`n")
        if ($trimmed.StartsWith("<")) { return $false }
        if ($trimmed.StartsWith("{")) { return $false }
        return $true
    } catch {
        return $false
    }
}

function Download-Resource {
    param(
        [string]$Source,
        [string]$Dest,
        [int]$TimeoutSec = 30
    )
    if ($Source.StartsWith("file://")) {
        $localPath = $Source.Substring(7).TrimStart('/')
        if ($localPath -match '^[A-Za-z]:') {
            Copy-Item -LiteralPath $localPath -Destination $Dest -Force
            return
        }
    }
    if (Test-Path -LiteralPath $Source) {
        Copy-Item -LiteralPath $Source -Destination $Dest -Force
        return
    }
    $dlHeaders = @{}
    if (-not [string]::IsNullOrWhiteSpace($ServerBase) -and $Source.StartsWith("$ServerBase/")) {
        $dlHeaders["Referer"] = "$ServerBase/install"
    }
    if ($PSVersionTable -and $PSVersionTable.PSVersion.Major -ge 6) {
        Invoke-WebRequest -Uri $Source -OutFile $Dest -UserAgent "CSLite-Installer/1.0" -Headers $dlHeaders -TimeoutSec $TimeoutSec
    } else {
        Invoke-WebRequest -Uri $Source -OutFile $Dest -UseBasicParsing -UserAgent "CSLite-Installer/1.0" -Headers $dlHeaders -TimeoutSec $TimeoutSec
    }
}

function Write-AgentConfig {
    param([string]$ConfigPath)
    $dir = Split-Path -Parent $ConfigPath
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $pInt = if ($PollInterval -gt 0) { $PollInterval } else { 5 }
    $hInt = if ($HeartbeatInterval -gt 0) { $HeartbeatInterval } else { 60 }
    $cfgObj = [ordered]@{
        server             = $Server
        api_key            = $Key
        name               = $Name
        device_id          = $DeviceId
        poll_interval      = $pInt
        heartbeat_interval = $hInt
        log_level          = "info"
    }
    $json = ($cfgObj | ConvertTo-Json -Depth 4) + "`n"
    $tmp = "$ConfigPath.tmp.$PID"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tmp, $json, $utf8NoBom)
    Move-Item -LiteralPath $tmp -Destination $ConfigPath -Force
}

function Stop-ExistingAgent {
    param([string]$BinPath, [bool]$AdminMode)
    if ($AdminMode -and (Test-Path -LiteralPath $BinPath)) {
        try { & $BinPath stop | Out-Null } catch {}
    }
    try {
        if (Get-Command Stop-ScheduledTask -ErrorAction SilentlyContinue) {
            $t = Get-ScheduledTask -TaskName "CsliteAgent" -ErrorAction SilentlyContinue
            if ($t) {
                Stop-ScheduledTask -TaskName "CsliteAgent" -ErrorAction SilentlyContinue
            }
        }
    } catch {}
    try {
        Get-Process -Name "cslite-agent" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    } catch {}
}

function Register-AndStartScheduledTask {
    param(
        [string]$Exe,
        [string]$Arguments,
        [string]$ConfigDir,
        [bool]$AdminMode
    )
    $taskName = "CsliteAgent"
    if (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue) {
        try {
            $action = New-ScheduledTaskAction -Execute $Exe -Argument $Arguments
            $trigger = if ($AdminMode) {
                New-ScheduledTaskTrigger -AtStartup
            } else {
                New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
            }
            $settings = New-ScheduledTaskSettingsSet `
                -AllowStartIfOnBatteries `
                -DontStopIfGoingOnBatteries `
                -StartWhenAvailable `
                -ExecutionTimeLimit ([TimeSpan]::Zero) `
                -RestartCount 3 `
                -RestartInterval (New-TimeSpan -Minutes 1)
            if ($AdminMode) {
                $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
            } else {
                $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
            }
            Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
            Start-ScheduledTask -TaskName $taskName
            Write-Host "Registered and started Scheduled Task '$taskName'."
            return
        } catch {
            Write-Warning "Register-ScheduledTask failed ($($_.Exception.Message)); trying fallback launch..."
        }
    }

    # Fallback: start hidden background process directly.
    Start-Process -FilePath $Exe -ArgumentList $Arguments -WindowStyle Hidden -WorkingDirectory $ConfigDir | Out-Null
    Write-Host "Started agent in hidden background process."
}

$arch = Get-TargetArch
$isAdmin = Test-IsAdmin
$useUserScope = $User.IsPresent -or (-not $isAdmin)

if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_INSTALL_DIR)) {
    $installDir = $env:CSLITE_INSTALL_DIR
} elseif ($useUserScope) {
    $localApp = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME "AppData\Local" }
    $installDir = Join-Path $localApp "cslite-agent"
} else {
    $progFiles = if ($env:ProgramFiles) { $env:ProgramFiles } else { "C:\Program Files" }
    $installDir = Join-Path $progFiles "cslite-agent"
}

if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_CONFIG_DIR)) {
    $configDir = $env:CSLITE_CONFIG_DIR
} elseif ($useUserScope) {
    $appData = if ($env:APPDATA) { $env:APPDATA } else { $installDir }
    $configDir = Join-Path $appData "cslite-agent"
} else {
    $progData = if ($env:ProgramData) { $env:ProgramData } else { "C:\ProgramData" }
    $configDir = Join-Path $progData "cslite-agent"
}

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
$configPath = Join-Path $configDir "config.json"
$binPath = Join-Path $installDir "cslite-agent.exe"
$litePath = Join-Path $installDir "cslite-agent-lite.ps1"

$installedFull = $false
if (-not $Lite.IsPresent) {
    $tryUrl = $BinUrl
    if ([string]::IsNullOrWhiteSpace($tryUrl)) {
        if ($Version -eq "latest") {
            $tryUrl = "https://github.com/XRSec/Cslite/releases/latest/download/cslite-agent-windows-$arch.exe"
        } else {
            $tryUrl = "https://github.com/XRSec/Cslite/releases/download/$Version/cslite-agent-windows-$arch.exe"
        }
    }

    $tmpExe = "$binPath.tmp.$PID"
    Write-Host "Downloading cslite-agent (windows/$arch) from $tryUrl..."
    try {
        Download-Resource -Source $tryUrl -Dest $tmpExe -TimeoutSec 15
        if (Test-PeExecutable -Path $tmpExe) {
            Stop-ExistingAgent -BinPath $binPath -AdminMode (-not $useUserScope)
            Move-Item -LiteralPath $tmpExe -Destination $binPath -Force
            $installedFull = $true
        } else {
            Write-Warning "Go binary release not available ($tryUrl returned invalid PE); using PowerShell lite agent..."
            Remove-Item -LiteralPath $tmpExe -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Warning "Go binary release not available ($($_.Exception.Message)); using PowerShell lite agent..."
        Remove-Item -LiteralPath $tmpExe -Force -ErrorAction SilentlyContinue
    }
}

if ($installedFull) {
    if ($env:CSLITE_SKIP_SERVICE_EXEC -eq "1") {
        Write-AgentConfig -ConfigPath $configPath
        Write-Host "Installed Go binary to $binPath (config: $configPath); skipped service start."
        return
    }

    if (-not $useUserScope) {
        $argsList = @("install", "--server", $Server, "--key", $Key, "--config", $configPath)
        if (-not [string]::IsNullOrWhiteSpace($Name)) { $argsList += @("--name", $Name) }
        if (-not [string]::IsNullOrWhiteSpace($DeviceId)) { $argsList += @("--device-id", $DeviceId) }
        if ($PollInterval -gt 0) { $argsList += @("--poll", "$PollInterval") }
        if ($HeartbeatInterval -gt 0) { $argsList += @("--heartbeat", "$HeartbeatInterval") }

        & $binPath @argsList
        if ($LASTEXITCODE -ne 0) {
            throw "cslite-agent install failed with exit code $LASTEXITCODE"
        }
    } else {
        Write-AgentConfig -ConfigPath $configPath
        $taskArgs = "run --config `"$configPath`""
        Register-AndStartScheduledTask -Exe $binPath -Arguments $taskArgs -ConfigDir $configDir -AdminMode $false
    }
    return
}

# PowerShell lite agent fallback
$liteUrl = if ($explicitLite -and -not [string]::IsNullOrWhiteSpace($BinUrl)) {
    $BinUrl
} else {
    "$ServerBase/agent-lite.ps1"
}

$tmpLite = "$litePath.tmp.$PID"
Write-Host "Downloading PowerShell lite agent from $liteUrl..."
try {
    Download-Resource -Source $liteUrl -Dest $tmpLite
    if (-not (Test-PowerShellScript -Path $tmpLite)) {
        throw "Downloaded agent-lite.ps1 is invalid (HTML or empty)."
    }
} catch {
    Remove-Item -LiteralPath $tmpLite -Force -ErrorAction SilentlyContinue
    $localCandidate = if ($PSScriptRoot) { Join-Path $PSScriptRoot "cslite-agent-lite.ps1" } else { "" }
    if ($localCandidate -and (Test-Path -LiteralPath $localCandidate)) {
        Copy-Item -LiteralPath $localCandidate -Destination $tmpLite -Force
    } else {
        $rawFallback = "https://raw.githubusercontent.com/XRSec/Cslite/main/agent/scripts/cslite-agent-lite.ps1"
        Download-Resource -Source $rawFallback -Dest $tmpLite
        if (-not (Test-PowerShellScript -Path $tmpLite)) {
            throw "Failed to obtain valid cslite-agent-lite.ps1"
        }
    }
}

Stop-ExistingAgent -BinPath $binPath -AdminMode (-not $useUserScope)
Move-Item -LiteralPath $tmpLite -Destination $litePath -Force
Write-AgentConfig -ConfigPath $configPath

if ($env:CSLITE_SKIP_SERVICE_EXEC -eq "1") {
    Write-Host "Installed PowerShell lite agent to $litePath (config: $configPath); skipped task registration."
    return
}

$psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $psExe)) { $psExe = "powershell.exe" }
$taskArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$litePath`" run --config `"$configPath`""
Register-AndStartScheduledTask -Exe $psExe -Arguments $taskArgs -ConfigDir $configDir -AdminMode (-not $useUserScope)

Write-Host "Cslite lite agent installed:"
Write-Host "  Script: $litePath"
Write-Host "  Config: $configPath"
