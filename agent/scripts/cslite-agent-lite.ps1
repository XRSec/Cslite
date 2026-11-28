# Cslite Ultra-Lightweight Windows PowerShell Agent (PS 5.1+ / PS 7+)
# Zero external dependencies; implements /api/agent/* protocol with UTF-8 output and atomic state.

$ErrorActionPreference = "Stop"
$Version = "v1.2.1"

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11 -bor [Net.SecurityProtocolType]::Tls
} catch {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$script:PrevCpuTotal = [uint64]0
$script:PrevCpuIdle = [uint64]0
$script:HasPrevCpu = $false
$script:PrevNetRx = [int64]0
$script:PrevNetTx = [int64]0
$script:PrevNetTime = [DateTime]::MinValue
$script:HasPrevNet = $false

function Write-Log {
    param([string]$Level, [string]$Message, [string]$MinLevel = "info")
    if ($Level -eq "DEBUG" -and $MinLevel -ne "debug") { return }
    $ts = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    [Console]::Error.WriteLine("$ts [$Level] $Message")
}

function Test-IsElevated {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $p = New-Object Security.Principal.WindowsPrincipal($id)
        return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Resolve-AgentPaths {
    param([string]$ExplicitConfig, [bool]$UserMode)

    if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_CONFIG_DIR)) {
        $dir = $env:CSLITE_CONFIG_DIR.Trim()
    } elseif (-not $UserMode -and (Test-IsElevated)) {
        $pd = if ($env:ProgramData) { $env:ProgramData } else { "C:\ProgramData" }
        $dir = Join-Path $pd "cslite-agent"
    } else {
        $base = if ($env:APPDATA) { $env:APPDATA } elseif ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [System.IO.Path]::GetTempPath() }
        $dir = Join-Path $base "cslite-agent"
    }

    $cfgFile = Join-Path $dir "config.json"
    $stateDir = $dir
    $stateFile = Join-Path $stateDir "state.json"
    $logFile = Join-Path $dir "cslite-agent.log"

    if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_STATE_FILE)) {
        $stateFile = $env:CSLITE_STATE_FILE.Trim()
        $stateDir = Split-Path -Parent $stateFile
    }

    $cfgOverride = if (-not [string]::IsNullOrWhiteSpace($ExplicitConfig)) { $ExplicitConfig } else { $env:CSLITE_CONFIG }
    if (-not [string]::IsNullOrWhiteSpace($cfgOverride)) {
        $cfgFile = $cfgOverride.Trim()
        $dir = Split-Path -Parent $cfgFile
        if ([string]::IsNullOrWhiteSpace($env:CSLITE_CONFIG_DIR) -and [string]::IsNullOrWhiteSpace($env:CSLITE_STATE_FILE)) {
            $stateDir = $dir
            $stateFile = Join-Path $dir "state.json"
            $logFile = Join-Path $dir "cslite-agent.log"
        }
    }

    return @{
        ConfigDir  = $dir
        ConfigFile = $cfgFile
        StateDir   = $stateDir
        StateFile  = $stateFile
        LogFile    = $logFile
    }
}

function Write-Utf8Atomic {
    param([string]$Path, [string]$Content)
    $dir = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($dir) -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $tmp = Join-Path $dir (".tmp-" + [Guid]::NewGuid().ToString("N"))
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    try {
        [System.IO.File]::WriteAllText($tmp, $Content, $utf8NoBom)
        Move-Item -LiteralPath $tmp -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $tmp) {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
    }
}

function Normalize-ServerUrl {
    param([string]$Raw)
    $u = $Raw.Trim().TrimEnd('/')
    if (-not $u.EndsWith('/api')) {
        $u = "$u/api"
    }
    return $u
}

function Get-PlatformInfo {
    $rawArch = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrWhiteSpace($rawArch)) { $rawArch = $env:PROCESSOR_ARCHITECTURE }
    $arch = if ($rawArch -match "ARM64") { "arm64" } else { "amd64" }

    $osVer = "Windows"
    try {
        $reg = Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion" -ErrorAction Stop
        if ($reg.ProductName) {
            $osVer = [string]$reg.ProductName
            if ($reg.DisplayVersion) { $osVer += " $($reg.DisplayVersion)" }
            if ($reg.CurrentBuildNumber) { $osVer += " (Build $($reg.CurrentBuildNumber))" }
        }
    } catch {
        try {
            $osVer = [System.Environment]::OSVersion.VersionString
        } catch {}
    }

    $hostname = $env:COMPUTERNAME
    try {
        $dnsHost = [System.Net.Dns]::GetHostName()
        if (-not [string]::IsNullOrWhiteSpace($dnsHost)) { $hostname = $dnsHost }
    } catch {}

    return @{
        Platform  = "windows"
        Arch      = $arch
        OSVersion = $osVer
        Hostname  = $hostname
    }
}

