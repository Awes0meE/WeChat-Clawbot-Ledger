[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [string]$CredentialPath,
    [string]$CloudflaredPath = 'D:\Clawbot\cloudflared\cloudflared.exe',
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9A-Fa-f]{64}$')]
    [string]$ExpectedCloudflaredSha256,
    [string]$TunnelConfigPath = 'D:\Clawbot\cloudflared\ledger.yml',
    [string]$EzBookkeepingExecutable = 'D:\Clawbot\ezbookkeeping\ezbookkeeping.exe',
    [string]$EzBookkeepingConfigPath = 'D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini',
    [string]$RuntimeDirectory = 'D:\Clawbot\cloudflared\runtime',
    [string]$LogPath = 'D:\Clawbot\cloudflared\logs\ledger-tunnel-supervisor.log',
    [ValidateSet('Clawbot Ledger Tunnel')]
    [string]$TaskName = 'Clawbot Ledger Tunnel',
    [string]$SupervisorSourcePath,
    [string]$CommonSourcePath
)

if ([string]::IsNullOrWhiteSpace($SupervisorSourcePath)) {
    $SupervisorSourcePath = Join-Path $PSScriptRoot 'ledger-tunnel-supervisor.ps1'
}
if ([string]::IsNullOrWhiteSpace($CommonSourcePath)) {
    $CommonSourcePath = Join-Path $PSScriptRoot 'ledger-runtime-common.ps1'
}
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:StrictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:RuntimeMarkerName = '.clawbot-ledger-tunnel-runtime-v1'
$script:RuntimeMarkerText = "CLAWBOT_LEDGER_TUNNEL_RUNTIME_V1`n"
$script:LogMarkerName = '.clawbot-ledger-tunnel-log-v1'
$script:LogMarkerText = "CLAWBOT_LEDGER_TUNNEL_LOG_V1 ledger-tunnel-supervisor.log`n"
$script:InstallFailureStage = 'PARAMETERS'

function Get-TunnelInstallNormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path.Trim()))
    if ($fullPath.Length -gt 3) {
        $fullPath = $fullPath.TrimEnd([char[]]@('\', '/'))
    }
    return $fullPath
}

function Test-TunnelInstallSamePath {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )

    return [string]::Equals((Get-TunnelInstallNormalizedPath -Path $Left), (Get-TunnelInstallNormalizedPath -Path $Right), [StringComparison]::OrdinalIgnoreCase)
}

function Assert-TunnelInstallLocalAbsolutePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim())
    if (-not [IO.Path]::IsPathRooted($expanded) -or $expanded.StartsWith('\\', [StringComparison]::Ordinal)) {
        throw 'A Tunnel path must be an absolute path on a local fixed drive.'
    }
    $normalized = Get-TunnelInstallNormalizedPath -Path $expanded
    $root = [IO.Path]::GetPathRoot($normalized)
    if ([string]::IsNullOrWhiteSpace($root) -or $root.StartsWith('\\', [StringComparison]::Ordinal)) {
        throw 'A Tunnel path must be an absolute path on a local fixed drive.'
    }
    try {
        $drive = New-Object IO.DriveInfo($root)
        if ([string]$drive.DriveType -cne 'Fixed') {
            throw 'not fixed'
        }
    } catch {
        throw 'A Tunnel path must be an absolute path on a local fixed drive.'
    }
    return $normalized
}

function Assert-TunnelInstallNoReparsePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $cursor = Assert-TunnelInstallLocalAbsolutePath -Path $Path
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            if (([IO.FileAttributes]$item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'A Tunnel path contains a reparse point.'
            }
        }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or (Test-TunnelInstallSamePath -Left $parent -Right $cursor)) { break }
        $cursor = $parent
    }
}

function Assert-TunnelInstallLogPathIsDistinct {
    param(
        [Parameter(Mandatory = $true)][string]$CandidateLogPath,
        [Parameter(Mandatory = $true)][string[]]$ReservedPaths
    )

    foreach ($logCandidate in @($CandidateLogPath, ($CandidateLogPath + '.1'))) {
        foreach ($reservedPath in $ReservedPaths) {
            if (Test-TunnelInstallSamePath -Left $logCandidate -Right $reservedPath) {
                throw 'The Tunnel log path collides with a protected runtime file.'
            }
        }
    }
}

