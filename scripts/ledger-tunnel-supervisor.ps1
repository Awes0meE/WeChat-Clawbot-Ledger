[CmdletBinding()]
param(
    [string]$CommonScriptPath,
    [string]$RuntimeDirectory = 'D:\Clawbot\cloudflared\runtime',
    [string]$CloudflaredPath = 'D:\Clawbot\cloudflared\cloudflared.exe',
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9A-Fa-f]{64}$')]
    [string]$ExpectedCloudflaredSha256,
    [string]$TunnelConfigPath = 'D:\Clawbot\cloudflared\ledger.yml',
    [string]$EzBookkeepingExecutable = 'D:\Clawbot\ezbookkeeping\ezbookkeeping.exe',
    [string]$EzBookkeepingConfigPath = 'D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini',
    [string]$LogPath = 'D:\Clawbot\cloudflared\logs\ledger-tunnel-supervisor.log',
    [ValidateRange(1, 300)]
    [int]$PollSeconds = 5,
    [ValidateRange(1, 5000)]
    [int]$StabilityDelayMilliseconds = 250,
    [ValidateRange(4096, 10485760)]
    [int]$MaxLogBytes = 1048576,
    [ValidateRange(0, 2147483647)]
    [int]$MaxCycles = 0,
    [scriptblock]$ContainedProcessLauncher,
    [scriptblock]$ContainedProcessStopper
)

if ([string]::IsNullOrWhiteSpace($CommonScriptPath)) {
    $CommonScriptPath = Join-Path $PSScriptRoot 'ledger-runtime-common.ps1'
}
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:TunnelChild = $null
$script:TunnelLogPath = $null
$script:TunnelMaxLogBytes = $MaxLogBytes
$script:TunnelLogsInitialized = $false
$script:TunnelJobHandle = $null
$script:TunnelMutex = $null
$script:TunnelMutexOwned = $false
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:StrictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
$script:RuntimeMarkerName = '.clawbot-ledger-tunnel-runtime-v1'
$script:RuntimeMarkerText = "CLAWBOT_LEDGER_TUNNEL_RUNTIME_V1`n"
$script:LogMarkerName = '.clawbot-ledger-tunnel-log-v1'
$script:LogMarkerText = "CLAWBOT_LEDGER_TUNNEL_LOG_V1 ledger-tunnel-supervisor.log`n"
$script:TunnelFailureStage = 'PARAMETERS'

function Enter-TunnelSupervisorMutex {
    $script:TunnelMutex = New-Object System.Threading.Mutex($false, 'Global\ClawbotLedgerTunnelSupervisor')
    try {
        $script:TunnelMutexOwned = $script:TunnelMutex.WaitOne(0, $false)
    } catch [Threading.AbandonedMutexException] {
        $script:TunnelMutexOwned = $true
    }
    if (-not $script:TunnelMutexOwned) {
        throw 'Another Ledger Tunnel supervisor already owns the runtime.'
    }
}

function Exit-TunnelSupervisorMutex {
    if ($null -eq $script:TunnelMutex) { return }
    if ($script:TunnelMutexOwned) {
        try { $script:TunnelMutex.ReleaseMutex() } catch { }
        $script:TunnelMutexOwned = $false
    }
    $script:TunnelMutex.Dispose()
    $script:TunnelMutex = $null
}