function Initialize-NativeHelpers {
    if ("CsliteNative.WinSys" -as [type]) { return $true }
    $code = @"
using System;
using System.Runtime.InteropServices;

namespace CsliteNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct FILETIME {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
    }

    public static class WinSys {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetSystemTimes(out FILETIME idle, out FILETIME kernel, out FILETIME user);

        public static bool ReadCpuTimes(out ulong total, out ulong idle) {
            FILETIME ftIdle, ftKernel, ftUser;
            total = 0;
            idle = 0;
            if (!GetSystemTimes(out ftIdle, out ftKernel, out ftUser)) return false;
            ulong i = ((ulong)ftIdle.dwHighDateTime << 32) | ftIdle.dwLowDateTime;
            ulong k = ((ulong)ftKernel.dwHighDateTime << 32) | ftKernel.dwLowDateTime;
            ulong u = ((ulong)ftUser.dwHighDateTime << 32) | ftUser.dwLowDateTime;
            idle = i;
            total = k + u;
            return true;
        }
    }
}
"@
    try {
        Add-Type -TypeDefinition $code -Language CSharp -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Get-HostMetrics {
    $cpuPct = 0.0
    $memUsed = 0
    $memTotal = 0
    $memPct = 0.0
    $diskPct = 0.0
    $diskTotal = [int64]0
    $netIn = 0
    $netOut = 0
    $uptime = [int64]0

    # CPU usage via GetSystemTimes delta, with CIM fallback.
    $gotNativeCpu = $false
    if (Initialize-NativeHelpers) {
        try {
            $tot = [uint64]0
            $idle = [uint64]0
            if ([CsliteNative.WinSys]::ReadCpuTimes([ref]$tot, [ref]$idle)) {
                $gotNativeCpu = $true
                if ($script:HasPrevCpu -and $tot -gt $script:PrevCpuTotal) {
                    $dt = [double]($tot - $script:PrevCpuTotal)
                    $di = if ($idle -ge $script:PrevCpuIdle) { [double]($idle - $script:PrevCpuIdle) } else { 0.0 }
                    if ($di -lt $dt) {
                        $cpuPct = [Math]::Round((($dt - $di) / $dt) * 100.0, 2)
                    }
                }
                $script:PrevCpuTotal = $tot
                $script:PrevCpuIdle = $idle
                $script:HasPrevCpu = $true
            }
        } catch {}
    }
    if (-not $gotNativeCpu) {
        try {
            $procLoad = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Measure-Object -Property LoadPercentage -Average
            if ($null -ne $procLoad.Average) {
                $cpuPct = [Math]::Round([double]$procLoad.Average, 2)
            }
        } catch {}
    }

    # RAM & Uptime via Win32_OperatingSystem.
    try {
        $os = if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) {
            Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        } else {
            Get-WmiObject -Class Win32_OperatingSystem -ErrorAction Stop
        }
        if ($os -and [double]$os.TotalVisibleMemorySize -gt 0) {
            $totKB = [double]$os.TotalVisibleMemorySize
            $freeKB = [double]$os.FreePhysicalMemory
            $usedKB = [Math]::Max(0.0, $totKB - $freeKB)
            $memTotal = [int][Math]::Floor($totKB / 1024.0)
            $memUsed = [int][Math]::Floor($usedKB / 1024.0)
            $memPct = [Math]::Round(($usedKB / $totKB) * 100.0, 2)
        }
        if ($os -and $os.LastBootUpTime) {
            $bootUtc = if ($os.LastBootUpTime -is [DateTime]) {
                $os.LastBootUpTime.ToUniversalTime()
            } else {
                [System.Management.ManagementDateTimeConverter]::ToDateTime($os.LastBootUpTime).ToUniversalTime()
            }
            $uptime = [int64][Math]::Max(0, ([DateTime]::UtcNow - $bootUtc).TotalSeconds)
        }
    } catch {}

    # Disk usage via DriveInfo on SystemDrive.
    try {
        $sysDrive = if ($env:SystemDrive) { $env:SystemDrive.TrimEnd('\') + '\' } else { 'C:\' }
        $drv = New-Object System.IO.DriveInfo($sysDrive)
        if ($drv.IsReady -and $drv.TotalSize -gt 0) {
            $totB = [double]$drv.TotalSize
            $freeB = [double]$drv.TotalFreeSpace
            $usedB = [Math]::Max(0.0, $totB - $freeB)
            $diskTotal = [int64][Math]::Floor($totB / 1048576.0)
            $diskPct = [Math]::Round(($usedB / $totB) * 100.0, 2)
        }
    } catch {}

    # Network KB/s rate via .NET NetworkInterface delta.
    try {
        $rx = [int64]0
        $tx = [int64]0
        foreach ($ni in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
            if ($ni.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
            if ($ni.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback) { continue }
            $stats = $ni.GetIPv4Statistics()
            $rx += $stats.BytesReceived
            $tx += $stats.BytesSent
        }
        $now = [DateTime]::UtcNow
        if ($script:HasPrevNet) {
            $elapsed = ($now - $script:PrevNetTime).TotalSeconds
            if ($elapsed -gt 0.1) {
                if ($rx -ge $script:PrevNetRx) { $netIn = [int][Math]::Floor(($rx - $script:PrevNetRx) / $elapsed / 1024.0) }
                if ($tx -ge $script:PrevNetTx) { $netOut = [int][Math]::Floor(($tx - $script:PrevNetTx) / $elapsed / 1024.0) }
            }
        }
        $script:PrevNetRx = $rx
        $script:PrevNetTx = $tx
        $script:PrevNetTime = $now
        $script:HasPrevNet = $true
    } catch {}

    $ipList = @()
    try {
        if (Get-Command Get-NetIPAddress -ErrorAction SilentlyContinue) {
            $ipList = @(Get-NetIPAddress -ErrorAction SilentlyContinue | Where-Object {
                $_.IPAddress -and
                $_.IPAddress -notmatch '^(127\.|169\.254\.|0\.0\.0\.0$|::1$|::$|fe80:|ff)'
            } | Select-Object -ExpandProperty IPAddress -Unique | Select-Object -First 128)
        }
    } catch {}

    return [ordered]@{
        cpu_usage      = $cpuPct
        memory_used    = $memUsed
        memory_total   = $memTotal
        memory_percent = $memPct
        disk_usage     = $diskPct
        disk_total     = $diskTotal
        network_in     = $netIn
        network_out    = $netOut
        uptime         = $uptime
        ip_addresses   = $ipList
    }
}

function Invoke-CsliteApi {
    param(
        [string]$Method,
        [string]$BaseUrl,
        [string]$Path,
        [string]$ApiKey,
        [object]$BodyObj = $null,
        [string]$UserAgent = "",
        [string]$Referer = ""
    )
    $url = "$BaseUrl$Path"
    $baseRoot = $BaseUrl -replace '/api$', ''
    $effUa = if (-not [string]::IsNullOrWhiteSpace($UserAgent)) { $UserAgent.Trim() } else { "CSLite-Agent/ps-$Version" }
    $effRef = if (-not [string]::IsNullOrWhiteSpace($Referer)) { $Referer.Trim() } elseif (-not [string]::IsNullOrWhiteSpace($baseRoot)) { "$baseRoot/agent/telemetry" } else { "" }

    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.Method = $Method
    $req.Timeout = 30000
    $req.ReadWriteTimeout = 30000
    $req.UserAgent = $effUa
    if (-not [string]::IsNullOrWhiteSpace($effRef)) {
        $req.Referer = $effRef
    }
    $req.Accept = "application/json"
    $req.Headers.Add("X-API-Key", $ApiKey)

    if ($null -ne $BodyObj) {
        $jsonBody = ($BodyObj | ConvertTo-Json -Depth 6 -Compress)
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($jsonBody)
        $req.ContentType = "application/json; charset=utf-8"
        $req.ContentLength = $bytes.Length
        $reqStream = $req.GetRequestStream()
        try {
            $reqStream.Write($bytes, 0, $bytes.Length)
        } finally {
            $reqStream.Dispose()
        }
    }

    $statusCode = 0
    $respText = ""
    try {
        $resp = $req.GetResponse()
        try {
            $statusCode = [int]$resp.StatusCode
            $stream = $resp.GetResponseStream()
            if ($null -ne $stream) {
                $sr = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
                try { $respText = $sr.ReadToEnd() } finally { $sr.Dispose() }
            }
        } finally {
            $resp.Dispose()
        }
    } catch [System.Net.WebException] {
        $errResp = $_.Exception.Response
        if ($null -eq $errResp) {
            throw
        }
        try {
            $statusCode = [int]$errResp.StatusCode
            $stream = $errResp.GetResponseStream()
            if ($null -ne $stream) {
                $sr = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
                try { $respText = $sr.ReadToEnd() } finally { $sr.Dispose() }
            }
        } finally {
            $errResp.Dispose()
        }
    }

    $parsed = $null
    if (-not [string]::IsNullOrWhiteSpace($respText)) {
        try {
            $parsed = $respText | ConvertFrom-Json
        } catch {}
    }

    return @{
        StatusCode = $statusCode
        Raw        = $respText
        Json       = $parsed
    }
}

function Load-Config {
    param([hashtable]$Cli)
    $paths = Resolve-AgentPaths -ExplicitConfig $Cli.ConfigFile -UserMode $Cli.UserMode
    $cfg = @{
        Server            = ""
        APIKey            = ""
        Name              = ""
        DeviceID          = ""
        UserAgent         = ""
        Referer           = ""
        PollInterval      = 5
        HeartbeatInterval = 60
        ExplicitPoll      = $false
        ExplicitHeartbeat = $false
        LogLevel          = "info"
        Paths             = $paths
    }

    if (Test-Path -LiteralPath $paths.ConfigFile) {
        try {
            $raw = [System.IO.File]::ReadAllText($paths.ConfigFile, [System.Text.Encoding]::UTF8)
            if (-not [string]::IsNullOrWhiteSpace($raw)) {
                $fc = $raw | ConvertFrom-Json
                if ($fc.server) { $cfg.Server = ([string]$fc.server).Trim() }
                if ($fc.api_key) { $cfg.APIKey = ([string]$fc.api_key).Trim() }
                if ($fc.name) { $cfg.Name = ([string]$fc.name).Trim() }
                if ($fc.device_id) { $cfg.DeviceID = ([string]$fc.device_id).Trim() }
                if ($fc.user_agent) { $cfg.UserAgent = ([string]$fc.user_agent).Trim() }
                if ($fc.referer) { $cfg.Referer = ([string]$fc.referer).Trim() }
                if ($fc.poll_interval -and [int]$fc.poll_interval -gt 0) {
                    $cfg.PollInterval = [int]$fc.poll_interval
                    if ($cfg.PollInterval -ne 5) { $cfg.ExplicitPoll = $true }
                }
                if ($fc.heartbeat_interval -and [int]$fc.heartbeat_interval -gt 0) {
                    $cfg.HeartbeatInterval = [int]$fc.heartbeat_interval
                    if ($cfg.HeartbeatInterval -ne 60) { $cfg.ExplicitHeartbeat = $true }
                }
                if ($fc.log_level) { $cfg.LogLevel = ([string]$fc.log_level).Trim().ToLower() }
            }
        } catch {
            Write-Log -Level "WARN" -Message "Failed to parse config $($paths.ConfigFile): $($_.Exception.Message)"
        }
    }

    # Env vars override config.json
    if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_SERVER)) { $cfg.Server = $env:CSLITE_SERVER.Trim() }
    elseif ([string]::IsNullOrWhiteSpace($cfg.Server) -and -not [string]::IsNullOrWhiteSpace($env:AGENT_SERVER)) { $cfg.Server = $env:AGENT_SERVER.Trim() }

    if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_API_KEY)) { $cfg.APIKey = $env:CSLITE_API_KEY.Trim() }
    elseif ([string]::IsNullOrWhiteSpace($cfg.APIKey) -and -not [string]::IsNullOrWhiteSpace($env:AGENT_API_KEY)) { $cfg.APIKey = $env:AGENT_API_KEY.Trim() }
    elseif ([string]::IsNullOrWhiteSpace($cfg.APIKey) -and -not [string]::IsNullOrWhiteSpace($env:AGENT_KEY)) { $cfg.APIKey = $env:AGENT_KEY.Trim() }

    if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_NAME)) { $cfg.Name = $env:CSLITE_NAME.Trim() }
    elseif ([string]::IsNullOrWhiteSpace($cfg.Name) -and -not [string]::IsNullOrWhiteSpace($env:AGENT_NAME)) { $cfg.Name = $env:AGENT_NAME.Trim() }

    if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_DEVICE_ID)) { $cfg.DeviceID = $env:CSLITE_DEVICE_ID.Trim() }
    elseif ([string]::IsNullOrWhiteSpace($cfg.DeviceID) -and -not [string]::IsNullOrWhiteSpace($env:AGENT_DEVICE_ID)) { $cfg.DeviceID = $env:AGENT_DEVICE_ID.Trim() }

    if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_USER_AGENT)) { $cfg.UserAgent = $env:CSLITE_USER_AGENT.Trim() }
    if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_REFERER)) { $cfg.Referer = $env:CSLITE_REFERER.Trim() }

    $tmpInt = 0
    if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_POLL_INTERVAL) -and [int]::TryParse($env:CSLITE_POLL_INTERVAL, [ref]$tmpInt) -and $tmpInt -gt 0) {
        $cfg.PollInterval = $tmpInt
        $cfg.ExplicitPoll = $true
    }
    if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_HEARTBEAT_INTERVAL) -and [int]::TryParse($env:CSLITE_HEARTBEAT_INTERVAL, [ref]$tmpInt) -and $tmpInt -gt 0) {
        $cfg.HeartbeatInterval = $tmpInt
        $cfg.ExplicitHeartbeat = $true
    } elseif (-not [string]::IsNullOrWhiteSpace($env:AGENT_INTERVAL) -and [int]::TryParse($env:AGENT_INTERVAL, [ref]$tmpInt) -and $tmpInt -gt 0) {
        $cfg.HeartbeatInterval = $tmpInt
        $cfg.ExplicitHeartbeat = $true
    }
    if (-not [string]::IsNullOrWhiteSpace($env:CSLITE_LOG_LEVEL)) {
        $cfg.LogLevel = $env:CSLITE_LOG_LEVEL.Trim().ToLower()
    }

    # CLI flags take highest precedence
    if (-not [string]::IsNullOrWhiteSpace($Cli.Server)) { $cfg.Server = $Cli.Server.Trim() }
    if (-not [string]::IsNullOrWhiteSpace($Cli.APIKey)) { $cfg.APIKey = $Cli.APIKey.Trim() }
    if (-not [string]::IsNullOrWhiteSpace($Cli.Name)) { $cfg.Name = $Cli.Name.Trim() }
    if (-not [string]::IsNullOrWhiteSpace($Cli.DeviceID)) { $cfg.DeviceID = $Cli.DeviceID.Trim() }
    if (-not [string]::IsNullOrWhiteSpace($Cli.UserAgent)) { $cfg.UserAgent = $Cli.UserAgent.Trim() }
    if (-not [string]::IsNullOrWhiteSpace($Cli.Referer)) { $cfg.Referer = $Cli.Referer.Trim() }
    if ($Cli.PollInterval -gt 0) { $cfg.PollInterval = $Cli.PollInterval; $cfg.ExplicitPoll = $true }
    if ($Cli.HeartbeatInterval -gt 0) { $cfg.HeartbeatInterval = $Cli.HeartbeatInterval; $cfg.ExplicitHeartbeat = $true }
    if (-not [string]::IsNullOrWhiteSpace($Cli.LogLevel)) { $cfg.LogLevel = $Cli.LogLevel.Trim().ToLower() }

    if ($cfg.PollInterval -le 0) { $cfg.PollInterval = 5; $cfg.ExplicitPoll = $false }
    if ($cfg.HeartbeatInterval -le 0) { $cfg.HeartbeatInterval = 60; $cfg.ExplicitHeartbeat = $false }
    return $cfg
}