function Assert-TunnelInstallExternalPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $normalized = Assert-TunnelInstallLocalAbsolutePath -Path $Path
    $repositoryRoot = Get-TunnelInstallNormalizedPath -Path (Join-Path $PSScriptRoot '..')
    if ([string]::Equals($normalized, $repositoryRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $normalized.StartsWith($repositoryRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $normalized -match '(?i)\\OneDrive(?:\s|\\|$)' -or
        $normalized -match '(?i)\\\.git(?:\\|$)') {
        throw 'A Tunnel runtime, config, credential, or log path must remain outside Git and OneDrive.'
    }
    Assert-TunnelInstallNoReparsePath -Path $normalized
    return $normalized
}

function Assert-TunnelInstallDedicatedLayout {
    param(
        [Parameter(Mandatory = $true)][string]$Cloudflared,
        [Parameter(Mandatory = $true)][string]$TunnelConfig,
        [Parameter(Mandatory = $true)][string]$Credential,
        [Parameter(Mandatory = $true)][string]$Runtime,
        [Parameter(Mandatory = $true)][string]$Log
    )

    $logDirectory = Split-Path -Parent $Log
    $runtimeBase = Split-Path -Parent $Runtime
    $logBase = Split-Path -Parent $logDirectory
    if ((Split-Path -Leaf $Runtime) -cne 'runtime' -or
        (Split-Path -Leaf $logDirectory) -cne 'logs' -or
        (Split-Path -Leaf $Log) -cne 'ledger-tunnel-supervisor.log' -or
        -not (Test-TunnelInstallSamePath -Left $runtimeBase -Right $logBase) -or
        -not (Test-TunnelInstallSamePath -Left (Split-Path -Parent $Cloudflared) -Right $runtimeBase) -or
        -not (Test-TunnelInstallSamePath -Left (Split-Path -Parent $TunnelConfig) -Right $runtimeBase) -or
        -not (Test-TunnelInstallSamePath -Left (Split-Path -Parent $Credential) -Right $runtimeBase) -or
        (Test-TunnelInstallSamePath -Left $runtimeBase -Right ([IO.Path]::GetPathRoot($runtimeBase)))) {
        throw 'Tunnel files must use one dedicated local cloudflared root with runtime and logs subdirectories.'
    }
}

function Get-TunnelInstallRuleIdentity {
    param([Parameter(Mandatory = $true)][object]$Rule)

    try {
        return [string]$Rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    } catch {
        return [string]$Rule.IdentityReference.Value
    }
}

function Assert-TunnelInstallProtectedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateSet('Leaf', 'Container')][string]$PathType = 'Leaf'
    )

    if (-not (Test-Path -LiteralPath $Path -PathType $PathType)) {
        throw 'A protected local Tunnel file was not found.'
    }
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $rules = @($acl.Access)
    if (-not $acl.AreAccessRulesProtected -or $rules.Count -ne 2) {
        throw 'A protected local Tunnel file has an unsafe ACL.'
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $ownerName = $identity.Name
    $ownerSid = [string]$identity.User.Value
    try {
        $actualOwner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    } catch {
        $actualOwner = [string]$acl.Owner
    }
    if (-not [string]::Equals($actualOwner, $ownerName, [StringComparison]::OrdinalIgnoreCase) -and
        -not [string]::Equals($actualOwner, $ownerSid, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A protected local Tunnel file has an unsafe owner.'
    }
    $ownerRules = @($rules | Where-Object {
        $value = Get-TunnelInstallRuleIdentity -Rule $_
        $value -ceq $ownerName -or $value -ceq $ownerSid
    })
    $systemRules = @($rules | Where-Object {
        $value = Get-TunnelInstallRuleIdentity -Rule $_
        $value -ceq 'S-1-5-18' -or $value -ceq 'NT AUTHORITY\SYSTEM'
    })
    if ($ownerRules.Count -ne 1 -or $systemRules.Count -ne 1) {
        throw 'A protected local Tunnel file is not owner and SYSTEM only.'
    }
    foreach ($rule in $rules) {
        if ([string]$rule.AccessControlType -cne 'Allow' -or [bool]$rule.IsInherited) {
            throw 'A protected local Tunnel file has an inherited or deny ACL.'
        }
    }
    if ([string]$ownerRules[0].FileSystemRights -notmatch 'FullControl') {
        throw 'The protected Tunnel file owner ACL is unsafe.'
    }
    $systemRights = [string]$systemRules[0].FileSystemRights
    if ($systemRights -notmatch 'Read' -or $systemRights -match 'Write|Modify|FullControl|Delete|ChangePermissions|TakeOwnership') {
        throw 'The protected Tunnel file grants SYSTEM more than minimal read access.'
    }
}

function Read-TunnelInstallConfiguration {
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        $text = [IO.File]::ReadAllText($Path, $script:StrictUtf8)
    } catch {
        throw 'The local Tunnel configuration is missing or invalid UTF-8.'
    }
    if ($text.Contains("`t")) {
        throw 'The local Tunnel configuration contains unsupported tabs.'
    }
    $lines = @([regex]::Split($text, "`r`n|`n|`r") | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_) -and $_ -notmatch '^\s*#'
    })
    if ($lines.Count -ne 7) {
        throw 'The local Tunnel configuration does not match the exact Ledger ingress.'
    }
    if ($lines[0] -cnotmatch '^tunnel:\s+([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$') {
        throw 'The local Tunnel configuration does not contain an exact named Tunnel UUID.'
    }
    $tunnelId = $matches[1]
    if ($lines[1] -cnotmatch "^credentials-file:\s+'([^']+)'$") {
        throw 'The local Tunnel configuration does not contain one literal credential path.'
    }
    $configuredCredential = Assert-TunnelInstallLocalAbsolutePath -Path $matches[1]
    Assert-TunnelInstallNoReparsePath -Path $configuredCredential
    if ((Split-Path -Leaf $configuredCredential) -cne ($tunnelId + '.json')) {
        throw 'The local Tunnel credential filename does not match the named Tunnel UUID.'
    }
    if ($lines[2] -cne 'no-autoupdate: true' -or
        $lines[3] -cne 'ingress:' -or
        $lines[4] -cne '  - hostname: ledger.66ccff-labs.com' -or
        $lines[5] -cne '    service: http://127.0.0.1:8888' -or
        $lines[6] -cne '  - service: http_status:404') {
        throw 'The local Tunnel configuration does not match the exact Ledger ingress.'
    }
    return [pscustomobject]@{
        TunnelId = $tunnelId
        CredentialPath = $configuredCredential
    }
}

