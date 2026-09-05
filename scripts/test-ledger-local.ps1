[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleasePath,
    [string]$CommonScriptPath,
    [string]$ReleaseVerifierPath,
    [string]$CloudflaredPath = 'D:\Clawbot\cloudflared\cloudflared.exe',
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9A-Fa-f]{64}$')]
    [string]$ExpectedCloudflaredSha256,
    [string]$TunnelConfigPath = 'D:\Clawbot\cloudflared\ledger.yml',
    [string]$CredentialPath,
    [string]$EzBookkeepingExecutable = 'D:\Clawbot\ezbookkeeping\ezbookkeeping.exe',
    [string]$EzBookkeepingConfigPath = 'D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini',
    [string]$TestInstallDirectory = 'D:\Clawbot\ezbookkeeping-test',
    [string]$TestConfigPath = 'D:\Clawbot\ezbookkeeping-test\conf\ezbookkeeping-test.ini',
    [string]$TunnelRuntimeDirectory = 'D:\Clawbot\cloudflared\runtime',
    [string]$TunnelLogPath = 'D:\Clawbot\cloudflared\logs\ledger-tunnel-supervisor.log',
    [ValidateSet('Clawbot Ledger Tunnel')]
    [string]$TunnelTaskName = 'Clawbot Ledger Tunnel'
)

if ([string]::IsNullOrWhiteSpace($CommonScriptPath)) {
    $CommonScriptPath = Join-Path $PSScriptRoot 'ledger-runtime-common.ps1'
}
if ([string]::IsNullOrWhiteSpace($ReleaseVerifierPath)) {
    $ReleaseVerifierPath = Join-Path $PSScriptRoot 'verify-openclaw-release.ps1'
}
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:StrictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
$script:Results = [ordered]@{}
$script:RuntimeMarkerName = '.clawbot-ledger-tunnel-runtime-v1'
$script:RuntimeMarkerText = "CLAWBOT_LEDGER_TUNNEL_RUNTIME_V1`n"
$script:LogMarkerName = '.clawbot-ledger-tunnel-log-v1'
$script:LogMarkerText = "CLAWBOT_LEDGER_TUNNEL_LOG_V1 ledger-tunnel-supervisor.log`n"

function Invoke-LocalLedgerCheck {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Check
    )

    try {
        $null = & $Check
        $script:Results[$Name] = 'pass'
    } catch {
        $script:Results[$Name] = 'fail'
    }
}

function Get-LocalNormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $value = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path.Trim()))
    if ($value.Length -gt 3) { $value = $value.TrimEnd([char[]]@('\', '/')) }
    return $value
}

function Test-LocalSamePath {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )

    return [string]::Equals((Get-LocalNormalizedPath -Path $Left), (Get-LocalNormalizedPath -Path $Right), [StringComparison]::OrdinalIgnoreCase)
}

function Get-LocalWindowsIdentitySid {
    param([Parameter(Mandatory = $true)][string]$Identity)

    if ([string]::IsNullOrWhiteSpace($Identity)) { return $null }
    try {
        return New-Object Security.Principal.SecurityIdentifier($Identity)
    } catch {
        try {
            $account = New-Object Security.Principal.NTAccount($Identity)
            return $account.Translate([Security.Principal.SecurityIdentifier])
        } catch {
            return $null
        }
    }
}

function Test-LocalSameWindowsIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )

    $leftSid = Get-LocalWindowsIdentitySid -Identity $Left
    $rightSid = Get-LocalWindowsIdentitySid -Identity $Right
    return $null -ne $leftSid -and $null -ne $rightSid -and $leftSid.Equals($rightSid)
}

function Assert-LocalAbsolutePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim())
    if (-not [IO.Path]::IsPathRooted($expanded) -or $expanded.StartsWith('\\', [StringComparison]::Ordinal)) {
        throw 'non-local path'
    }
    $normalized = Get-LocalNormalizedPath -Path $expanded
    $root = [IO.Path]::GetPathRoot($normalized)
    try {
        $drive = New-Object IO.DriveInfo($root)
        if ([string]$drive.DriveType -cne 'Fixed') { throw 'non-fixed path' }
    } catch {
        throw 'non-local path'
    }
    return $normalized
}