function Save-Config {
    param([hashtable]$Cfg)
    $obj = [ordered]@{
        server             = $Cfg.Server
        api_key            = $Cfg.APIKey
        name               = $Cfg.Name
        device_id          = $Cfg.DeviceID
        poll_interval      = $Cfg.PollInterval
        heartbeat_interval = $Cfg.HeartbeatInterval
        log_level          = $Cfg.LogLevel
    }
    if (-not [string]::IsNullOrWhiteSpace($Cfg.UserAgent)) { $obj["user_agent"] = $Cfg.UserAgent }
    if (-not [string]::IsNullOrWhiteSpace($Cfg.Referer)) { $obj["referer"] = $Cfg.Referer }
    Write-Utf8Atomic -Path $Cfg.Paths.ConfigFile -Content (($obj | ConvertTo-Json -Depth 4) + "`n")
}

function Load-State {
    param([string]$StatePath, [string]$BaseUrl, [string]$ConfiguredDeviceId)
    if (-not (Test-Path -LiteralPath $StatePath)) { return $null }
    try {
        $raw = [System.IO.File]::ReadAllText($StatePath, [System.Text.Encoding]::UTF8)
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        $st = $raw | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace($st.agent_id) -or [string]::IsNullOrWhiteSpace($st.device_id)) { return $null }
        if ($st.server_url -ne $BaseUrl) { return $null }
        if (-not [string]::IsNullOrWhiteSpace($ConfiguredDeviceId) -and $st.device_id -ne $ConfiguredDeviceId) { return $null }
        return @{
            AgentID  = [string]$st.agent_id
            DeviceID = [string]$st.device_id
        }
    } catch {
        return $null
    }
}