function Get-HiddenWindowsPowerShell {
    $systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot')
    if ([string]::IsNullOrWhiteSpace($systemRoot)) {
        throw 'Windows PowerShell could not be located.'
    }
    $path = Get-TunnelInstallNormalizedPath -Path (Join-Path $systemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw 'Windows PowerShell could not be located.'
    }
    return $path
}

function ConvertTo-TaskQuotedArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) {
        throw 'A scheduled-task path contains an unsupported character.'
    }
    return '"' + $Value + '"'
}

function Get-TunnelTaskArguments {
    param(
        [Parameter(Mandatory = $true)][string]$InstalledSupervisor,
        [Parameter(Mandatory = $true)][string]$InstalledCommon,
        [Parameter(Mandatory = $true)][string]$Runtime,
        [Parameter(Mandatory = $true)][string]$Cloudflared,
        [Parameter(Mandatory = $true)][string]$CloudflaredSha256,
        [Parameter(Mandatory = $true)][string]$TunnelConfig,
        [Parameter(Mandatory = $true)][string]$EzBookkeeping,
        [Parameter(Mandatory = $true)][string]$EzBookkeepingConfig,
        [Parameter(Mandatory = $true)][string]$SupervisorLog
    )

    $arguments = @(
        '-NoLogo'
        '-NoProfile'
        '-NonInteractive'
        '-WindowStyle Hidden'
        '-ExecutionPolicy Bypass'
        ('-File ' + (ConvertTo-TaskQuotedArgument -Value $InstalledSupervisor))
        ('-CommonScriptPath ' + (ConvertTo-TaskQuotedArgument -Value $InstalledCommon))
        ('-RuntimeDirectory ' + (ConvertTo-TaskQuotedArgument -Value $Runtime))
        ('-CloudflaredPath ' + (ConvertTo-TaskQuotedArgument -Value $Cloudflared))
        ('-ExpectedCloudflaredSha256 ' + $CloudflaredSha256.ToUpperInvariant())
        ('-TunnelConfigPath ' + (ConvertTo-TaskQuotedArgument -Value $TunnelConfig))
        ('-EzBookkeepingExecutable ' + (ConvertTo-TaskQuotedArgument -Value $EzBookkeeping))
        ('-EzBookkeepingConfigPath ' + (ConvertTo-TaskQuotedArgument -Value $EzBookkeepingConfig))
        ('-LogPath ' + (ConvertTo-TaskQuotedArgument -Value $SupervisorLog))
    )
    return $arguments -join ' '
}