function Initialize-TunnelContainment {
    if ($null -ne $ContainedProcessLauncher) { return }
    if ($null -ne $script:TunnelJobHandle) { return }
    if (-not ('Clawbot.LedgerTunnelJob' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Clawbot {
    [StructLayout(LayoutKind.Sequential)]
    internal struct IoCounters {
        public UInt64 ReadOperationCount;
        public UInt64 WriteOperationCount;
        public UInt64 OtherOperationCount;
        public UInt64 ReadTransferCount;
        public UInt64 WriteTransferCount;
        public UInt64 OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct BasicLimitInformation {
        public Int64 PerProcessUserTimeLimit;
        public Int64 PerJobUserTimeLimit;
        public UInt32 LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public UInt32 ActiveProcessLimit;
        public UIntPtr Affinity;
        public UInt32 PriorityClass;
        public UInt32 SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ExtendedLimitInformation {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct StartupInfo {
        public UInt32 cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public UInt32 dwX;
        public UInt32 dwY;
        public UInt32 dwXSize;
        public UInt32 dwYSize;
        public UInt32 dwXCountChars;
        public UInt32 dwYCountChars;
        public UInt32 dwFillAttribute;
        public UInt32 dwFlags;
        public UInt16 wShowWindow;
        public UInt16 cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ProcessInformation {
        public IntPtr ProcessHandle;
        public IntPtr ThreadHandle;
        public UInt32 ProcessId;
        public UInt32 ThreadId;
    }

    public static class LedgerTunnelJob {
        private const UInt32 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const Int32 JobObjectExtendedLimitInformation = 9;
        private const UInt32 CREATE_SUSPENDED = 0x00000004;
        private const UInt32 CREATE_NO_WINDOW = 0x08000000;
        private const UInt32 WAIT_OBJECT_0 = 0x00000000;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateJobObject(IntPtr securityAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(SafeFileHandle job, Int32 informationClass, IntPtr information, UInt32 informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, UInt32 exitCode);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcessW(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            UInt32 creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref StartupInfo startupInfo,
            out ProcessInformation processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern UInt32 ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern UInt32 WaitForSingleObject(IntPtr handle, UInt32 milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public static SafeFileHandle CreateKillOnClose() {
            SafeFileHandle job = CreateJobObject(IntPtr.Zero, null);
            if (job == null || job.IsInvalid) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create the Tunnel containment job.");
            }
            ExtendedLimitInformation information = new ExtendedLimitInformation();
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            Int32 length = Marshal.SizeOf(typeof(ExtendedLimitInformation));
            IntPtr pointer = Marshal.AllocHGlobal(length);
            try {
                Marshal.StructureToPtr(information, pointer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (UInt32)length)) {
                    Int32 error = Marshal.GetLastWin32Error();
                    job.Dispose();
                    throw new Win32Exception(error, "Could not configure the Tunnel containment job.");
                }
                return job;
            } finally {
                Marshal.FreeHGlobal(pointer);
            }
        }

        private static void TerminateCreatedProcessAndWait(IntPtr processHandle) {
            bool terminated = TerminateProcess(processHandle, 1);
            Int32 terminateError = terminated ? 0 : Marshal.GetLastWin32Error();
            UInt32 waitResult = WaitForSingleObject(processHandle, 5000);
            if (waitResult != WAIT_OBJECT_0) {
                Int32 error = terminateError != 0 ? terminateError : Marshal.GetLastWin32Error();
                throw new Win32Exception(error, "Could not confirm cleanup of the suspended Tunnel child.");
            }
        }

        public static Process StartContained(
            SafeFileHandle job,
            string executable,
            string commandLine,
            string workingDirectory) {
            StartupInfo startup = new StartupInfo();
            startup.cb = (UInt32)Marshal.SizeOf(typeof(StartupInfo));
            ProcessInformation created;
            if (!CreateProcessW(
                    executable,
                    new StringBuilder(commandLine),
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW,
                    IntPtr.Zero,
                    workingDirectory,
                    ref startup,
                    out created)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create the suspended Tunnel child.");
            }

            Process process = null;
            bool resumed = false;
            try {
                if (!AssignProcessToJobObject(job, created.ProcessHandle)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not contain the suspended Tunnel child.");
                }
                process = Process.GetProcessById((Int32)created.ProcessId);
                IntPtr retainedHandle = process.Handle;
                UInt32 previousSuspendCount = ResumeThread(created.ThreadHandle);
                if (previousSuspendCount != 1) {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not resume the contained Tunnel child.");
                }
                resumed = true;
                return process;
            } catch (Exception startupFailure) {
                if (!resumed) {
                    try {
                        TerminateCreatedProcessAndWait(created.ProcessHandle);
                    } catch (Exception cleanupFailure) {
                        if (process != null) { process.Dispose(); }
                        throw new AggregateException(
                            "The suspended Tunnel child could not be cleaned up.",
                            startupFailure,
                            cleanupFailure);
                    }
                }
                if (process != null) { process.Dispose(); }
                throw;
            } finally {
                CloseHandle(created.ThreadHandle);
                CloseHandle(created.ProcessHandle);
            }
        }
    }
}
'@
    }
    $script:TunnelJobHandle = [Clawbot.LedgerTunnelJob]::CreateKillOnClose()
}

function Close-TunnelContainment {
    if ($null -ne $script:TunnelJobHandle) {
        $script:TunnelJobHandle.Dispose()
        $script:TunnelJobHandle = $null
    }
}

function Get-TunnelNormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path.Trim())).TrimEnd([char[]]@('\', '/'))
}

function Test-TunnelSamePath {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )

    return [string]::Equals((Get-TunnelNormalizedPath -Path $Left), (Get-TunnelNormalizedPath -Path $Right), [StringComparison]::OrdinalIgnoreCase)
}

function Assert-TunnelLocalAbsolutePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim())
    if (-not [IO.Path]::IsPathRooted($expanded) -or $expanded.StartsWith('\\', [StringComparison]::Ordinal)) {
        throw 'A Tunnel path must be absolute on a local fixed drive.'
    }
    $normalized = Get-TunnelNormalizedPath -Path $expanded
    $root = [IO.Path]::GetPathRoot($normalized)
    try {
        $drive = New-Object IO.DriveInfo($root)
        if ([string]::IsNullOrWhiteSpace($root) -or $root.StartsWith('\\', [StringComparison]::Ordinal) -or
            [string]$drive.DriveType -cne 'Fixed') {
            throw 'not fixed'
        }
    } catch {
        throw 'A Tunnel path must be absolute on a local fixed drive.'
    }
    return $normalized
}

function Assert-TunnelNoReparsePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $cursor = Assert-TunnelLocalAbsolutePath -Path $Path
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            if (([IO.FileAttributes]$item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'A Tunnel path contains a reparse point.'
            }
        }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or (Test-TunnelSamePath -Left $parent -Right $cursor)) { break }
        $cursor = $parent
    }
}

function Assert-TunnelLogPathIsDistinct {
    param(
        [Parameter(Mandatory = $true)][string]$CandidateLogPath,
        [Parameter(Mandatory = $true)][string[]]$ReservedPaths
    )

    foreach ($logCandidate in @($CandidateLogPath, ($CandidateLogPath + '.1'))) {
        foreach ($reservedPath in $ReservedPaths) {
            if (Test-TunnelSamePath -Left $logCandidate -Right $reservedPath) {
                throw 'The Tunnel log path collides with a protected runtime file.'
            }
        }
    }
}

function Assert-TunnelExternalPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $normalized = Assert-TunnelLocalAbsolutePath -Path $Path
    if ($normalized -match '(?i)\\OneDrive(?:\s|\\|$)' -or $normalized -match '(?i)\\\.git(?:\\|$)') {
        throw 'A Tunnel runtime path is inside a synchronized or Git directory.'
    }
    Assert-TunnelNoReparsePath -Path $normalized
    return $normalized
}