function Save-State {
    param([string]$StatePath, [string]$AgentID, [string]$DeviceID, [string]$BaseUrl)
    $obj = [ordered]@{
        agent_id   = $AgentID
        device_id  = $DeviceID
        server_url = $BaseUrl
    }
    Write-Utf8Atomic -Path $StatePath -Content (($obj | ConvertTo-Json -Depth 4) + "`n")
}

function Apply-ServerIntervals {
    param([hashtable]$Cfg, [object]$Data)
    if ($null -eq $Data) { return }
    if (-not $Cfg.ExplicitHeartbeat) {
        $hbVal = 0
        if ($Data.PSObject.Properties["next_heartbeat"] -and $null -ne $Data.next_heartbeat) {
            [void][int]::TryParse([string]$Data.next_heartbeat, [ref]$hbVal)
        } elseif ($Data.PSObject.Properties["heartbeat_interval"] -and $null -ne $Data.heartbeat_interval) {
            [void][int]::TryParse([string]$Data.heartbeat_interval, [ref]$hbVal)
        }
        if ($hbVal -gt 0) { $Cfg.HeartbeatInterval = $hbVal }
    }
    if (-not $Cfg.ExplicitPoll) {
        $pollVal = 0
        if ($Data.PSObject.Properties["poll_interval"] -and $null -ne $Data.poll_interval) {
            [void][int]::TryParse([string]$Data.poll_interval, [ref]$pollVal)
        }
        if ($pollVal -gt 0) { $Cfg.PollInterval = $pollVal }
    }
}