function Assert-NoTunnelServiceOrProcess {
    $services = @(Get-CimInstance Win32_Service -ErrorAction Stop | Where-Object {
        [string]$_.Name -match '(?i)cloudflared' -or
        [string]$_.DisplayName -match '(?i)cloudflared' -or
        [string]$_.PathName -match '(?i)cloudflared(?:\.exe)?'
    })
    if ($services.Count -gt 0) {
        throw 'A conflicting cloudflared service exists; refusing to install a second runtime.'
    }
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction Stop)
    if ($processes.Count -gt 0) {
        throw 'A conflicting cloudflared process exists; refusing to adopt or stop it.'
    }
}

function Assert-NoCloudflaredEnvironmentOverrides {
    foreach ($target in @(
        [EnvironmentVariableTarget]::Process,
        [EnvironmentVariableTarget]::User,
        [EnvironmentVariableTarget]::Machine
    )) {
        try {
            $variables = [Environment]::GetEnvironmentVariables($target)
        } catch {
            throw 'Cloudflared environment overrides could not be audited.'
        }
        foreach ($name in @($variables.Keys)) {
            $variableName = [string]$name
            if ($variableName -match '^(?i:TUNNEL_)' -or $variableName -ieq 'NO_AUTOUPDATE') {
                throw 'A cloudflared environment override is present; refusing an ambiguous runtime.'
            }
        }
    }
}

function Test-TunnelInstallExactTask {
    param(
        [Parameter(Mandatory = $true)][object]$Task,
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$ExpectedLauncher,
        [Parameter(Mandatory = $true)][string]$ExpectedArguments,
        [Parameter(Mandatory = $true)][string]$ExpectedWorkingDirectory,
        [Parameter(Mandatory = $true)][string]$ExpectedUser
    )

    try {
        $actions = @($Task.Actions)
        $triggers = @($Task.Triggers)
        if (-not [string]::Equals([string]$Task.TaskName, $TaskName, [StringComparison]::OrdinalIgnoreCase) -or
            [string]$Task.TaskPath -cne '\' -or
            $actions.Count -ne 1 -or
            -not (Test-TunnelInstallSamePath -Left ([string]$actions[0].Execute) -Right $ExpectedLauncher) -or
            [string]$actions[0].Arguments -cne $ExpectedArguments -or
            -not (Test-TunnelInstallSamePath -Left ([string]$actions[0].WorkingDirectory) -Right $ExpectedWorkingDirectory) -or
            -not [string]::Equals([string]$Task.Principal.UserId, $ExpectedUser, [StringComparison]::OrdinalIgnoreCase) -or
            [string]$Task.Principal.LogonType -cne 'Interactive' -or
            [string]$Task.Principal.RunLevel -cne 'Limited' -or
            $triggers.Count -ne 1 -or
            [string]$triggers[0].CimClass.CimClassName -cne 'MSFT_TaskLogonTrigger' -or
            -not [string]::Equals([string]$triggers[0].UserId, $ExpectedUser, [StringComparison]::OrdinalIgnoreCase) -or
            -not [bool]$triggers[0].Enabled -or
            -not [bool]$Task.Settings.Enabled -or
            [string]$Task.Settings.MultipleInstances -cne 'IgnoreNew' -or
            [int]$Task.Settings.RestartCount -ne 999 -or
            [string]$Task.Settings.RestartInterval -cne 'PT1M' -or
            [string]$Task.Settings.ExecutionTimeLimit -cne 'PT0S' -or
            -not [bool]$Task.Settings.StartWhenAvailable -or
            [bool]$Task.Settings.DisallowStartIfOnBatteries -or
            [bool]$Task.Settings.StopIfGoingOnBatteries) {
            return $false
        }
        return $true
    } catch {
        return $false
    }
}