function Assert-TunnelDedicatedLayout {
    param(
        [Parameter(Mandatory = $true)][string]$Cloudflared,
        [Parameter(Mandatory = $true)][string]$TunnelConfig,
        [Parameter(Mandatory = $true)][string]$Credential,
        [Parameter(Mandatory = $true)][string]$Runtime,
        [Parameter(Mandatory = $true)][string]$Log
    )

    $logDirectory = Split-Path -Parent $Log
    $runtimeBase = Split-Path -Parent $Runtime
    if ((Split-Path -Leaf $Runtime) -cne 'runtime' -or
        (Split-Path -Leaf $logDirectory) -cne 'logs' -or
        (Split-Path -Leaf $Log) -cne 'ledger-tunnel-supervisor.log' -or
        -not (Test-TunnelSamePath -Left (Split-Path -Parent $logDirectory) -Right $runtimeBase) -or
        -not (Test-TunnelSamePath -Left (Split-Path -Parent $Cloudflared) -Right $runtimeBase) -or
        -not (Test-TunnelSamePath -Left (Split-Path -Parent $TunnelConfig) -Right $runtimeBase) -or
        -not (Test-TunnelSamePath -Left (Split-Path -Parent $Credential) -Right $runtimeBase) -or
        (Test-TunnelSamePath -Left $runtimeBase -Right ([IO.Path]::GetPathRoot($runtimeBase)))) {
        throw 'Tunnel files are not in the dedicated local cloudflared root.'
    }
}

function Get-ProtectedRuleIdentity {
    param([Parameter(Mandatory = $true)][object]$Rule)

    try {
        return [string]$Rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    } catch {
        return [string]$Rule.IdentityReference.Value
    }
}

function Assert-TunnelProtectedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateSet('Leaf', 'Container')][string]$PathType = 'Leaf'
    )

    if (-not (Test-Path -LiteralPath $Path -PathType $PathType)) {
        throw 'A protected Tunnel path was not found.'
    }
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $rules = @($acl.Access)
    if (-not $acl.AreAccessRulesProtected -or $rules.Count -ne 2) {
        throw 'A protected Tunnel file has an unsafe access control list.'
    }
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $ownerName = $currentIdentity.Name
    $ownerSid = [string]$currentIdentity.User.Value
    try {
        $actualOwner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    } catch {
        $actualOwner = [string]$acl.Owner
    }
    if (-not [string]::Equals($actualOwner, $ownerName, [StringComparison]::OrdinalIgnoreCase) -and
        -not [string]::Equals($actualOwner, $ownerSid, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A protected Tunnel path is not owned by the current runtime identity.'
    }
    $ownerRules = @($rules | Where-Object {
        $identity = Get-ProtectedRuleIdentity -Rule $_
        $identity -ceq $ownerName -or $identity -ceq $ownerSid
    })
    $systemRules = @($rules | Where-Object {
        $identity = Get-ProtectedRuleIdentity -Rule $_
        $identity -ceq 'S-1-5-18' -or $identity -ceq 'NT AUTHORITY\SYSTEM'
    })
    if ($ownerRules.Count -ne 1 -or $systemRules.Count -ne 1) {
        throw 'A protected Tunnel file is not limited to its owner and SYSTEM.'
    }
    foreach ($rule in $rules) {
        if ([string]$rule.AccessControlType -cne 'Allow' -or [bool]$rule.IsInherited) {
            throw 'A protected Tunnel file contains an inherited or deny rule.'
        }
    }
    if ([string]$ownerRules[0].FileSystemRights -notmatch 'FullControl') {
        throw 'The Tunnel file owner does not have full control.'
    }
    $systemRights = [string]$systemRules[0].FileSystemRights
    if ($systemRights -notmatch 'Read' -or $systemRights -match 'Write|Modify|FullControl|Delete|ChangePermissions|TakeOwnership') {
        throw 'SYSTEM has more than read access to a protected Tunnel file.'
    }
}

function Read-ExactTunnelConfiguration {
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        $text = [IO.File]::ReadAllText($Path, $script:StrictUtf8)
    } catch {
        throw 'The Tunnel configuration is missing or is not strict UTF-8.'
    }
    if ($text.Contains("`t")) {
        throw 'The Tunnel configuration must not contain tabs.'
    }
    $logicalLines = @([regex]::Split($text, "`r`n|`n|`r") | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_) -and $_ -notmatch '^\s*#'
    })
    if ($logicalLines.Count -ne 7) {
        throw 'The Tunnel configuration must contain only the exact Ledger ingress.'
    }
    if ($logicalLines[0] -cnotmatch '^tunnel:\s+([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$') {
        throw 'The Tunnel configuration does not contain a concrete named Tunnel UUID.'
    }
    $tunnelId = $matches[1]
    if ($logicalLines[1] -cnotmatch "^credentials-file:\s+'([^']+)'$") {
        throw 'The Tunnel configuration must use one literal local credential path.'
    }
    $credentialPath = Assert-TunnelLocalAbsolutePath -Path $matches[1]
    Assert-TunnelNoReparsePath -Path $credentialPath
    if ((Split-Path -Leaf $credentialPath) -cne ($tunnelId + '.json')) {
        throw 'The Tunnel credential filename does not match the named Tunnel UUID.'
    }
    if ($logicalLines[2] -cne 'no-autoupdate: true' -or
        $logicalLines[3] -cne 'ingress:' -or
        $logicalLines[4] -cne '  - hostname: ledger.66ccff-labs.com' -or
        $logicalLines[5] -cne '    service: http://127.0.0.1:8888' -or
        $logicalLines[6] -cne '  - service: http_status:404') {
        throw 'The Tunnel configuration does not match the exact Ledger ingress.'
    }
    return [pscustomobject]@{
        TunnelId = $tunnelId
        CredentialPath = $credentialPath
    }
}