function Register-Agent {
    param([hashtable]$Cfg, [string]$BaseUrl, [hashtable]$PlatformInfo)
    $devName = if (-not [string]::IsNullOrWhiteSpace($Cfg.Name)) { $Cfg.Name } else { $PlatformInfo.Hostname }
    $body = [ordered]@{
        name       = $devName
        platform   = $PlatformInfo.Platform
        arch       = $PlatformInfo.Arch
        os_version = $PlatformInfo.OSVersion
        hostname   = $PlatformInfo.Hostname
        version    = $Version
        api_key    = $Cfg.APIKey
    }
    if (-not [string]::IsNullOrWhiteSpace($Cfg.DeviceID)) {
        $body["device_id"] = $Cfg.DeviceID
    }

    $res = Invoke-CsliteApi -Method "POST" -BaseUrl $BaseUrl -Path "/agent/register" -ApiKey $Cfg.APIKey -BodyObj $body -UserAgent $Cfg.UserAgent -Referer $Cfg.Referer
    if ($null -eq $res.Json -or $res.Json.code -ne 20000) {
        $msg = if ($res.Json -and $res.Json.message) { $res.Json.message } else { $res.Raw }
        $code = if ($res.Json) { $res.Json.code } else { $res.StatusCode }
        throw "register failed (code=$code): $msg"
    }

    $aid = [string]$res.Json.data.agent_id
    $did = [string]$res.Json.data.device_id
    if ([string]::IsNullOrWhiteSpace($aid) -or [string]::IsNullOrWhiteSpace($did)) {
        throw "register response missing agent_id or device_id"
    }

    Apply-ServerIntervals -Cfg $Cfg -Data $res.Json.data
    Save-State -StatePath $Cfg.Paths.StateFile -AgentID $aid -DeviceID $did -BaseUrl $BaseUrl
    Write-Log -Level "INFO" -Message "registered agent_id=$aid device_id=$did" -MinLevel $Cfg.LogLevel
    return @{ AgentID = $aid; DeviceID = $did }
}

function Ensure-Registered {
    param([hashtable]$Cfg, [string]$BaseUrl, [hashtable]$PlatformInfo)
    $st = Load-State -StatePath $Cfg.Paths.StateFile -BaseUrl $BaseUrl -ConfiguredDeviceId $Cfg.DeviceID
    if ($null -ne $st) {
        Write-Log -Level "DEBUG" -Message "loaded state agent_id=$($st.AgentID) device_id=$($st.DeviceID)" -MinLevel $Cfg.LogLevel
        return $st
    }
    return (Register-Agent -Cfg $Cfg -BaseUrl $BaseUrl -PlatformInfo $PlatformInfo)
}

function Send-Heartbeat {
    param([hashtable]$Cfg, [string]$BaseUrl, [hashtable]$PlatformInfo, [hashtable]$State)
    $metrics = Get-HostMetrics
    $body = [ordered]@{
        agent_id   = $State.AgentID
        device_id  = $State.DeviceID
        api_key    = $Cfg.APIKey
        metrics    = $metrics
        version    = $Version
        os_version = $PlatformInfo.OSVersion
        hostname   = $PlatformInfo.Hostname
        timestamp  = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    }

    $res = Invoke-CsliteApi -Method "POST" -BaseUrl $BaseUrl -Path "/agent/heartbeat" -ApiKey $Cfg.APIKey -BodyObj $body -UserAgent $Cfg.UserAgent -Referer $Cfg.Referer
    if ($res.StatusCode -eq 404 -or ($res.Json -and $res.Json.code -eq 40010)) {
        Write-Log -Level "WARN" -Message "heartbeat returned 40010 (DEVICE_NOT_FOUND); re-registering" -MinLevel $Cfg.LogLevel
        Remove-Item -LiteralPath $Cfg.Paths.StateFile -Force -ErrorAction SilentlyContinue
        $newState = Register-Agent -Cfg $Cfg -BaseUrl $BaseUrl -PlatformInfo $PlatformInfo
        $State.AgentID = $newState.AgentID
        $State.DeviceID = $newState.DeviceID
        $body["agent_id"] = $State.AgentID
        $body["device_id"] = $State.DeviceID
        $res = Invoke-CsliteApi -Method "POST" -BaseUrl $BaseUrl -Path "/agent/heartbeat" -ApiKey $Cfg.APIKey -BodyObj $body -UserAgent $Cfg.UserAgent -Referer $Cfg.Referer
    }

    if ($null -eq $res.Json -or $res.Json.code -ne 20000) {
        $msg = if ($res.Json -and $res.Json.message) { $res.Json.message } else { $res.Raw }
        throw "heartbeat failed: $msg"
    }
    Apply-ServerIntervals -Cfg $Cfg -Data $res.Json.data
    Write-Log -Level "DEBUG" -Message "heartbeat ok" -MinLevel $Cfg.LogLevel
}

function Limit-Utf8Output {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return "" }
    $maxBytes = 65536
    $enc = [System.Text.Encoding]::UTF8
    $bytes = $enc.GetBytes($Text)
    if ($bytes.Length -le $maxBytes) { return $Text }
    $cut = $maxBytes
    while ($cut -gt 0 -and (($bytes[$cut] -band 0xC0) -eq 0x80)) {
        $cut--
    }
    return ($enc.GetString($bytes, 0, $cut) + "`n... (truncated)`n")
}