function Assert-NoForeignTunnelTask {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$ExpectedLauncher,
        [Parameter(Mandatory = $true)][string]$ExpectedArguments,
        [Parameter(Mandatory = $true)][string]$ExpectedWorkingDirectory,
        [Parameter(Mandatory = $true)][string]$ExpectedUser
    )

    $recognizedTasks = @()
    foreach ($task in @(Get-ScheduledTask -ErrorAction Stop)) {
        $actions = @($task.Actions)
        $mentionsTunnel = [string]::Equals([string]$task.TaskName, $TaskName, [StringComparison]::OrdinalIgnoreCase)
        foreach ($action in $actions) {
            if ([string]$action.Execute -match '(?i)cloudflared|ledger-tunnel-supervisor' -or
                [string]$action.Arguments -match '(?i)cloudflared|ledger-tunnel-supervisor') {
                $mentionsTunnel = $true
            }
        }
        if (-not $mentionsTunnel) { continue }
        $recognized = Test-TunnelInstallExactTask -Task $task -TaskName $TaskName -ExpectedLauncher $ExpectedLauncher -ExpectedArguments $ExpectedArguments -ExpectedWorkingDirectory $ExpectedWorkingDirectory -ExpectedUser $ExpectedUser
        if (-not $recognized) {
            throw 'A foreign or mismatched Tunnel scheduled task conflicts with installation.'
        }
        $recognizedTasks += $task
    }
    if ($recognizedTasks.Count -gt 1) {
        throw 'Multiple Tunnel scheduled tasks conflict with installation.'
    }
    if ($recognizedTasks.Count -eq 1) { return $recognizedTasks[0] }
    return $null
}

function Get-FileSha256 {
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

function Assert-CloudflaredBinaryIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )

    if ((Get-FileSha256 -Path $Path) -cne $ExpectedSha256.ToUpperInvariant()) {
        throw 'The cloudflared binary hash does not match the approved release.'
    }
    $signature = Get-AuthenticodeSignature -FilePath $Path -ErrorAction Stop
    $subject = if ($null -ne $signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { '' }
    if ([string]$signature.Status -cne 'Valid' -or $subject -notmatch '(?i)(?:^|,\s*)O=Cloudflare, Inc\.(?:,|$)') {
        throw 'The cloudflared binary does not have a valid Cloudflare, Inc. signature.'
    }
}

function Copy-ImmutableRuntimeFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if ([IO.File]::Exists($Destination)) {
        if ((Get-FileSha256 -Path $Source) -cne (Get-FileSha256 -Path $Destination)) {
            throw 'An existing Tunnel runtime file differs; refusing to overwrite it.'
        }
        return
    }
    [IO.File]::Copy($Source, $Destination, $false)
}

function Set-TunnelRuntimeAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    if (Test-Path -LiteralPath $Path -PathType Container) {
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $ownerRule = New-Object Security.AccessControl.FileSystemAccessRule($owner, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $systemRule = New-Object Security.AccessControl.FileSystemAccessRule($system, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else {
        $acl = New-Object Security.AccessControl.FileSecurity
        $ownerRule = New-Object Security.AccessControl.FileSystemAccessRule($owner, 'FullControl', 'Allow')
        $systemRule = New-Object Security.AccessControl.FileSystemAccessRule($system, 'ReadAndExecute', 'Allow')
    }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetAccessRule($ownerRule)
    $acl.AddAccessRule($systemRule)
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}

function Assert-TunnelInstallMarker {
    param(
        [Parameter(Mandatory = $true)][string]$MarkerPath,
        [Parameter(Mandatory = $true)][string]$ExpectedText
    )

    if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) {
        throw 'An existing Tunnel directory is missing its ownership marker.'
    }
    try {
        $actual = [IO.File]::ReadAllText($MarkerPath, $script:StrictUtf8)
    } catch {
        throw 'A Tunnel directory ownership marker is invalid.'
    }
    if ($actual -cne $ExpectedText) {
        throw 'A Tunnel directory ownership marker is invalid.'
    }
    Assert-TunnelInstallProtectedFile -Path $MarkerPath
}

function Assert-TunnelInstallDirectoryOwnership {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$MarkerName,
        [Parameter(Mandatory = $true)][string]$MarkerText
    )

    if (-not (Test-Path -LiteralPath $Directory)) { return }
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        throw 'A dedicated Tunnel directory path is occupied by a file.'
    }
    Assert-TunnelInstallNoReparsePath -Path $Directory
    Assert-TunnelInstallProtectedFile -Path $Directory -PathType Container
    Assert-TunnelInstallMarker -MarkerPath (Join-Path $Directory $MarkerName) -ExpectedText $MarkerText
}