function Get-TunnelFileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '')
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Assert-TunnelCloudflaredBinaryIdentity {
    if ((Get-TunnelFileSha256 -Path $script:ExpectedCloudflared) -cne $script:ExpectedCloudflaredSha256) {
        throw 'The cloudflared binary hash changed.'
    }
    $signature = Get-AuthenticodeSignature -FilePath $script:ExpectedCloudflared -ErrorAction Stop
    $subject = if ($null -ne $signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { '' }
    if ([string]$signature.Status -cne 'Valid' -or $subject -notmatch '(?i)(?:^|,\s*)O=(?:"Cloudflare, Inc\."|Cloudflare, Inc\.)(?:,|$)') {
        throw 'The cloudflared binary does not have a valid Cloudflare, Inc. signature.'
    }
}

function Get-TunnelEnvironmentVariables {
    param([Parameter(Mandatory = $true)][EnvironmentVariableTarget]$Target)

    return [Environment]::GetEnvironmentVariables($Target)
}

function Assert-NoCloudflaredEnvironmentOverrides {
    foreach ($target in @(
        [EnvironmentVariableTarget]::Process,
        [EnvironmentVariableTarget]::User,
        [EnvironmentVariableTarget]::Machine
    )) {
        try {
            $variables = Get-TunnelEnvironmentVariables -Target $target
        } catch {
            throw 'Cloudflared environment overrides could not be audited.'
        }
        foreach ($name in @($variables.Keys)) {
            $variableName = [string]$name
            if ($variableName -match '^(?i:TUNNEL_)' -or $variableName -ieq 'NO_AUTOUPDATE') {
                throw 'A cloudflared environment override is present.'
            }
        }
    }
}

function Assert-NoEzBookkeepingEnvironmentOverrides {
    foreach ($target in @(
        [EnvironmentVariableTarget]::Process,
        [EnvironmentVariableTarget]::User,
        [EnvironmentVariableTarget]::Machine
    )) {
        try {
            $variables = Get-TunnelEnvironmentVariables -Target $target
        } catch {
            throw 'ezBookkeeping environment overrides could not be audited.'
        }
        foreach ($name in @($variables.Keys)) {
            if ([string]$name -match '^(?i:EBK_|EBKCFP_)') {
                throw 'An ezBookkeeping environment override is present.'
            }
        }
    }
}

function Assert-TunnelMarker {
    param(
        [Parameter(Mandatory = $true)][string]$MarkerPath,
        [Parameter(Mandatory = $true)][string]$ExpectedText
    )

    Assert-TunnelProtectedFile -Path $MarkerPath
    try {
        $actual = [IO.File]::ReadAllText($MarkerPath, $script:StrictUtf8)
    } catch {
        throw 'A Tunnel ownership marker is invalid.'
    }
    if ($actual -cne $ExpectedText) {
        throw 'A Tunnel ownership marker is invalid.'
    }
}

function Assert-TunnelProductionConfiguration {
    Assert-NoEzBookkeepingEnvironmentOverrides
    $document = Get-LedgerIniDocument -Path $script:ExpectedEzBookkeepingConfig
    $required = @{
        'global.mode' = 'production'
        'server.protocol' = 'http'
        'server.http_addr' = '127.0.0.1'
        'server.http_port' = '8888'
        'server.domain' = 'ledger.66ccff-labs.com'
        'server.root_url' = 'https://ledger.66ccff-labs.com/'
        'mcp.mcp_allowed_remote_ips' = '127.0.0.1'
        'database.type' = 'sqlite3'
        'security.trusted_proxy_ips' = '127.0.0.1'
        'security.enable_api_token' = 'true'
        'security.api_token_allowed_remote_ips' = '127.0.0.1'
        'security.max_failures_per_ip_per_minute' = '5'
        'security.max_failures_per_user_per_minute' = '5'
        'auth.enable_internal_auth' = 'true'
        'auth.enable_oauth2_auth' = 'false'
        'auth.enable_forget_password' = 'false'
        'user.enable_register' = 'false'
    }
    foreach ($key in $required.Keys) {
        $separator = $key.IndexOf('.')
        $actual = Get-LedgerIniValue -Document $document -Section $key.Substring(0, $separator) -Name $key.Substring($separator + 1)
        if ($actual -cne $required[$key]) {
            throw 'The production ezBookkeeping configuration is not safe to publish.'
        }
    }
    $mcpEnabled = Get-LedgerIniValue -Document $document -Section 'mcp' -Name 'enable_mcp'
    if ($mcpEnabled -notin @('true', 'false')) {
        throw 'The production MCP enable state is invalid.'
    }
    $secretKey = Get-LedgerIniValue -Document $document -Section 'security' -Name 'secret_key'
    if ([string]::IsNullOrWhiteSpace($secretKey) -or $secretKey.StartsWith('__')) {
        throw 'The production ezBookkeeping signing secret is not ready for publication.'
    }
    if ($document.Text -notmatch '(?m)^; CLAWBOT_LEDGER_PROFILE=production\s*$') {
        throw 'The production ezBookkeeping profile marker is missing.'
    }
}

function Test-TunnelExistingLogFormat {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not [IO.File]::Exists($Path)) { return $true }
    $candidate = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($candidate.Length -gt $script:TunnelMaxLogBytes) { return $false }
    try {
        $existingText = [IO.File]::ReadAllText($Path, $script:StrictUtf8)
    } catch {
        return $false
    }
    foreach ($existingLine in @([regex]::Split($existingText, "`r`n|`n|`r") | Where-Object { $_ -ne '' })) {
        if ($existingLine -cnotmatch '^timestamp=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z event=[A-Z][A-Z0-9_]{2,40}(?: pid=\d+)?(?: exit=[A-Za-z0-9_-]{1,24})?$') {
            return $false
        }
    }
    return $true
}