function Invoke-TaskAndReport {
    param([hashtable]$Cfg, [string]$BaseUrl, [hashtable]$State, [object]$Task)

    $execId = [string]$Task.execution_id
    if ([string]::IsNullOrWhiteSpace($execId)) { return }
    $resultId = [string]$Task.result_id
    $cmdId = [string]$Task.command_id
    $content = [string]$Task.content
    $timeoutSec = if ($Task.timeout -and [int]$Task.timeout -gt 0) { [int]$Task.timeout } else { 600 }
    $shellReq = if ($Task.shell) { ([string]$Task.shell).Trim().ToLower() } else { "" }

    $exeBin = ""
    $psiArgs = ""
    switch ($shellReq) {
        { $_ -eq "" -or $_ -eq "cmd" -or $_ -eq "cmd.exe" } {
            $exeBin = "cmd.exe"
            $psiArgs = "/S /C `"chcp 65001>nul & $content`""
        }
        { $_ -eq "powershell" -or $_ -eq "powershell.exe" -or $_ -eq "pwsh" } {
            $exeBin = if ($shellReq -eq "pwsh" -and (Get-Command pwsh.exe -ErrorAction SilentlyContinue)) { "pwsh.exe" } else { "powershell.exe" }
            $wrapped = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $content"
            $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($wrapped))
            $psiArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
        }
        default {
            $exeBin = ""
        }
    }

    $status = "completed"
    $exitCode = 0
    $combinedOut = ""

    if ([string]::IsNullOrWhiteSpace($exeBin)) {
        $status = "failed"
        $exitCode = -1
        $combinedOut = "unsupported shell: $shellReq"
    } else {
        Write-Log -Level "INFO" -Message "executing cmd_id=$cmdId execution_id=$execId timeout=${timeoutSec}s" -MinLevel $Cfg.LogLevel
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $exeBin
        $psi.Arguments = $psiArgs
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

        if ($null -ne $Task.env_vars) {
            foreach ($prop in $Task.env_vars.PSObject.Properties) {
                if (-not [string]::IsNullOrWhiteSpace($prop.Name)) {
                    $psi.EnvironmentVariables[$prop.Name] = [string]$prop.Value
                }
            }
        }

        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        try {
            [void]$proc.Start()
            $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
            $stderrTask = $proc.StandardError.ReadToEndAsync()

            $exited = $proc.WaitForExit($timeoutSec * 1000)
            if (-not $exited) {
                $status = "timeout"
                $exitCode = -1
                try {
                    & taskkill.exe /T /F /PID $proc.Id 2>$null | Out-Null
                } catch {}
                try {
                    if (-not $proc.HasExited) { $proc.Kill() }
                } catch {}
                [void]$proc.WaitForExit(2000)
            } else {
                $exitCode = $proc.ExitCode
                if ($exitCode -ne 0) { $status = "failed" }
            }

            try { [void]$stdoutTask.Wait(2000) } catch {}
            try { [void]$stderrTask.Wait(2000) } catch {}
            $outText = if ($stdoutTask.IsCompleted -and -not $stdoutTask.IsFaulted) { $stdoutTask.Result } else { "" }
            $errText = if ($stderrTask.IsCompleted -and -not $stderrTask.IsFaulted) { $stderrTask.Result } else { "" }
            $combinedOut = $outText
            if (-not [string]::IsNullOrEmpty($errText)) {
                if (-not [string]::IsNullOrEmpty($combinedOut) -and -not $combinedOut.EndsWith("`n")) {
                    $combinedOut += "`n"
                }
                $combinedOut += $errText
            }
        } catch {
            $status = "failed"
            $exitCode = -1
            $combinedOut = "failed to execute command: $($_.Exception.Message)"
        } finally {
            $proc.Dispose()
        }
    }

    $payload = [ordered]@{
        execution_id = $execId
        device_id    = $State.DeviceID
        api_key      = $Cfg.APIKey
        status       = $status
        exit_code    = $exitCode
        output       = (Limit-Utf8Output -Text $combinedOut)
        completed_at = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
    if (-not [string]::IsNullOrWhiteSpace($resultId)) {
        $payload["result_id"] = $resultId
    }

    foreach ($delay in @(1, 2, 4)) {
        try {
            $rep = Invoke-CsliteApi -Method "POST" -BaseUrl $BaseUrl -Path "/agent/result" -ApiKey $Cfg.APIKey -BodyObj $payload -UserAgent $Cfg.UserAgent -Referer $Cfg.Referer
            if ($rep.Json -and $rep.Json.code -eq 20000) {
                Write-Log -Level "INFO" -Message "reported execution_id=$execId status=$status exit_code=$exitCode" -MinLevel $Cfg.LogLevel
                return
            }
        } catch {}
        Start-Sleep -Seconds $delay
    }
    Write-Log -Level "ERROR" -Message "failed to report result for execution_id=$execId" -MinLevel $Cfg.LogLevel
}