function Get-LocalEnvironmentVariables {
    param([Parameter(Mandatory = $true)][EnvironmentVariableTarget]$Target)

    return [Environment]::GetEnvironmentVariables($Target)
}

function Assert-LocalCloudflaredEnvironment {
    foreach ($target in @([EnvironmentVariableTarget]::Process, [EnvironmentVariableTarget]::User, [EnvironmentVariableTarget]::Machine)) {
        $variables = Get-LocalEnvironmentVariables -Target $target
        foreach ($name in @($variables.Keys)) {
            $variableName = [string]$name
            if ($variableName -match '^(?i:TUNNEL_)' -or $variableName -ieq 'NO_AUTOUPDATE') {
                throw 'cloudflared environment override'
            }
        }
    }
}

function Assert-LocalEzBookkeepingEnvironment {
    foreach ($target in @([EnvironmentVariableTarget]::Process, [EnvironmentVariableTarget]::User, [EnvironmentVariableTarget]::Machine)) {
        $variables = Get-LocalEnvironmentVariables -Target $target
        foreach ($name in @($variables.Keys)) {
            if ([string]$name -match '^(?i:EBK_|EBKCFP_)') { throw 'ezBookkeeping environment override' }
        }
    }
}

function Assert-LocalCloudflaredBinary {
    $cloudflared = Assert-LocalAbsolutePath -Path $CloudflaredPath
    if ((Get-LedgerFileSha256 -Path $cloudflared) -cne $ExpectedCloudflaredSha256.ToLowerInvariant()) {
        throw 'cloudflared hash mismatch'
    }
    $signature = Get-AuthenticodeSignature -FilePath $cloudflared -ErrorAction Stop
    $subject = if ($null -ne $signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { '' }
    if ([string]$signature.Status -cne 'Valid' -or $subject -notmatch '(?i)(?:^|,\s*)O=(?:"Cloudflare, Inc\."|Cloudflare, Inc\.)(?:,|$)') {
        throw 'cloudflared signature mismatch: Cloudflare, Inc.'
    }
}

function Assert-LocalMarker {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedText
    )

    Assert-LocalProtectedFile -Path $Path
    if ([IO.File]::ReadAllText($Path, $script:StrictUtf8) -cne $ExpectedText) { throw 'marker mismatch' }
}

function Read-LocalTunnelConfig {
    param([Parameter(Mandatory = $true)][string]$Path)

    $text = [IO.File]::ReadAllText($Path, $script:StrictUtf8)
    $lines = @([regex]::Split($text, "`r`n|`n|`r") | Where-Object {
        -not [string]::IsNullOrWhiteSpace($_) -and $_ -notmatch '^\s*#'
    })
    if ($text.Contains("`t") -or $lines.Count -ne 7) {
        throw 'invalid tunnel config'
    }
    if ($lines[0] -cnotmatch '^tunnel:\s+([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$') {
        throw 'invalid tunnel config'
    }
    $tunnelId = $matches[1]
    if ($lines[1] -cnotmatch "^credentials-file:\s+'([^']+)'$") {
        throw 'invalid tunnel config'
    }
    $credentialPath = Assert-LocalAbsolutePath -Path $matches[1]
    if ((Split-Path -Leaf $credentialPath) -cne ($tunnelId + '.json') -or
        $lines[2] -cne 'no-autoupdate: true' -or
        $lines[3] -cne 'ingress:' -or
        $lines[4] -cne '  - hostname: ledger.66ccff-labs.com' -or
        $lines[5] -cne '    service: http://127.0.0.1:8888' -or
        $lines[6] -cne '  - service: http_status:404') {
        throw 'invalid tunnel config'
    }
    return $credentialPath
}