function Write-TunnelEvent {
    param(
        [Parameter(Mandatory = $true)][ValidatePattern('^[A-Z][A-Z0-9_]{2,40}$')][string]$EventCode,
        [int]$ChildProcessId = 0,
        [string]$ExitStatus = ''
    )

    if ([string]::IsNullOrWhiteSpace($script:TunnelLogPath)) {
        return
    }
    if ($ExitStatus -and $ExitStatus -cnotmatch '^[A-Za-z0-9_-]{1,24}$') {
        $ExitStatus = 'unknown'
    }
    $parts = @(
        'timestamp=' + [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ', [Globalization.CultureInfo]::InvariantCulture),
        'event=' + $EventCode
    )
    if ($ChildProcessId -gt 0) { $parts += 'pid=' + $ChildProcessId }
    if ($ExitStatus) { $parts += 'exit=' + $ExitStatus }
    $line = ($parts -join ' ') + [Environment]::NewLine
    $lineBytes = $script:Utf8NoBom.GetByteCount($line)
    $archivePath = $script:TunnelLogPath + '.1'
    if (-not $script:TunnelLogsInitialized) {
        foreach ($candidatePath in @($script:TunnelLogPath, $archivePath)) {
            if (-not (Test-TunnelExistingLogFormat -Path $candidatePath)) {
                throw 'A pre-existing Tunnel log is not a recognized owned log.'
            }
        }
        $script:TunnelLogsInitialized = $true
    }
    if ([IO.File]::Exists($script:TunnelLogPath)) {
        $length = (Get-Item -LiteralPath $script:TunnelLogPath -Force -ErrorAction Stop).Length
        if (($length + $lineBytes) -gt $script:TunnelMaxLogBytes) {
            if ([IO.File]::Exists($archivePath)) {
                [IO.File]::Delete($archivePath)
            }
            [IO.File]::Move($script:TunnelLogPath, $archivePath)
        }
    }
    [IO.File]::AppendAllText($script:TunnelLogPath, $line, $script:Utf8NoBom)
}

function Test-SameOriginIdentity {
    param(
        [Parameter(Mandatory = $true)][object]$First,
        [Parameter(Mandatory = $true)][object]$Second
    )

    return ([int]$First.ProcessId -eq [int]$Second.ProcessId -and
        [string]$First.CreationDate -ceq [string]$Second.CreationDate -and
        (Test-TunnelSamePath -Left ([string]$First.ExecutablePath) -Right ([string]$Second.ExecutablePath)) -and
        [string]$First.CommandLine -ceq [string]$Second.CommandLine)
}

function Get-StableLedgerOriginIdentity {
    try {
        $first = Get-LedgerListenerOwner -Port 8888 -ExpectedExecutable $script:ExpectedEzBookkeeping -ExpectedConfigPath $script:ExpectedEzBookkeepingConfig
        if (-not (Test-LedgerOrigin -Port 8888)) { return $null }
        Start-Sleep -Milliseconds $StabilityDelayMilliseconds
        $second = Get-LedgerListenerOwner -Port 8888 -ExpectedExecutable $script:ExpectedEzBookkeeping -ExpectedConfigPath $script:ExpectedEzBookkeepingConfig
        if (-not (Test-LedgerOrigin -Port 8888)) { return $null }
        if (-not (Test-SameOriginIdentity -First $first -Second $second)) { return $null }
        return $second
    } catch {
        return $null
    }
}

function Get-ExpectedCloudflaredCommandLines {
    $quotedExecutable = '"' + $script:ExpectedCloudflared + '"'
    $quotedConfig = '"' + $script:ExpectedTunnelConfig + '"'
    return @(
        ($quotedExecutable + ' tunnel --config ' + $quotedConfig + ' run')
        ($script:ExpectedCloudflared + ' tunnel --config ' + $quotedConfig + ' run')
        ($quotedExecutable + ' tunnel --config ' + $script:ExpectedTunnelConfig + ' run')
        ($script:ExpectedCloudflared + ' tunnel --config ' + $script:ExpectedTunnelConfig + ' run')
    )
}

function Get-CloudflaredIdentityByPid {
    param([Parameter(Mandatory = $true)][int]$ChildProcessId)

    $processes = @(Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $ChildProcessId) -ErrorAction Stop)
    if ($processes.Count -ne 1) {
        Write-TunnelEvent -EventCode 'CHILD_LOOKUP_MISMATCH'
        return $null
    }
    $process = $processes[0]
    if (-not $process.ExecutablePath -or -not (Test-TunnelSamePath -Left ([string]$process.ExecutablePath) -Right $script:ExpectedCloudflared)) {
        Write-TunnelEvent -EventCode 'CHILD_PATH_MISMATCH'
        return $null
    }
    $commandLine = [string]$process.CommandLine
    $commandMatches = $false
    foreach ($expectedCommandLine in @(Get-ExpectedCloudflaredCommandLines)) {
        if ([string]::Equals($commandLine, $expectedCommandLine, [StringComparison]::OrdinalIgnoreCase)) {
            $commandMatches = $true
            break
        }
    }
    if (-not $commandLine -or -not $commandMatches) {
        Write-TunnelEvent -EventCode 'CHILD_COMMAND_MISMATCH'
        return $null
    }
    if (-not $process.CreationDate) {
        Write-TunnelEvent -EventCode 'CHILD_CREATION_MISSING'
        return $null
    }
    return [pscustomobject]@{
        ProcessId = [int]$process.ProcessId
        CreationDate = [string]$process.CreationDate
        ExecutablePath = Get-TunnelNormalizedPath -Path ([string]$process.ExecutablePath)
        CommandLine = $commandLine
    }
}