function Poll-Once {
    param(
        [hashtable]$Cfg,
        [string]$BaseUrl,
        [hashtable]$PlatformInfo,
        [hashtable]$State,
        [bool]$IncludeMetrics = $false
    )

    $body = [ordered]@{
        agent_id = $State.AgentID
        api_key  = $Cfg.APIKey
        limit    = 1
    }
    if ($IncludeMetrics) {
        $body["metrics"] = (Get-HostMetrics)
        $body["version"] = $Version
        $body["os_version"] = $PlatformInfo.OSVersion
        $body["hostname"] = $PlatformInfo.Hostname
        $body["timestamp"] = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    }

    $res = Invoke-CsliteApi -Method "POST" -BaseUrl $BaseUrl -Path "/agent/commands" -ApiKey $Cfg.APIKey -BodyObj $body -UserAgent $Cfg.UserAgent -Referer $Cfg.Referer
    if ($res.StatusCode -eq 404 -or ($res.Json -and $res.Json.code -eq 40010)) {
        Write-Log -Level "WARN" -Message "poll returned 40010; re-registering" -MinLevel $Cfg.LogLevel
        Remove-Item -LiteralPath $Cfg.Paths.StateFile -Force -ErrorAction SilentlyContinue
        $newState = Register-Agent -Cfg $Cfg -BaseUrl $BaseUrl -PlatformInfo $PlatformInfo
        $State.AgentID = $newState.AgentID
        $State.DeviceID = $newState.DeviceID
        $body["agent_id"] = $State.AgentID
        $res = Invoke-CsliteApi -Method "POST" -BaseUrl $BaseUrl -Path "/agent/commands" -ApiKey $Cfg.APIKey -BodyObj $body -UserAgent $Cfg.UserAgent -Referer $Cfg.Referer
    }

    if ($null -eq $res.Json -or $res.Json.code -ne 20000) {
        $msg = if ($res.Json -and $res.Json.message) { $res.Json.message } else { $res.Raw }
        throw "poll failed: $msg"
    }

    Apply-ServerIntervals -Cfg $Cfg -Data $res.Json.data

    $cmds = @()
    if ($res.Json.data -and $res.Json.data.commands) {
        $cmds = @($res.Json.data.commands)
    }
    $ranAny = $false
    foreach ($task in $cmds) {
        if ($null -ne $task -and -not [string]::IsNullOrWhiteSpace([string]$task.execution_id)) {
            Invoke-TaskAndReport -Cfg $Cfg -BaseUrl $BaseUrl -State $State -Task $task
            $ranAny = $true
        }
    }
    return $ranAny
}

function Parse-CliArgs {
    param([string[]]$ArgList)
    $cli = @{
        Subcmd            = "help"
        Server            = ""
        APIKey            = ""
        Name              = ""
        DeviceID          = ""
        UserAgent         = ""
        Referer           = ""
        ConfigFile        = ""
        PollInterval      = 0
        HeartbeatInterval = 0
        LogLevel          = ""
        UserMode          = $false
        Once              = $false
        Purge             = $false
    }

    $i = 0
    if ($ArgList.Count -gt 0) {
        $first = [string]$ArgList[0]
        if ($first.StartsWith("-")) {
            if ($first -eq "-h" -or $first -eq "--help" -or $first -eq "-help") {
                $cli.Subcmd = "help"
                return $cli
            }
            if ($first -eq "-v" -or $first -eq "--version") {
                $cli.Subcmd = "version"
                return $cli
            }
            $cli.Subcmd = "run"
        } else {
            $cli.Subcmd = $first.ToLower()
            $i = 1
        }
    }

    while ($i -lt $ArgList.Count) {
        $flag = [string]$ArgList[$i]
        $val = if ($i + 1 -lt $ArgList.Count) { [string]$ArgList[$i + 1] } else { "" }
        switch ($flag.ToLower()) {
            "--server" { $cli.Server = $val; $i += 2; continue }
            "-server" { $cli.Server = $val; $i += 2; continue }
            "--key" { $cli.APIKey = $val; $i += 2; continue }
            "-key" { $cli.APIKey = $val; $i += 2; continue }
            "--apikey" { $cli.APIKey = $val; $i += 2; continue }
            "--api-key" { $cli.APIKey = $val; $i += 2; continue }
            "-api-key" { $cli.APIKey = $val; $i += 2; continue }
            "--name" { $cli.Name = $val; $i += 2; continue }
            "-name" { $cli.Name = $val; $i += 2; continue }
            "--device-id" { $cli.DeviceID = $val; $i += 2; continue }
            "-device-id" { $cli.DeviceID = $val; $i += 2; continue }
            "--user-agent" { $cli.UserAgent = $val; $i += 2; continue }
            "-user-agent" { $cli.UserAgent = $val; $i += 2; continue }
            "--referer" { $cli.Referer = $val; $i += 2; continue }
            "-referer" { $cli.Referer = $val; $i += 2; continue }
            "--config" { $cli.ConfigFile = $val; $i += 2; continue }
            "-config" { $cli.ConfigFile = $val; $i += 2; continue }
            "--poll" { [void][int]::TryParse($val, [ref]$cli.PollInterval); $i += 2; continue }
            "-poll" { [void][int]::TryParse($val, [ref]$cli.PollInterval); $i += 2; continue }
            "--heartbeat" { [void][int]::TryParse($val, [ref]$cli.HeartbeatInterval); $i += 2; continue }
            "-heartbeat" { [void][int]::TryParse($val, [ref]$cli.HeartbeatInterval); $i += 2; continue }
            "--log-level" { $cli.LogLevel = $val; $i += 2; continue }
            "--user" { $cli.UserMode = $true; $i += 1; continue }
            "-user" { $cli.UserMode = $true; $i += 1; continue }
            "--once" { $cli.Once = $true; $i += 1; continue }
            "-once" { $cli.Once = $true; $i += 1; continue }
            "--purge" { $cli.Purge = $true; $i += 1; continue }
            "-h" { $cli.Subcmd = "help"; $i += 1; continue }
            "--help" { $cli.Subcmd = "help"; $i += 1; continue }
            default { $i += 1 }
        }
    }
    return $cli
}

$cli = Parse-CliArgs -ArgList $args
$taskName = "CsliteAgent"