function Assert-LocalProtectedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateSet('Leaf', 'Container')][string]$PathType = 'Leaf'
    )

    if (-not (Test-Path -LiteralPath $Path -PathType $PathType)) { throw 'missing protected path' }
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $rules = @($acl.Access)
    if (-not $acl.AreAccessRulesProtected -or $rules.Count -ne 2) { throw 'unsafe ACL' }
    $currentName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $currentSid = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    try {
        $actualOwner = [string]$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    } catch {
        $actualOwner = [string]$acl.Owner
    }
    if (-not [string]::Equals($actualOwner, $currentName, [StringComparison]::OrdinalIgnoreCase) -and
        -not [string]::Equals($actualOwner, $currentSid, [StringComparison]::OrdinalIgnoreCase)) { throw 'unsafe owner' }
    $ownerCount = 0
    $systemCount = 0
    foreach ($rule in $rules) {
        if ([string]$rule.AccessControlType -cne 'Allow' -or [bool]$rule.IsInherited) { throw 'unsafe ACL' }
        try {
            $identity = [string]$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        } catch {
            $identity = [string]$rule.IdentityReference.Value
        }
        if ($identity -ceq $currentName -or $identity -ceq $currentSid) {
            if ([string]$rule.FileSystemRights -notmatch 'FullControl') { throw 'unsafe owner ACL' }
            $ownerCount += 1
        } elseif ($identity -ceq 'S-1-5-18' -or $identity -ceq 'NT AUTHORITY\SYSTEM') {
            $rights = [string]$rule.FileSystemRights
            if ($rights -notmatch 'Read' -or $rights -match 'Write|Modify|FullControl|Delete|ChangePermissions|TakeOwnership') { throw 'unsafe SYSTEM ACL' }
            $systemCount += 1
        } else {
            throw 'unexpected ACL identity'
        }
    }
    if ($ownerCount -ne 1 -or $systemCount -ne 1) { throw 'incomplete ACL' }
}

function Get-LocalTaskArguments {
    param(
        [Parameter(Mandatory = $true)][string]$InstalledSupervisor,
        [Parameter(Mandatory = $true)][string]$InstalledCommon
    )

    foreach ($value in @($InstalledSupervisor, $InstalledCommon, $CloudflaredPath, $TunnelConfigPath, $EzBookkeepingExecutable, $EzBookkeepingConfigPath, $TunnelLogPath)) {
        if ($value.Contains('"') -or $value.Contains("`r") -or $value.Contains("`n")) { throw 'unsafe task path' }
    }
    $arguments = @(
        '-NoLogo'
        '-NoProfile'
        '-NonInteractive'
        '-WindowStyle Hidden'
        '-ExecutionPolicy Bypass'
        ('-File "' + $InstalledSupervisor + '"')
        ('-CommonScriptPath "' + $InstalledCommon + '"')
        ('-RuntimeDirectory "' + (Get-LocalNormalizedPath -Path $TunnelRuntimeDirectory) + '"')
        ('-CloudflaredPath "' + (Get-LocalNormalizedPath -Path $CloudflaredPath) + '"')
        ('-ExpectedCloudflaredSha256 ' + $ExpectedCloudflaredSha256.ToUpperInvariant())
        ('-TunnelConfigPath "' + (Get-LocalNormalizedPath -Path $TunnelConfigPath) + '"')
        ('-EzBookkeepingExecutable "' + (Get-LocalNormalizedPath -Path $EzBookkeepingExecutable) + '"')
        ('-EzBookkeepingConfigPath "' + (Get-LocalNormalizedPath -Path $EzBookkeepingConfigPath) + '"')
        ('-LogPath "' + (Get-LocalNormalizedPath -Path $TunnelLogPath) + '"')
    )
    return $arguments -join ' '
}