function Get-AllCloudflaredProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction Stop)
}

function Stop-UnverifiedContainedCloudflared {
    param([Parameter(Mandatory = $true)][object]$Process)

    if ($null -ne $ContainedProcessLauncher) {
        if ($null -eq $ContainedProcessStopper) {
            throw 'The injected contained-process launcher has no exact-child stopper.'
        }
        $null = & $ContainedProcessStopper $Process
        return
    }
    Close-TunnelContainment
    try {
        if (-not [bool]$Process.WaitForExit(5000)) {
            throw 'The unverified contained Tunnel child did not exit.'
        }
    } catch {
        throw 'The unverified contained Tunnel child could not be confirmed stopped.'
    }
}

function Start-OwnedCloudflared {
    if (@(Get-AllCloudflaredProcesses).Count -ne 0) {
        Write-TunnelEvent -EventCode 'TUNNEL_CONFLICT'
        return $null
    }
    Initialize-TunnelContainment
    $commandLine = '"' + $script:ExpectedCloudflared + '" tunnel --config "' + $script:ExpectedTunnelConfig + '" run'
    $process = $null
    try {
        if ($null -ne $ContainedProcessLauncher) {
            $process = & $ContainedProcessLauncher $script:ExpectedCloudflared $commandLine
        } else {
            $process = [Clawbot.LedgerTunnelJob]::StartContained($script:TunnelJobHandle, $script:ExpectedCloudflared, $commandLine, $script:ExpectedRuntime)
        }
        if ($null -eq $process -or [int]$process.Id -le 0) {
            throw 'Tunnel child startup did not return a process identity.'
        }
    } catch {
        Write-TunnelEvent -EventCode 'CHILD_CONTAINMENT_FAILED'
        if ($null -ne $process) {
            try { Stop-UnverifiedContainedCloudflared -Process $process } catch { throw 'The failed Tunnel child launch could not be cleaned up.' }
        }
        throw
    }
    try {
        $identity = Get-CloudflaredIdentityByPid -ChildProcessId ([int]$process.Id)
    } catch {
        Write-TunnelEvent -EventCode 'CHILD_VERIFY_ERROR'
        try { Stop-UnverifiedContainedCloudflared -Process $process } catch { throw 'The unverified Tunnel child could not be cleaned up.' }
        throw
    }
    if ($null -eq $identity) {
        Write-TunnelEvent -EventCode 'CHILD_VERIFY_FAILED'
        try { Stop-UnverifiedContainedCloudflared -Process $process } catch { throw 'The unverified Tunnel child could not be cleaned up.' }
        throw 'Tunnel child identity could not be verified after startup.'
    }
    Write-TunnelEvent -EventCode 'TUNNEL_STARTED' -ChildProcessId $identity.ProcessId
    return [pscustomobject]@{
        Identity = $identity
        Process = $process
    }
}

function Stop-OwnedCloudflared {
    param(
        [Parameter(Mandatory = $true)][object]$Child,
        [Parameter(Mandatory = $true)][string]$EventCode
    )

    $identity = Get-CloudflaredIdentityByPid -ChildProcessId ([int]$Child.Identity.ProcessId)
    if ($null -eq $identity -or
        [string]$identity.CreationDate -cne [string]$Child.Identity.CreationDate -or
        -not (Test-TunnelSamePath -Left ([string]$identity.ExecutablePath) -Right ([string]$Child.Identity.ExecutablePath)) -or
        [string]$identity.CommandLine -cne [string]$Child.Identity.CommandLine) {
        Write-TunnelEvent -EventCode 'CHILD_IDENTITY_CHANGED' -ChildProcessId ([int]$Child.Identity.ProcessId)
        throw 'The tracked Tunnel child identity changed.'
    }
    if ($null -ne $ContainedProcessLauncher) {
        if ($null -eq $ContainedProcessStopper) {
            throw 'The injected Tunnel containment has no exact-child stopper.'
        }
        $null = & $ContainedProcessStopper $Child.Process
    } else {
        Close-TunnelContainment
        try {
            if (-not [bool]$Child.Process.WaitForExit(5000)) {
                throw 'The contained Tunnel child did not exit.'
            }
        } catch {
            throw 'The contained Tunnel child could not be confirmed stopped.'
        }
    }
    Write-TunnelEvent -EventCode $EventCode -ChildProcessId ([int]$identity.ProcessId) -ExitStatus 'terminated'
}

function Test-TrackedCloudflaredStillExists {
    param([Parameter(Mandatory = $true)][object]$Child)

    $processes = @(Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f [int]$Child.Identity.ProcessId) -ErrorAction Stop)
    if ($processes.Count -eq 0) { return $false }
    if ($processes.Count -ne 1) {
        Write-TunnelEvent -EventCode 'CHILD_IDENTITY_CHANGED' -ChildProcessId ([int]$Child.Identity.ProcessId)
        throw 'The tracked Tunnel child identity became ambiguous.'
    }
    $current = Get-CloudflaredIdentityByPid -ChildProcessId ([int]$Child.Identity.ProcessId)
    if ($null -eq $current -or
        [string]$current.CreationDate -cne [string]$Child.Identity.CreationDate -or
        -not (Test-TunnelSamePath -Left ([string]$current.ExecutablePath) -Right ([string]$Child.Identity.ExecutablePath)) -or
        [string]$current.CommandLine -cne [string]$Child.Identity.CommandLine) {
        Write-TunnelEvent -EventCode 'CHILD_IDENTITY_CHANGED' -ChildProcessId ([int]$Child.Identity.ProcessId)
        throw 'The tracked Tunnel child identity changed or its PID was reused.'
    }
    return $true
}