switch ($cli.Subcmd) {
    "run" {
        $cfg = Load-Config -Cli $cli
        if ([string]::IsNullOrWhiteSpace($cfg.Server) -or [string]::IsNullOrWhiteSpace($cfg.APIKey)) {
            throw "server URL and API key are required (--server / --key, env CSLITE_SERVER / CSLITE_API_KEY, or config.json)"
        }
        $baseUrl = Normalize-ServerUrl -Raw $cfg.Server
        $plat = Get-PlatformInfo

        if ($cli.Once) {
            $st = Ensure-Registered -Cfg $cfg -BaseUrl $baseUrl -PlatformInfo $plat
            Send-Heartbeat -Cfg $cfg -BaseUrl $baseUrl -PlatformInfo $plat -State $st
            [void](Poll-Once -Cfg $cfg -BaseUrl $baseUrl -PlatformInfo $plat -State $st)
            exit 0
        }

        $backoff = 1
        $st = $null
        while ($null -eq $st) {
            try {
                $st = Ensure-Registered -Cfg $cfg -BaseUrl $baseUrl -PlatformInfo $plat
            } catch {
                Write-Log -Level "ERROR" -Message "registration failed; retrying in ${backoff}s: $($_.Exception.Message)" -MinLevel $cfg.LogLevel
                Start-Sleep -Seconds $backoff
                if ($backoff -lt 30) { $backoff = [Math]::Min(30, $backoff * 2) }
            }
        }

        $initialHbOk = $false
        try {
            Send-Heartbeat -Cfg $cfg -BaseUrl $baseUrl -PlatformInfo $plat -State $st
            $initialHbOk = $true
        } catch {
            Write-Log -Level "WARN" -Message "initial heartbeat failed: $($_.Exception.Message)" -MinLevel $cfg.LogLevel
        }

        $lastHb = if ($initialHbOk) { [DateTime]::UtcNow } else { [DateTime]::MinValue }
        $fastUntil = [DateTime]::MinValue

        while ($true) {
            $now = [DateTime]::UtcNow
            $needMetrics = ($lastHb -eq [DateTime]::MinValue) -or (($now - $lastHb).TotalSeconds -ge $cfg.HeartbeatInterval)

            try {
                $ran = Poll-Once -Cfg $cfg -BaseUrl $baseUrl -PlatformInfo $plat -State $st -IncludeMetrics $needMetrics
                if ($needMetrics) { $lastHb = $now }
                if ($ran) { $fastUntil = [DateTime]::UtcNow.AddSeconds(15) }
            } catch {
                Write-Log -Level "ERROR" -Message "poll error: $($_.Exception.Message)" -MinLevel $cfg.LogLevel
                if ($needMetrics) {
                    try {
                        Send-Heartbeat -Cfg $cfg -BaseUrl $baseUrl -PlatformInfo $plat -State $st
                        $lastHb = $now
                    } catch {
                        Write-Log -Level "WARN" -Message "fallback heartbeat failed: $($_.Exception.Message)" -MinLevel $cfg.LogLevel
                    }
                }
            }

            $sleepSec = if ([DateTime]::UtcNow -lt $fastUntil) { 1 } else { $cfg.PollInterval }
            Start-Sleep -Seconds $sleepSec
        }
    }

    "install" {
        $cfg = Load-Config -Cli $cli
        if ([string]::IsNullOrWhiteSpace($cfg.Server) -or [string]::IsNullOrWhiteSpace($cfg.APIKey)) {
            throw "--server and --key are required"
        }
        Save-Config -Cfg $cfg
        if ($env:CSLITE_SKIP_SERVICE_EXEC -eq "1") {
            Write-Host "Saved config to $($cfg.Paths.ConfigFile)"
            exit 0
        }
        $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
        if (-not (Test-Path -LiteralPath $psExe)) { $psExe = "powershell.exe" }
        $scriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
        $taskArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" run --config `"$($cfg.Paths.ConfigFile)`""
        $adminMode = (-not $cli.UserMode) -and (Test-IsElevated)
        if (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue) {
            $action = New-ScheduledTaskAction -Execute $psExe -Argument $taskArgs
            $trigger = if ($adminMode) { New-ScheduledTaskTrigger -AtStartup } else { New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) }
            $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
            $principal = if ($adminMode) {
                New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
            } else {
                New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
            }
            Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
            Start-ScheduledTask -TaskName $taskName
            Write-Host "Installed and started Scheduled Task '$taskName' using config $($cfg.Paths.ConfigFile)"
        } else {
            Write-Host "Saved config to $($cfg.Paths.ConfigFile)"
        }
    }

    "uninstall" {
        if (Get-Command Unregister-ScheduledTask -ErrorAction SilentlyContinue) {
            try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch {}
            try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
        }
        if ($cli.Purge) {
            $paths = Resolve-AgentPaths -ExplicitConfig $cli.ConfigFile -UserMode $cli.UserMode
            foreach ($p in @($paths.ConfigFile, $paths.StateFile, $paths.LogFile)) {
                if ($p -and (Test-Path -LiteralPath $p)) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
            }
        }
        Write-Host "Uninstalled $taskName"
    }

    "start" {
        Start-ScheduledTask -TaskName $taskName
    }
    "stop" {
        Stop-ScheduledTask -TaskName $taskName
    }
    "restart" {
        try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch {}
        Start-ScheduledTask -TaskName $taskName
    }
    "status" {
        $paths = Resolve-AgentPaths -ExplicitConfig $cli.ConfigFile -UserMode $cli.UserMode
        $stateText = "not installed"
        if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
            $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
            if ($t) { $stateText = "$($t.State) (scheduled-task)" }
        }
        $plat = Get-PlatformInfo
        Write-Host "Service:     $stateText"
        Write-Host "Platform:    $($plat.Platform)/$($plat.Arch)"
        Write-Host "Config Path: $($paths.ConfigFile)"
        Write-Host "State Path:  $($paths.StateFile)"
    }
    "version" {
        $plat = Get-PlatformInfo
        Write-Host "cslite-agent-lite $Version"
        Write-Host "os/arch:     $($plat.Platform)/$($plat.Arch)"
        Write-Host "os_version:  $($plat.OSVersion)"
    }
    default {
        Write-Host "cslite-agent-lite $Version — Windows PowerShell agent"
        Write-Host "Usage:"
        Write-Host "  cslite-agent-lite.ps1 <run|install|uninstall|start|stop|restart|status|version> [options]"
    }
}