function Initialize-TunnelInstallOwnedDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$MarkerName,
        [Parameter(Mandatory = $true)][string]$MarkerText
    )

    $created = $false
    if (-not (Test-Path -LiteralPath $Directory)) {
        $null = New-Item -ItemType Directory -Path $Directory -ErrorAction Stop
        $created = $true
    }
    if (-not $created) {
        Assert-TunnelInstallDirectoryOwnership -Directory $Directory -MarkerName $MarkerName -MarkerText $MarkerText
        return (Join-Path $Directory $MarkerName)
    }

    $markerPath = Join-Path $Directory $MarkerName
    $stream = [IO.File]::Open($markerPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = $script:Utf8NoBom.GetBytes($MarkerText)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
    Set-TunnelRuntimeAcl -Path $Directory
    Set-TunnelRuntimeAcl -Path $markerPath
    return $markerPath
}

try {
    $script:InstallFailureStage = 'SOURCES'
    foreach ($sourcePath in @($SupervisorSourcePath, $CommonSourcePath)) {
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw 'A required Tunnel runtime source file is missing.'
        }
    }
    $cloudflared = Assert-TunnelInstallExternalPath -Path $CloudflaredPath
    $script:InstallFailureStage = 'PATHS'
    $config = Assert-TunnelInstallExternalPath -Path $TunnelConfigPath
    $credential = Assert-TunnelInstallExternalPath -Path $CredentialPath
    $runtime = Assert-TunnelInstallExternalPath -Path $RuntimeDirectory
    $log = Assert-TunnelInstallExternalPath -Path $LogPath
    $ezbookkeeping = Get-TunnelInstallNormalizedPath -Path $EzBookkeepingExecutable
    $ezbookkeepingConfig = Get-TunnelInstallNormalizedPath -Path $EzBookkeepingConfigPath
    if ((Split-Path -Leaf $cloudflared) -cne 'cloudflared.exe' -or
        -not (Test-Path -LiteralPath $cloudflared -PathType Leaf) -or
        -not (Test-Path -LiteralPath $config -PathType Leaf) -or
        -not (Test-Path -LiteralPath $credential -PathType Leaf) -or
        -not (Test-Path -LiteralPath $ezbookkeeping -PathType Leaf) -or
        -not (Test-Path -LiteralPath $ezbookkeepingConfig -PathType Leaf)) {
        throw 'An exact required Tunnel or ezBookkeeping file was not found.'
    }
    if ($config -match '["\s]') {
        throw 'The local Tunnel config path contains unsupported whitespace or quotes.'
    }
    $configuration = Read-TunnelInstallConfiguration -Path $config
    if (-not (Test-TunnelInstallSamePath -Left $configuration.CredentialPath -Right $credential)) {
        throw 'The exact Tunnel credential file does not match the local configuration.'
    }
    Assert-TunnelInstallDedicatedLayout -Cloudflared $cloudflared -TunnelConfig $config -Credential $credential -Runtime $runtime -Log $log
    $script:InstallFailureStage = 'FILES'
    $installedSupervisor = Join-Path $runtime 'ledger-tunnel-supervisor.ps1'
    $installedCommon = Join-Path $runtime 'ledger-runtime-common.ps1'
    $runtimeMarker = Join-Path $runtime $script:RuntimeMarkerName
    $logDirectory = Split-Path -Parent $log
    $logMarker = Join-Path $logDirectory $script:LogMarkerName
    Assert-TunnelInstallLogPathIsDistinct -CandidateLogPath $log -ReservedPaths @(
        $cloudflared,
        $config,
        $credential,
        $ezbookkeeping,
        $ezbookkeepingConfig,
        $SupervisorSourcePath,
        $CommonSourcePath,
        $installedSupervisor,
        $installedCommon,
        $runtimeMarker,
        $logMarker
    )
    Assert-TunnelInstallProtectedFile -Path $config
    Assert-TunnelInstallProtectedFile -Path $credential
    Assert-TunnelInstallProtectedFile -Path $cloudflared
    $script:InstallFailureStage = 'BINARY'
    Assert-CloudflaredBinaryIdentity -Path $cloudflared -ExpectedSha256 $ExpectedCloudflaredSha256
    $script:InstallFailureStage = 'ENVIRONMENT'
    Assert-NoCloudflaredEnvironmentOverrides
    $script:InstallFailureStage = 'DIRECTORY_OWNERSHIP'
    Assert-TunnelInstallDirectoryOwnership -Directory $runtime -MarkerName $script:RuntimeMarkerName -MarkerText $script:RuntimeMarkerText
    Assert-TunnelInstallDirectoryOwnership -Directory $logDirectory -MarkerName $script:LogMarkerName -MarkerText $script:LogMarkerText
    $script:InstallFailureStage = 'PROCESS_PREFLIGHT'
    Assert-NoTunnelServiceOrProcess

    $script:InstallFailureStage = 'TASK_PREFLIGHT'
    $launcher = Get-HiddenWindowsPowerShell
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $script:InstallFailureStage = 'TASK_ARGUMENTS'
    $taskArguments = Get-TunnelTaskArguments `
        -InstalledSupervisor $installedSupervisor `
        -InstalledCommon $installedCommon `
        -Runtime $runtime `
        -Cloudflared $cloudflared `
        -CloudflaredSha256 $ExpectedCloudflaredSha256 `
        -TunnelConfig $config `
        -EzBookkeeping $ezbookkeeping `
        -EzBookkeepingConfig $ezbookkeepingConfig `
        -SupervisorLog $log
    $script:InstallFailureStage = 'TASK_CONFLICTS'
    $null = Assert-NoForeignTunnelTask -TaskName $TaskName -ExpectedLauncher $launcher -ExpectedArguments $taskArguments -ExpectedWorkingDirectory $runtime -ExpectedUser $currentUser

    if (-not $PSCmdlet.ShouldProcess($TaskName, 'Validate the exact Ledger ingress and install its supervisor-only scheduled task')) {
        return
    }

    $script:InstallFailureStage = 'VALIDATION'
    Assert-NoCloudflaredEnvironmentOverrides
    Assert-CloudflaredBinaryIdentity -Path $cloudflared -ExpectedSha256 $ExpectedCloudflaredSha256
    $validation = Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--config', $config, 'ingress', 'validate') -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop
    if ($null -eq $validation -or [int]$validation.ExitCode -ne 0) {
        throw 'The local Tunnel ingress validation failed.'
    }

    $script:InstallFailureStage = 'DIRECTORIES'
    $runtimeMarker = Initialize-TunnelInstallOwnedDirectory -Directory $runtime -MarkerName $script:RuntimeMarkerName -MarkerText $script:RuntimeMarkerText
    $logMarker = Initialize-TunnelInstallOwnedDirectory -Directory $logDirectory -MarkerName $script:LogMarkerName -MarkerText $script:LogMarkerText
    Copy-ImmutableRuntimeFile -Source $SupervisorSourcePath -Destination $installedSupervisor
    Copy-ImmutableRuntimeFile -Source $CommonSourcePath -Destination $installedCommon
    Set-TunnelRuntimeAcl -Path $runtime
    Set-TunnelRuntimeAcl -Path $installedSupervisor
    Set-TunnelRuntimeAcl -Path $installedCommon
    Set-TunnelRuntimeAcl -Path $runtimeMarker
    Set-TunnelRuntimeAcl -Path $logMarker

    $script:InstallFailureStage = 'TASK_OBJECTS'
    $action = New-ScheduledTaskAction -Execute $launcher -Argument $taskArguments -WorkingDirectory $runtime
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $settings = New-ScheduledTaskSettingsSet `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
    Assert-NoCloudflaredEnvironmentOverrides
    Assert-NoTunnelServiceOrProcess
    $script:InstallFailureStage = 'TASK_REGISTRATION'
    $existingTask = Assert-NoForeignTunnelTask -TaskName $TaskName -ExpectedLauncher $launcher -ExpectedArguments $taskArguments -ExpectedWorkingDirectory $runtime -ExpectedUser $currentUser
    if ($null -eq $existingTask) {
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -ErrorAction Stop | Out-Null
        Write-Output 'LEDGER_TUNNEL_TASK_INSTALLED'
    } else {
        Write-Output 'LEDGER_TUNNEL_TASK_ALREADY_INSTALLED'
    }
} catch {
    throw ('Ledger Tunnel task installation refused an unsafe or conflicting state at stage {0}.' -f $script:InstallFailureStage)
}