function Assert-NoAdditionalCloudflared {
    param([Parameter(Mandatory = $true)][object]$Child)

    $all = @(Get-AllCloudflaredProcesses)
    if ($all.Count -ne 1 -or [int]$all[0].ProcessId -ne [int]$Child.Identity.ProcessId) {
        return $false
    }
    return $true
}

try {
    if (($null -eq $ContainedProcessLauncher) -ne ($null -eq $ContainedProcessStopper)) {
        throw 'Injected Tunnel containment requires matching launch and stop operations.'
    }
    if ($null -ne $ContainedProcessLauncher -and $MaxCycles -eq 0) {
        throw 'Injected Tunnel containment is allowed only for a bounded validation run.'
    }
    if (-not (Test-Path -LiteralPath $CommonScriptPath -PathType Leaf)) {
        throw 'The Ledger runtime helper is missing.'
    }
    $script:TunnelFailureStage = 'HELPER'
    . $CommonScriptPath
    $script:TunnelFailureStage = 'PATHS'
    $script:ExpectedRuntime = Assert-TunnelExternalPath -Path $RuntimeDirectory
    $script:ExpectedCloudflared = Assert-TunnelExternalPath -Path $CloudflaredPath
    $script:ExpectedCloudflaredSha256 = $ExpectedCloudflaredSha256.ToUpperInvariant()
    $script:ExpectedTunnelConfig = Assert-TunnelExternalPath -Path $TunnelConfigPath
    $script:ExpectedEzBookkeeping = Get-TunnelNormalizedPath -Path $EzBookkeepingExecutable
    $script:ExpectedEzBookkeepingConfig = Get-TunnelNormalizedPath -Path $EzBookkeepingConfigPath
    $candidateLogPath = Assert-TunnelExternalPath -Path $LogPath
    if (-not (Test-Path -LiteralPath $script:ExpectedCloudflared -PathType Leaf) -or
        -not (Test-Path -LiteralPath $script:ExpectedEzBookkeeping -PathType Leaf) -or
        -not (Test-Path -LiteralPath $script:ExpectedEzBookkeepingConfig -PathType Leaf)) {
        throw 'A required local executable or production configuration is missing.'
    }
    if ($script:ExpectedTunnelConfig -match '["\s]') {
        throw 'The Tunnel configuration path contains unsupported whitespace or quotes.'
    }
    $logDirectory = Split-Path -Parent $candidateLogPath
    if (-not (Test-Path -LiteralPath $logDirectory -PathType Container)) {
        throw 'The protected Tunnel log directory is missing.'
    }
    if (Test-Path -LiteralPath $candidateLogPath -PathType Container) {
        throw 'The Tunnel log path is a directory.'
    }
    $configuration = Read-ExactTunnelConfiguration -Path $script:ExpectedTunnelConfig
    $null = Assert-TunnelExternalPath -Path $configuration.CredentialPath
    $script:TunnelFailureStage = 'LAYOUT'
    Assert-TunnelDedicatedLayout -Cloudflared $script:ExpectedCloudflared -TunnelConfig $script:ExpectedTunnelConfig -Credential $configuration.CredentialPath -Runtime $script:ExpectedRuntime -Log $candidateLogPath
    $runtimeMarker = Join-Path $script:ExpectedRuntime $script:RuntimeMarkerName
    $logMarker = Join-Path $logDirectory $script:LogMarkerName
    Assert-TunnelLogPathIsDistinct -CandidateLogPath $candidateLogPath -ReservedPaths @(
        $CommonScriptPath,
        $MyInvocation.MyCommand.Path,
        $runtimeMarker,
        $logMarker,
        $script:ExpectedCloudflared,
        $script:ExpectedTunnelConfig,
        $configuration.CredentialPath,
        $script:ExpectedEzBookkeeping,
        $script:ExpectedEzBookkeepingConfig
    )
    $script:TunnelFailureStage = 'ACL'
    $script:ExpectedTunnelId = [string]$configuration.TunnelId
    $script:ExpectedCredentialPath = Get-TunnelNormalizedPath -Path $configuration.CredentialPath
    Assert-TunnelProtectedFile -Path $script:ExpectedTunnelConfig
    Assert-TunnelProtectedFile -Path $configuration.CredentialPath
    Assert-TunnelProtectedFile -Path $script:ExpectedCloudflared
    Assert-TunnelProtectedFile -Path $script:ExpectedEzBookkeepingConfig
    Assert-TunnelProtectedFile -Path $script:ExpectedRuntime -PathType Container
    Assert-TunnelProtectedFile -Path $logDirectory -PathType Container
    $script:TunnelFailureStage = 'MARKERS'
    Assert-TunnelMarker -MarkerPath $runtimeMarker -ExpectedText $script:RuntimeMarkerText
    Assert-TunnelMarker -MarkerPath $logMarker -ExpectedText $script:LogMarkerText
    Assert-NoCloudflaredEnvironmentOverrides
    $script:TunnelFailureStage = 'BINARY'
    Assert-TunnelCloudflaredBinaryIdentity
    $script:TunnelFailureStage = 'ORIGIN_CONFIG'
    Assert-TunnelProductionConfiguration
    $script:TunnelLogPath = $candidateLogPath
    Enter-TunnelSupervisorMutex
    $script:TunnelFailureStage = 'CONTAINMENT'
    Initialize-TunnelContainment
    Write-TunnelEvent -EventCode 'SUPERVISOR_STARTED'

    $cycles = 0
    while ($MaxCycles -eq 0 -or $cycles -lt $MaxCycles) {
        $cycles += 1
        $configuration = Read-ExactTunnelConfiguration -Path $script:ExpectedTunnelConfig
        if ([string]$configuration.TunnelId -cne $script:ExpectedTunnelId -or
            -not (Test-TunnelSamePath -Left $configuration.CredentialPath -Right $script:ExpectedCredentialPath)) {
            Write-TunnelEvent -EventCode 'TUNNEL_CONFIG_CHANGED'
            if ($null -ne $script:TunnelChild) {
                Stop-OwnedCloudflared -Child $script:TunnelChild -EventCode 'TUNNEL_FAIL_CLOSED'
                $script:TunnelChild = $null
            }
            throw 'The protected Tunnel identity changed while the supervisor was running.'
        }
        Assert-TunnelProtectedFile -Path $script:ExpectedTunnelConfig
        Assert-TunnelProtectedFile -Path $configuration.CredentialPath
        Assert-TunnelProtectedFile -Path $script:ExpectedCloudflared
        Assert-TunnelProtectedFile -Path $script:ExpectedEzBookkeepingConfig
        Assert-TunnelMarker -MarkerPath $runtimeMarker -ExpectedText $script:RuntimeMarkerText
        Assert-TunnelMarker -MarkerPath $logMarker -ExpectedText $script:LogMarkerText
        Assert-NoCloudflaredEnvironmentOverrides
        Assert-TunnelCloudflaredBinaryIdentity
        Assert-TunnelProductionConfiguration

        if ($null -ne $script:TunnelChild -and -not (Test-TrackedCloudflaredStillExists -Child $script:TunnelChild)) {
            $exitStatus = 'unknown'
            try {
                if ([bool]$script:TunnelChild.Process.HasExited) {
                    $exitStatus = [string]$script:TunnelChild.Process.ExitCode
                }
            } catch {
                $exitStatus = 'unknown'
            }
            Write-TunnelEvent -EventCode 'TUNNEL_EXITED' -ChildProcessId ([int]$script:TunnelChild.Identity.ProcessId) -ExitStatus $exitStatus
            $script:TunnelChild = $null
        }

        if ($null -ne $script:TunnelChild -and -not (Assert-NoAdditionalCloudflared -Child $script:TunnelChild)) {
            Stop-OwnedCloudflared -Child $script:TunnelChild -EventCode 'TUNNEL_CONFLICT_STOP'
            $script:TunnelChild = $null
            Write-TunnelEvent -EventCode 'TUNNEL_CONFLICT'
        }

        $originIdentity = Get-StableLedgerOriginIdentity
        if ($null -eq $originIdentity) {
            Write-TunnelEvent -EventCode 'ORIGIN_INVALID'
            if ($null -ne $script:TunnelChild) {
                Stop-OwnedCloudflared -Child $script:TunnelChild -EventCode 'TUNNEL_FAIL_CLOSED'
                $script:TunnelChild = $null
            }
        } elseif ($null -eq $script:TunnelChild) {
            $script:TunnelChild = Start-OwnedCloudflared
            if ($null -ne $script:TunnelChild -and -not (Assert-NoAdditionalCloudflared -Child $script:TunnelChild)) {
                Stop-OwnedCloudflared -Child $script:TunnelChild -EventCode 'TUNNEL_CONFLICT_STOP'
                $script:TunnelChild = $null
                Write-TunnelEvent -EventCode 'TUNNEL_CONFLICT'
            } elseif ($null -ne $script:TunnelChild) {
                $postStartOriginIdentity = Get-StableLedgerOriginIdentity
                if ($null -eq $postStartOriginIdentity -or
                    -not (Test-SameOriginIdentity -First $originIdentity -Second $postStartOriginIdentity)) {
                    Write-TunnelEvent -EventCode 'ORIGIN_INVALID'
                    Stop-OwnedCloudflared -Child $script:TunnelChild -EventCode 'TUNNEL_FAIL_CLOSED'
                    $script:TunnelChild = $null
                }
            }
        }

        if ($MaxCycles -eq 0 -or $cycles -lt $MaxCycles) {
            Start-Sleep -Seconds $PollSeconds
        }
    }
} catch {
    try { Write-TunnelEvent -EventCode 'SUPERVISOR_FAILED' } catch { }
    [Console]::Error.WriteLine(('Ledger Tunnel supervisor failed safely at stage {0}.' -f $script:TunnelFailureStage))
    exit 1
} finally {
    $finalizationFailed = $false
    if ($null -ne $script:TunnelChild) {
        try {
            Stop-OwnedCloudflared -Child $script:TunnelChild -EventCode 'TUNNEL_SUPERVISOR_STOP'
            $script:TunnelChild = $null
        } catch {
            try { Write-TunnelEvent -EventCode 'CHILD_IDENTITY_CHANGED' -ChildProcessId ([int]$script:TunnelChild.Identity.ProcessId) } catch { }
            $finalizationFailed = $true
        }
    }
    try { Close-TunnelContainment } catch { $finalizationFailed = $true }
    Exit-TunnelSupervisorMutex
    if ($finalizationFailed) {
        [Console]::Error.WriteLine('Ledger Tunnel supervisor failed safely during finalization.')
        exit 1
    }
}