function Assert-LocalScheduledTaskPolicy {
    param(
        [Parameter(Mandatory = $true)][object]$Task,
        [Parameter(Mandatory = $true)][int]$ExpectedRestartCount
    )

    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $triggers = @($Task.Triggers)
    if (-not (Test-LocalSameWindowsIdentity -Left ([string]$Task.Principal.UserId) -Right $currentUser) -or
        [string]$Task.Principal.LogonType -cne 'Interactive' -or
        [string]$Task.Principal.RunLevel -cne 'Limited' -or
        $triggers.Count -ne 1 -or
        [string]$triggers[0].CimClass.CimClassName -cne 'MSFT_TaskLogonTrigger' -or
        -not (Test-LocalSameWindowsIdentity -Left ([string]$triggers[0].UserId) -Right $currentUser) -or
        -not [bool]$triggers[0].Enabled -or
        -not [bool]$Task.Settings.Enabled -or
        [string]$Task.Settings.MultipleInstances -cne 'IgnoreNew' -or
        [int]$Task.Settings.RestartCount -ne $ExpectedRestartCount -or
        [string]$Task.Settings.RestartInterval -cne 'PT1M' -or
        [string]$Task.Settings.ExecutionTimeLimit -cne 'PT0S' -or
        -not [bool]$Task.Settings.StartWhenAvailable -or
        [bool]$Task.Settings.DisallowStartIfOnBatteries -or
        [bool]$Task.Settings.StopIfGoingOnBatteries) {
        throw 'scheduled task policy mismatch'
    }
}

if (-not (Test-Path -LiteralPath $CommonScriptPath -PathType Leaf)) {
    throw 'Ledger local checks cannot load their runtime helper.'
}
. $CommonScriptPath

Invoke-LocalLedgerCheck -Name 'production_listener' -Check {
    $null = Get-LedgerListenerOwner -Port 8888 -ExpectedExecutable $EzBookkeepingExecutable -ExpectedConfigPath $EzBookkeepingConfigPath
    if (-not (Test-LedgerOrigin -Port 8888)) { throw 'origin failed' }
}

Invoke-LocalLedgerCheck -Name 'production_configuration' -Check {
    Assert-LocalEzBookkeepingEnvironment
    Assert-LedgerNoExistingReparsePath -Path $EzBookkeepingConfigPath
    Assert-LocalProtectedFile -Path $EzBookkeepingConfigPath
    $document = Get-LedgerIniDocument -Path $EzBookkeepingConfigPath
    $required = @{
        'global.mode' = 'production'
        'uuid.generator_type' = 'internal'
        'uuid.server_id' = '0'
        'duplicate_checker.checker_type' = 'in_memory'
        'duplicate_checker.cleanup_interval' = '60'
        'duplicate_checker.duplicate_submissions_interval' = '300'
        'server.protocol' = 'http'
        'server.http_addr' = '127.0.0.1'
        'server.http_port' = '8888'
        'server.domain' = 'ledger.66ccff-labs.com'
        'server.root_url' = 'https://ledger.66ccff-labs.com/'
        'mcp.mcp_allowed_remote_ips' = '127.0.0.1'
        'database.type' = 'sqlite3'
        'security.trusted_proxy_ips' = '127.0.0.1/32'
        'security.token_expired_time' = '604800'
        'security.token_min_refresh_interval' = '86400'
        'security.enable_api_token' = 'true'
        'security.api_token_allowed_remote_ips' = '127.0.0.1'
        'security.max_failures_per_ip_per_minute' = '5'
        'security.max_failures_per_user_per_minute' = '5'
        'auth.enable_internal_auth' = 'true'
        'auth.enable_oauth2_auth' = 'false'
        'auth.enable_two_factor' = 'true'
        'auth.enable_forget_password' = 'false'
        'auth.oauth2_user_identifier' = 'email'
        'user.enable_register' = 'false'
        'map.amap_security_verification_method' = 'internal_proxy'
        'exchange_rates.data_source' = 'euro_central_bank'
    }
    foreach ($key in $required.Keys) {
        $separator = $key.IndexOf('.')
        $actual = Get-LedgerIniValue -Document $document -Section $key.Substring(0, $separator) -Name $key.Substring($separator + 1)
        if ($actual -cne $required[$key]) { throw 'production configuration failed' }
    }
    $mcpEnabled = Get-LedgerIniValue -Document $document -Section 'mcp' -Name 'enable_mcp'
    if ($mcpEnabled -notin @('true', 'false')) { throw 'production MCP enable state failed' }
    if ($document.Text -notmatch '(?m)^; CLAWBOT_LEDGER_PROFILE=production\s*$') { throw 'profile failed' }
}

Invoke-LocalLedgerCheck -Name 'production_task' -Check {
    $task = Get-LedgerExpectedTask `
        -TaskName 'Clawbot ezBookkeeping' `
        -InstallDirectory (Split-Path -Parent (Get-LocalNormalizedPath -Path $EzBookkeepingExecutable)) `
        -ExpectedExecutable $EzBookkeepingExecutable `
        -ConfigPath $EzBookkeepingConfigPath `
        -Mode Explicit
    Assert-LocalScheduledTaskPolicy -Task $task -ExpectedRestartCount 3
}

Invoke-LocalLedgerCheck -Name 'test_isolation' -Check {
    $testDocument = Assert-LedgerTestConfiguration -InstallDirectory $TestInstallDirectory -ConfigPath $TestConfigPath
    $testDatabase = Resolve-LedgerDataPath -InstallDirectory $TestInstallDirectory -ConfiguredPath (Get-LedgerIniValue -Document $testDocument -Section 'database' -Name 'db_path')
    $productionDocument = Get-LedgerIniDocument -Path $EzBookkeepingConfigPath
    $productionDatabase = Resolve-LedgerDataPath -InstallDirectory (Split-Path -Parent $EzBookkeepingExecutable) -ConfiguredPath (Get-LedgerIniValue -Document $productionDocument -Section 'database' -Name 'db_path')
    if (Test-LocalSamePath -Left $testDatabase -Right $productionDatabase) { throw 'database overlap' }
    $testExecutable = Join-Path $TestInstallDirectory 'ezbookkeeping.exe'
    $null = Get-LedgerListenerOwner -Port 18888 -ExpectedExecutable $testExecutable -ExpectedConfigPath $TestConfigPath
    if (-not (Test-LedgerOrigin -Port 18888)) { throw 'test origin failed' }
}

Invoke-LocalLedgerCheck -Name 'release' -Check {
    if (-not (Test-Path -LiteralPath $ReleaseVerifierPath -PathType Leaf)) { throw 'missing release verifier' }
    $output = @(& $ReleaseVerifierPath -ReleasePath $ReleasePath)
    if ($output.Count -ne 1 -or [string]$output[0] -cne 'OPENCLAW_RELEASE_VERIFIED') { throw 'release failed' }
}

Invoke-LocalLedgerCheck -Name 'tunnel_files' -Check {
    Assert-LocalCloudflaredEnvironment
    $configuredCredential = Read-LocalTunnelConfig -Path $TunnelConfigPath
    $expectedCredential = if ([string]::IsNullOrWhiteSpace($CredentialPath)) { $configuredCredential } else { Get-LocalNormalizedPath -Path $CredentialPath }
    if (-not (Test-LocalSamePath -Left $configuredCredential -Right $expectedCredential)) { throw 'credential mismatch' }
    foreach ($path in @($CloudflaredPath, $TunnelConfigPath, $configuredCredential)) {
        $null = Assert-LocalAbsolutePath -Path $path
        Assert-LedgerNoExistingReparsePath -Path $path
    }
    Assert-LocalProtectedFile -Path $TunnelConfigPath
    Assert-LocalProtectedFile -Path $configuredCredential
    Assert-LocalProtectedFile -Path $CloudflaredPath
}

Invoke-LocalLedgerCheck -Name 'tunnel_layout' -Check {
    $configuredCredential = Read-LocalTunnelConfig -Path $TunnelConfigPath
    $runtime = Get-LocalNormalizedPath -Path $TunnelRuntimeDirectory
    $logDirectory = Split-Path -Parent (Get-LocalNormalizedPath -Path $TunnelLogPath)
    $runtimeBase = Split-Path -Parent $runtime
    if ((Split-Path -Leaf $runtime) -cne 'runtime' -or
        (Split-Path -Leaf $logDirectory) -cne 'logs' -or
        (Split-Path -Leaf (Get-LocalNormalizedPath -Path $TunnelLogPath)) -cne 'ledger-tunnel-supervisor.log' -or
        -not (Test-LocalSamePath -Left (Split-Path -Parent $logDirectory) -Right $runtimeBase) -or
        -not (Test-LocalSamePath -Left (Split-Path -Parent (Get-LocalNormalizedPath -Path $CloudflaredPath)) -Right $runtimeBase) -or
        -not (Test-LocalSamePath -Left (Split-Path -Parent (Get-LocalNormalizedPath -Path $TunnelConfigPath)) -Right $runtimeBase) -or
        -not (Test-LocalSamePath -Left (Split-Path -Parent $configuredCredential) -Right $runtimeBase)) {
        throw 'dedicated Tunnel layout mismatch'
    }
    foreach ($path in @($runtime, $logDirectory)) {
        $null = Assert-LocalAbsolutePath -Path $path
        Assert-LedgerNoExistingReparsePath -Path $path
    }
    Assert-LocalProtectedFile -Path $runtime -PathType Container
    Assert-LocalProtectedFile -Path $logDirectory -PathType Container
    Assert-LocalMarker -Path (Join-Path $runtime $script:RuntimeMarkerName) -ExpectedText $script:RuntimeMarkerText
    Assert-LocalMarker -Path (Join-Path $logDirectory $script:LogMarkerName) -ExpectedText $script:LogMarkerText
}

Invoke-LocalLedgerCheck -Name 'tunnel_binary' -Check {
    Assert-LocalCloudflaredEnvironment
    Assert-LocalCloudflaredBinary
}

Invoke-LocalLedgerCheck -Name 'tunnel_runtime_integrity' -Check {
    $runtime = Get-LocalNormalizedPath -Path $TunnelRuntimeDirectory
    $installedSupervisor = Join-Path $runtime 'ledger-tunnel-supervisor.ps1'
    $installedCommon = Join-Path $runtime 'ledger-runtime-common.ps1'
    $supervisorSource = Join-Path $PSScriptRoot 'ledger-tunnel-supervisor.ps1'
    Assert-LocalProtectedFile -Path $installedSupervisor
    Assert-LocalProtectedFile -Path $installedCommon
    if ((Get-LedgerFileSha256 -Path $installedSupervisor) -cne (Get-LedgerFileSha256 -Path $supervisorSource) -or
        (Get-LedgerFileSha256 -Path $installedCommon) -cne (Get-LedgerFileSha256 -Path $CommonScriptPath)) {
        throw 'installed Tunnel runtime differs from its verified source'
    }
}

Invoke-LocalLedgerCheck -Name 'tunnel_task_launcher' -Check {
    $launcher = Join-Path ([Environment]::GetEnvironmentVariable('SystemRoot')) 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { [string]::Equals([string]$_.TaskName, $TunnelTaskName, [StringComparison]::OrdinalIgnoreCase) -and $_.TaskPath -ceq '\' })
    if ($tasks.Count -ne 1 -or @($tasks[0].Actions).Count -ne 1) { throw 'task missing' }
    $action = @($tasks[0].Actions)[0]
    if (-not (Test-LocalSamePath -Left ([string]$action.Execute) -Right $launcher)) { throw 'task launcher mismatch' }
}

Invoke-LocalLedgerCheck -Name 'tunnel_task_arguments' -Check {
    $runtime = Get-LocalNormalizedPath -Path $TunnelRuntimeDirectory
    $installedSupervisor = Join-Path $runtime 'ledger-tunnel-supervisor.ps1'
    $installedCommon = Join-Path $runtime 'ledger-runtime-common.ps1'
    $expectedArguments = Get-LocalTaskArguments -InstalledSupervisor $installedSupervisor -InstalledCommon $installedCommon
    $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { [string]::Equals([string]$_.TaskName, $TunnelTaskName, [StringComparison]::OrdinalIgnoreCase) -and $_.TaskPath -ceq '\' })
    if ($tasks.Count -ne 1 -or @($tasks[0].Actions).Count -ne 1 -or
        [string]@($tasks[0].Actions)[0].Arguments -cne $expectedArguments) { throw 'task arguments mismatch' }
}

Invoke-LocalLedgerCheck -Name 'tunnel_task_working_directory' -Check {
    $runtime = Get-LocalNormalizedPath -Path $TunnelRuntimeDirectory
    $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { [string]::Equals([string]$_.TaskName, $TunnelTaskName, [StringComparison]::OrdinalIgnoreCase) -and $_.TaskPath -ceq '\' })
    if ($tasks.Count -ne 1 -or @($tasks[0].Actions).Count -ne 1 -or
        -not (Test-LocalSamePath -Left ([string]@($tasks[0].Actions)[0].WorkingDirectory) -Right $runtime)) { throw 'task working directory mismatch' }
}

Invoke-LocalLedgerCheck -Name 'tunnel_task_principal' -Check {
    $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { [string]::Equals([string]$_.TaskName, $TunnelTaskName, [StringComparison]::OrdinalIgnoreCase) -and $_.TaskPath -ceq '\' })
    if ($tasks.Count -ne 1) { throw 'task missing' }
    $triggers = @($tasks[0].Triggers)
    if (-not (Test-LocalSameWindowsIdentity -Left ([string]$tasks[0].Principal.UserId) -Right ([Security.Principal.WindowsIdentity]::GetCurrent().Name)) -or
        [string]$tasks[0].Principal.LogonType -cne 'Interactive' -or
        [string]$tasks[0].Principal.RunLevel -cne 'Limited' -or
        $triggers.Count -ne 1 -or
        [string]$triggers[0].CimClass.CimClassName -cne 'MSFT_TaskLogonTrigger' -or
        -not (Test-LocalSameWindowsIdentity -Left ([string]$triggers[0].UserId) -Right ([Security.Principal.WindowsIdentity]::GetCurrent().Name)) -or
        -not [bool]$triggers[0].Enabled -or
        -not [bool]$tasks[0].Settings.Enabled -or
        [string]$tasks[0].Settings.MultipleInstances -cne 'IgnoreNew' -or
        [int]$tasks[0].Settings.RestartCount -ne 999 -or
        [string]$tasks[0].Settings.RestartInterval -cne 'PT1M' -or
        [string]$tasks[0].Settings.ExecutionTimeLimit -cne 'PT0S' -or
        -not [bool]$tasks[0].Settings.StartWhenAvailable -or
        [bool]$tasks[0].Settings.DisallowStartIfOnBatteries -or
        [bool]$tasks[0].Settings.StopIfGoingOnBatteries) { throw 'principal or task policy mismatch' }
}

Invoke-LocalLedgerCheck -Name 'tunnel_child' -Check {
    $cloudflared = Get-LocalNormalizedPath -Path $CloudflaredPath
    $config = Get-LocalNormalizedPath -Path $TunnelConfigPath
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction Stop)
    if ($processes.Count -ne 1 -or -not (Test-LocalSamePath -Left ([string]$processes[0].ExecutablePath) -Right $cloudflared)) { throw 'child mismatch' }
    $expected = @(
        ('"' + $cloudflared + '" tunnel --config "' + $config + '" run')
        ($cloudflared + ' tunnel --config "' + $config + '" run')
        ('"' + $cloudflared + '" tunnel --config ' + $config + ' run')
        ($cloudflared + ' tunnel --config ' + $config + ' run')
    )
    $commandMatches = $false
    foreach ($expectedCommandLine in $expected) {
        if ([string]::Equals([string]$processes[0].CommandLine, $expectedCommandLine, [StringComparison]::OrdinalIgnoreCase)) {
            $commandMatches = $true
            break
        }
    }
    if (-not $commandMatches) { throw 'child command mismatch' }
}

$json = [pscustomobject]$script:Results | ConvertTo-Json -Compress
Write-Output $json
if (@($script:Results.Values | Where-Object { $_ -cne 'pass' }).Count -gt 0) {
    exit 1
}
