[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleasePath,

    [Parameter(Mandatory = $true)]
    [string]$PortfolioBaselinePath,

    [string]$ProductionTaskName = 'Clawbot ezBookkeeping',
    [string]$TunnelTaskName = 'Clawbot Ledger Tunnel',
    [string]$EzBookkeepingExecutable = 'D:\Clawbot\ezbookkeeping\ezbookkeeping.exe',
    [string]$EzBookkeepingConfigPath = 'D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini',
    [string]$CloudflaredPath = 'D:\Clawbot\cloudflared\cloudflared.exe',
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9A-Fa-f]{64}$')]
    [string]$ExpectedCloudflaredSha256,
    [string]$TunnelConfigPath = 'D:\Clawbot\cloudflared\ledger.yml',
    [string]$TunnelRuntimeDirectory = 'D:\Clawbot\cloudflared\runtime',
    [string]$TunnelLogPath = 'D:\Clawbot\cloudflared\logs\ledger-tunnel-supervisor.log',
    [string]$CommonScriptPath,
    [string]$LocalTestPath,
    [string]$PublicTestPath,
    [string]$ApiTokenPath,
    [string]$McpTokenPath,
    [string]$OpenClawExecutable = 'openclaw.cmd',
    [ValidateSet('ServiceCycle', 'CapturePreReboot', 'VerifyPostReboot')]
    [string]$Phase = 'ServiceCycle',
    [string]$RebootEvidencePath,

    [ValidateRange(5, 180)]
    [int]$TransitionTimeoutSec = 45,

    [ValidateRange(1, 10)]
    [int]$PollSeconds = 2
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($CommonScriptPath)) {
    $CommonScriptPath = Join-Path $PSScriptRoot 'ledger-runtime-common.ps1'
}
if ([string]::IsNullOrWhiteSpace($LocalTestPath)) {
    $LocalTestPath = Join-Path $PSScriptRoot 'test-ledger-local.ps1'
}
if ([string]::IsNullOrWhiteSpace($PublicTestPath)) {
    $PublicTestPath = Join-Path $PSScriptRoot 'test-ledger-public.ps1'
}

function Get-RestartNormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A required restart-test path was empty.' }
    $normalized = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path.Trim()))
    if ($normalized.Length -gt 3) { $normalized = $normalized.TrimEnd([char[]]@('\', '/')) }
    return $normalized
}

function Test-RestartSamePath {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )

    return [string]::Equals(
        (Get-RestartNormalizedPath -Path $Left),
        (Get-RestartNormalizedPath -Path $Right),
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Get-RestartWindowsIdentitySid {
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

function Test-RestartSameWindowsIdentity {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )

    $leftSid = Get-RestartWindowsIdentitySid -Identity $Left
    $rightSid = Get-RestartWindowsIdentitySid -Identity $Right
    return $null -ne $leftSid -and $null -ne $rightSid -and $leftSid.Equals($rightSid)
}

function ConvertTo-RestartTaskQuotedArgument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) {
        throw 'A restart-test task argument contains an unsupported character.'
    }
    return '"' + $Value + '"'
}

function Get-ExpectedTunnelTaskArguments {
    param(
        [Parameter(Mandatory = $true)][string]$Runtime,
        [Parameter(Mandatory = $true)][string]$Cloudflared,
        [Parameter(Mandatory = $true)][string]$CloudflaredSha256,
        [Parameter(Mandatory = $true)][string]$TunnelConfig,
        [Parameter(Mandatory = $true)][string]$EzBookkeeping,
        [Parameter(Mandatory = $true)][string]$EzBookkeepingConfig,
        [Parameter(Mandatory = $true)][string]$SupervisorLog
    )

    $supervisor = Join-Path $Runtime 'ledger-tunnel-supervisor.ps1'
    $common = Join-Path $Runtime 'ledger-runtime-common.ps1'
    return @(
        '-NoLogo'
        '-NoProfile'
        '-NonInteractive'
        '-WindowStyle Hidden'
        '-ExecutionPolicy Bypass'
        ('-File ' + (ConvertTo-RestartTaskQuotedArgument -Value $supervisor))
        ('-CommonScriptPath ' + (ConvertTo-RestartTaskQuotedArgument -Value $common))
        ('-RuntimeDirectory ' + (ConvertTo-RestartTaskQuotedArgument -Value $Runtime))
        ('-CloudflaredPath ' + (ConvertTo-RestartTaskQuotedArgument -Value $Cloudflared))
        ('-ExpectedCloudflaredSha256 ' + $CloudflaredSha256.ToUpperInvariant())
        ('-TunnelConfigPath ' + (ConvertTo-RestartTaskQuotedArgument -Value $TunnelConfig))
        ('-EzBookkeepingExecutable ' + (ConvertTo-RestartTaskQuotedArgument -Value $EzBookkeeping))
        ('-EzBookkeepingConfigPath ' + (ConvertTo-RestartTaskQuotedArgument -Value $EzBookkeepingConfig))
        ('-LogPath ' + (ConvertTo-RestartTaskQuotedArgument -Value $SupervisorLog))
    ) -join ' '
}

function Get-ExactTunnelTask {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Runtime,
        [Parameter(Mandatory = $true)][string]$Cloudflared,
        [Parameter(Mandatory = $true)][string]$CloudflaredSha256,
        [Parameter(Mandatory = $true)][string]$TunnelConfig,
        [Parameter(Mandatory = $true)][string]$EzBookkeeping,
        [Parameter(Mandatory = $true)][string]$EzBookkeepingConfig,
        [Parameter(Mandatory = $true)][string]$SupervisorLog
    )

    $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { [string]::Equals([string]$_.TaskName, $Name, [StringComparison]::OrdinalIgnoreCase) -and $_.TaskPath -ceq '\' })
    if ($tasks.Count -ne 1 -or @($tasks[0].Actions).Count -ne 1) {
        throw 'The exact Ledger Tunnel scheduled task was not found.'
    }
    $systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot')
    $launcher = Join-Path $systemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $expectedArguments = Get-ExpectedTunnelTaskArguments `
        -Runtime $Runtime `
        -Cloudflared $Cloudflared `
        -CloudflaredSha256 $CloudflaredSha256 `
        -TunnelConfig $TunnelConfig `
        -EzBookkeeping $EzBookkeeping `
        -EzBookkeepingConfig $EzBookkeepingConfig `
        -SupervisorLog $SupervisorLog
    $action = @($tasks[0].Actions)[0]
    if (-not (Test-RestartSamePath -Left ([string]$action.Execute) -Right $launcher) -or
        -not (Test-RestartSamePath -Left ([string]$action.WorkingDirectory) -Right $Runtime) -or
        [string]$action.Arguments -cne $expectedArguments) {
        throw 'The Ledger Tunnel scheduled task action or principal is not recognized.'
    }
    Assert-RestartTaskPolicy -Task $tasks[0] -ExpectedRestartCount 999
    return $tasks[0]
}

function Assert-RestartTaskPolicy {
    param(
        [Parameter(Mandatory = $true)][object]$Task,
        [Parameter(Mandatory = $true)][int]$ExpectedRestartCount
    )

    $expectedUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $triggers = @($Task.Triggers)
    if (-not (Test-RestartSameWindowsIdentity -Left ([string]$Task.Principal.UserId) -Right $expectedUser) -or
        [string]$Task.Principal.LogonType -cne 'Interactive' -or
        [string]$Task.Principal.RunLevel -cne 'Limited' -or
        $triggers.Count -ne 1 -or
        [string]$triggers[0].CimClass.CimClassName -cne 'MSFT_TaskLogonTrigger' -or
        -not (Test-RestartSameWindowsIdentity -Left ([string]$triggers[0].UserId) -Right $expectedUser) -or
        -not [bool]$triggers[0].Enabled -or
        -not [bool]$Task.Settings.Enabled -or
        [string]$Task.Settings.MultipleInstances -cne 'IgnoreNew' -or
        [int]$Task.Settings.RestartCount -ne $ExpectedRestartCount -or
        [string]$Task.Settings.RestartInterval -cne 'PT1M' -or
        [string]$Task.Settings.ExecutionTimeLimit -cne 'PT0S' -or
        -not [bool]$Task.Settings.StartWhenAvailable -or
        [bool]$Task.Settings.DisallowStartIfOnBatteries -or
        [bool]$Task.Settings.StopIfGoingOnBatteries) {
        throw 'A restart-acceptance scheduled task does not match the complete installed identity.'
    }
}

function Get-ExactProductionTask {
    $task = Get-LedgerExpectedTask `
        -TaskName $ProductionTaskName `
        -InstallDirectory (Split-Path -Parent $ezbookkeeping) `
        -ExpectedExecutable $ezbookkeeping `
        -ConfigPath $ezbookkeepingConfig `
        -Mode Explicit
    Assert-RestartTaskPolicy -Task $task -ExpectedRestartCount 3
    return $task
}

function Assert-ProductionPortClearBeforeStart {
    $listeners = @(Get-LedgerListeningTcpConnections -Port 8888)
    if ($listeners.Count -ne 0) {
        throw 'RECOVERY_INCOMPLETE: port 8888 is still occupied; the production task was not started.'
    }
}

function Assert-TunnelChildAbsentBeforeStart {
    $children = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction Stop)
    if ($children.Count -ne 0) {
        throw 'RECOVERY_INCOMPLETE: a cloudflared process is still present; the Tunnel task was not started.'
    }
}

function Get-ExpectedCloudflaredChild {
    param(
        [Parameter(Mandatory = $true)][string]$Cloudflared,
        [Parameter(Mandatory = $true)][string]$TunnelConfig,
        [switch]$AllowAbsent
    )

    $expectedExecutable = Get-RestartNormalizedPath -Path $Cloudflared
    $expectedConfig = Get-RestartNormalizedPath -Path $TunnelConfig
    $all = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction Stop)
    $matching = @()
    foreach ($process in $all) {
        if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath) -or
            -not (Test-RestartSamePath -Left ([string]$process.ExecutablePath) -Right $expectedExecutable)) {
            throw 'An unknown cloudflared process is present; restart acceptance refused to adopt or terminate it.'
        }
        $validCommands = @(
            '"' + $expectedExecutable + '" tunnel --config "' + $expectedConfig + '" run',
            $expectedExecutable + ' tunnel --config "' + $expectedConfig + '" run',
            '"' + $expectedExecutable + '" tunnel --config ' + $expectedConfig + ' run',
            $expectedExecutable + ' tunnel --config ' + $expectedConfig + ' run'
        )
        if (-not ($validCommands -contains [string]$process.CommandLine)) {
            throw 'A cloudflared process has an unrecognized command line; restart acceptance refused it.'
        }
        $matching += $process
    }
    if ($matching.Count -eq 0 -and $AllowAbsent) { return $null }
    if ($matching.Count -ne 1) { throw 'Restart acceptance requires exactly one recognized cloudflared child.' }
    return $matching[0]
}

function Wait-Until {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Condition,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TransitionTimeoutSec)
    do {
        try {
            if (& $Condition) { return }
        } catch {
            # Transient probe failures remain redacted until the bounded deadline.
        }
        Start-Sleep -Seconds $PollSeconds
    } while ([DateTime]::UtcNow -lt $deadline)
    throw $FailureMessage
}

function Invoke-RedactedPowerShellCheck {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    $systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot')
    $powershell = Join-Path $systemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $global:LASTEXITCODE = 0
    try {
        $discarded = @(& $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath @Arguments 2>&1)
    } catch {
        throw $FailureMessage
    }
    $exitCode = $LASTEXITCODE
    $discarded = $null
    if ($exitCode -ne 0) { throw $FailureMessage }
}

function Invoke-LocalAcceptance {
    $arguments = @(
        '-ReleasePath', $release,
        '-CommonScriptPath', $common,
        '-CloudflaredPath', $cloudflared,
        '-ExpectedCloudflaredSha256', $ExpectedCloudflaredSha256.ToUpperInvariant(),
        '-TunnelConfigPath', $tunnelConfig,
        '-EzBookkeepingExecutable', $ezbookkeeping,
        '-EzBookkeepingConfigPath', $ezbookkeepingConfig,
        '-TunnelRuntimeDirectory', $runtime,
        '-TunnelLogPath', $tunnelLog,
        '-TunnelTaskName', $TunnelTaskName
    )
    Invoke-RedactedPowerShellCheck -ScriptPath $localTest -Arguments $arguments -FailureMessage 'Local Ledger restart acceptance failed.'
}

function Invoke-OpenClawAcceptance {
    foreach ($arguments in @(
        @('gateway', 'status'),
        @('channels', 'status', '--probe')
    )) {
        $global:LASTEXITCODE = 0
        try {
            $discarded = @(& $OpenClawExecutable @arguments 2>&1)
        } catch {
            throw 'OpenClaw restart acceptance could not run a required redacted status probe.'
        }
        $exitCode = $LASTEXITCODE
        $discarded = $null
        if ($exitCode -ne 0) {
            throw 'OpenClaw restart acceptance failed a required redacted status probe.'
        }
    }
}

function Invoke-PublicAcceptance {
    $arguments = @(
        '-ComparePortfolioBaseline',
        '-PortfolioBaselinePath', $portfolioBaseline,
        '-TimeoutSec', [string]([Math]::Min(30, $TransitionTimeoutSec))
    )
    if (-not [string]::IsNullOrWhiteSpace($ApiTokenPath)) {
        $arguments += @('-ApiTokenPath', (Get-RestartNormalizedPath -Path $ApiTokenPath))
    }
    if (-not [string]::IsNullOrWhiteSpace($McpTokenPath)) {
        $arguments += @('-McpTokenPath', (Get-RestartNormalizedPath -Path $McpTokenPath))
    }
    Invoke-RedactedPowerShellCheck -ScriptPath $publicTest -Arguments $arguments -FailureMessage 'Public Ledger restart acceptance failed.'
}

function Test-PublicFailClosed {
    $arguments = @(
        '-ComparePortfolioBaseline',
        '-PortfolioBaselinePath', $portfolioBaseline,
        '-ExpectLedgerUnavailable',
        '-TimeoutSec', [string]([Math]::Min(30, $TransitionTimeoutSec))
    )
    try {
        Invoke-RedactedPowerShellCheck -ScriptPath $publicTest -Arguments $arguments -FailureMessage 'Public Ledger fail-closed probe failed.'
        return $true
    } catch {
        return $false
    }
}

function Assert-TaskRunning {
    param([Parameter(Mandatory = $true)]$Task)

    $refreshed = Get-ScheduledTask -TaskName $Task.TaskName -TaskPath $Task.TaskPath -ErrorAction Stop
    $info = Get-ScheduledTaskInfo -InputObject $refreshed -ErrorAction Stop
    if ([string]$refreshed.State -cne 'Running' -or [int64]$info.LastTaskResult -notin @(0, 267009)) {
        throw 'A required scheduled task is not in its recognized running state.'
    }
}

function Get-RestartLastBootUpTimeUtc {
    $systems = @(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop)
    if ($systems.Count -ne 1 -or $null -eq $systems[0].LastBootUpTime) {
        throw 'The current Windows LastBootUpTime could not be determined exactly once.'
    }
    $value = $systems[0].LastBootUpTime
    if ($value -is [DateTime]) {
        return ([DateTime]$value).ToUniversalTime()
    }
    try {
        return [Management.ManagementDateTimeConverter]::ToDateTime([string]$value).ToUniversalTime()
    } catch {
        throw 'The current Windows LastBootUpTime has an unsupported format.'
    }
}

function Write-RestartEvidenceBaseline {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (Test-Path -LiteralPath $Path) {
        throw 'The reboot evidence path already exists; refusing to overwrite evidence.'
    }
    $capturedUtc = [DateTime]::UtcNow
    $lastBootUtc = Get-RestartLastBootUpTimeUtc
    if ($lastBootUtc -gt $capturedUtc) {
        throw 'The Windows boot timestamp is later than the evidence capture time.'
    }
    $document = [ordered]@{
        schemaVersion = 1
        capturedUtc = $capturedUtc.ToString('o')
        lastBootUpTimeUtc = $lastBootUtc.ToString('o')
    }
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes(($document | ConvertTo-Json -Depth 3) + "`n")
    try {
        New-LedgerOwnerOnlyEmptyFile -Path $Path
        Write-LedgerBytesIntoExistingFile -Path $Path -Bytes $bytes
        Protect-LedgerOwnerOnlyFile -Path $Path
    } finally {
        if ($null -ne $bytes -and $bytes.Length -gt 0) {
            [Array]::Clear($bytes, 0, $bytes.Length)
        }
    }
}

function Assert-RestartOccurredSinceBaseline {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'The reboot evidence baseline was not found.'
    }
    Assert-LedgerNoExistingReparsePath -Path $Path
    Assert-LedgerOwnerOnlyFile -Path $Path
    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    try {
        $document = [IO.File]::ReadAllText($Path, $strictUtf8) | ConvertFrom-Json -ErrorAction Stop
        $propertyNames = @($document.PSObject.Properties.Name | Sort-Object)
        if ([int]$document.schemaVersion -ne 1 -or
            ($propertyNames -join ',') -cne 'capturedUtc,lastBootUpTimeUtc,schemaVersion') {
            throw 'invalid schema'
        }
        $capturedUtc = [DateTime]::ParseExact([string]$document.capturedUtc, 'o', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        $baselineBootUtc = [DateTime]::ParseExact([string]$document.lastBootUpTimeUtc, 'o', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    } catch {
        throw 'The reboot evidence baseline is not valid strict schema-v1 JSON.'
    }
    if ($baselineBootUtc -gt $capturedUtc -or $capturedUtc -gt [DateTime]::UtcNow.AddMinutes(5)) {
        throw 'The reboot evidence baseline contains impossible timestamps.'
    }
    $currentBootUtc = Get-RestartLastBootUpTimeUtc
    if ($currentBootUtc -le $baselineBootUtc -or $currentBootUtc -lt $capturedUtc) {
        throw 'A real Windows reboot after the captured baseline has not been proven.'
    }
}

if (-not $PSCmdlet.ShouldProcess(("{0}; {1}" -f $ProductionTaskName, $TunnelTaskName), 'Run exact-task restart and fail-closed acceptance')) {
    return
}

$release = Get-RestartNormalizedPath -Path $ReleasePath
$portfolioBaseline = Get-RestartNormalizedPath -Path $PortfolioBaselinePath
$common = Get-RestartNormalizedPath -Path $CommonScriptPath
$localTest = Get-RestartNormalizedPath -Path $LocalTestPath
$publicTest = Get-RestartNormalizedPath -Path $PublicTestPath
$ezbookkeeping = Get-RestartNormalizedPath -Path $EzBookkeepingExecutable
$ezbookkeepingConfig = Get-RestartNormalizedPath -Path $EzBookkeepingConfigPath
$cloudflared = Get-RestartNormalizedPath -Path $CloudflaredPath
$tunnelConfig = Get-RestartNormalizedPath -Path $TunnelConfigPath
$runtime = Get-RestartNormalizedPath -Path $TunnelRuntimeDirectory
$tunnelLog = Get-RestartNormalizedPath -Path $TunnelLogPath

foreach ($requiredFile in @($common, $localTest, $publicTest, $ezbookkeeping, $ezbookkeepingConfig, $cloudflared, $tunnelConfig, $portfolioBaseline)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw 'A required restart-acceptance file is missing.'
    }
}

. $common

$rebootEvidence = $null
if ($Phase -ne 'ServiceCycle') {
    if ([string]::IsNullOrWhiteSpace($RebootEvidencePath)) {
        throw 'RebootEvidencePath is required for the selected reboot acceptance phase.'
    }
    $rebootEvidence = Assert-LedgerExternalSecretPath -Path $RebootEvidencePath -Description 'The reboot evidence path'
}

$productionTask = Get-ExactProductionTask
$tunnelTask = Get-ExactTunnelTask `
    -Name $TunnelTaskName `
    -Runtime $runtime `
    -Cloudflared $cloudflared `
    -CloudflaredSha256 $ExpectedCloudflaredSha256 `
    -TunnelConfig $tunnelConfig `
    -EzBookkeeping $ezbookkeeping `
    -EzBookkeepingConfig $ezbookkeepingConfig `
    -SupervisorLog $tunnelLog

Assert-TaskRunning -Task $productionTask
Assert-TaskRunning -Task $tunnelTask
$null = Get-LedgerListenerOwner -Port 8888 -ExpectedExecutable $ezbookkeeping -ExpectedConfigPath $ezbookkeepingConfig
$null = Get-ExpectedCloudflaredChild -Cloudflared $cloudflared -TunnelConfig $tunnelConfig
Invoke-LocalAcceptance
Invoke-PublicAcceptance
Invoke-OpenClawAcceptance

if ($Phase -eq 'CapturePreReboot') {
    Write-RestartEvidenceBaseline -Path $rebootEvidence
    Write-Output 'LEDGER_REBOOT_BASELINE_CAPTURED'
    return
}
if ($Phase -eq 'VerifyPostReboot') {
    Assert-RestartOccurredSinceBaseline -Path $rebootEvidence
    Write-Output 'LEDGER_REBOOT_ACCEPTANCE_OK'
    return
}

$productionStopped = $false
$tunnelStopped = $false
$wrongOwnerListener = $null
$acceptanceFailure = $null
$stateMutated = $false

try {
    # Cycle the exact Tunnel task and validate recovery independently of the real reboot phase.
    $tunnelTask = Get-ExactTunnelTask -Name $TunnelTaskName -Runtime $runtime -Cloudflared $cloudflared -CloudflaredSha256 $ExpectedCloudflaredSha256 -TunnelConfig $tunnelConfig -EzBookkeeping $ezbookkeeping -EzBookkeepingConfig $ezbookkeepingConfig -SupervisorLog $tunnelLog
    Stop-ScheduledTask -InputObject $tunnelTask -ErrorAction Stop
    $tunnelStopped = $true
    $stateMutated = $true
    Wait-Until -FailureMessage 'The recognized Tunnel child did not stop with its exact task.' -Condition {
        $child = Get-ExpectedCloudflaredChild -Cloudflared $cloudflared -TunnelConfig $tunnelConfig -AllowAbsent
        return $null -eq $child
    }
    $tunnelTask = Get-ExactTunnelTask -Name $TunnelTaskName -Runtime $runtime -Cloudflared $cloudflared -CloudflaredSha256 $ExpectedCloudflaredSha256 -TunnelConfig $tunnelConfig -EzBookkeeping $ezbookkeeping -EzBookkeepingConfig $ezbookkeepingConfig -SupervisorLog $tunnelLog
    Assert-TunnelChildAbsentBeforeStart
    Start-ScheduledTask -InputObject $tunnelTask -ErrorAction Stop
    $tunnelStopped = $false
    Wait-Until -FailureMessage 'The exact Tunnel task did not recover after restart.' -Condition {
        $null -ne (Get-ExpectedCloudflaredChild -Cloudflared $cloudflared -TunnelConfig $tunnelConfig -AllowAbsent)
    }
    Invoke-LocalAcceptance
    Invoke-PublicAcceptance
    Invoke-OpenClawAcceptance

    # Origin stop must make the public path fail closed without stopping any unknown process.
    $productionTask = Get-ExactProductionTask
    $null = Get-LedgerListenerOwner -Port 8888 -ExpectedExecutable $ezbookkeeping -ExpectedConfigPath $ezbookkeepingConfig
    Stop-ScheduledTask -InputObject $productionTask -ErrorAction Stop
    $productionStopped = $true
    $stateMutated = $true
    Wait-Until -FailureMessage 'The exact production task stopped but its listener remained.' -Condition {
        return @(Get-LedgerListeningTcpConnections -Port 8888).Count -eq 0
    }
    Wait-Until -FailureMessage 'The Ledger Tunnel did not fail closed after origin loss.' -Condition {
        $child = Get-ExpectedCloudflaredChild -Cloudflared $cloudflared -TunnelConfig $tunnelConfig -AllowAbsent
        return $null -eq $child
    }
    Wait-Until -FailureMessage 'The public Ledger remained available after the origin stopped.' -Condition { Test-PublicFailClosed }

    # A known in-process wrong owner on 8888 must never cause Tunnel publication.
    $wrongOwnerListener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 8888)
    $wrongOwnerListener.Start()
    Start-Sleep -Seconds ([Math]::Min(10, [Math]::Max(2, $PollSeconds * 3)))
    if ($null -ne (Get-ExpectedCloudflaredChild -Cloudflared $cloudflared -TunnelConfig $tunnelConfig -AllowAbsent)) {
        throw 'The Ledger Tunnel violated fail-closed behavior for a wrong origin owner.'
    }
    $wrongOwnerListener.Stop()
    $wrongOwnerListener = $null

    $productionTask = Get-ExactProductionTask
    Assert-ProductionPortClearBeforeStart
    Start-ScheduledTask -InputObject $productionTask -ErrorAction Stop
    $productionStopped = $false
    Wait-Until -FailureMessage 'The exact production origin did not recover.' -Condition {
        $null = Get-LedgerListenerOwner -Port 8888 -ExpectedExecutable $ezbookkeeping -ExpectedConfigPath $ezbookkeepingConfig
        return (Test-LedgerOrigin -Port 8888)
    }
    Wait-Until -FailureMessage 'The Ledger Tunnel did not recover after full origin validation.' -Condition {
        $null -ne (Get-ExpectedCloudflaredChild -Cloudflared $cloudflared -TunnelConfig $tunnelConfig -AllowAbsent)
    }

    Invoke-LocalAcceptance
    Invoke-PublicAcceptance
    Invoke-OpenClawAcceptance
} catch {
    $acceptanceFailure = 'Ledger restart and fail-closed acceptance failed.'
} finally {
    if ($null -ne $wrongOwnerListener) {
        $wrongOwnerListener.Stop()
        $wrongOwnerListener = $null
    }
    if ($productionStopped) {
        try {
            $productionTask = Get-ExactProductionTask
            if ([string]$productionTask.State -cne 'Running') {
                Assert-ProductionPortClearBeforeStart
                Start-ScheduledTask -InputObject $productionTask -ErrorAction Stop
            }
            $productionStopped = $false
        } catch {
            $acceptanceFailure = 'RECOVERY_INCOMPLETE: production task recovery could not be verified without adopting an existing listener.'
        }
    }
    if ($tunnelStopped) {
        try {
            $tunnelTask = Get-ExactTunnelTask -Name $TunnelTaskName -Runtime $runtime -Cloudflared $cloudflared -CloudflaredSha256 $ExpectedCloudflaredSha256 -TunnelConfig $tunnelConfig -EzBookkeeping $ezbookkeeping -EzBookkeepingConfig $ezbookkeepingConfig -SupervisorLog $tunnelLog
            if ([string]$tunnelTask.State -cne 'Running') {
                Assert-TunnelChildAbsentBeforeStart
                Start-ScheduledTask -InputObject $tunnelTask -ErrorAction Stop
            }
            $tunnelStopped = $false
        } catch {
            $acceptanceFailure = 'RECOVERY_INCOMPLETE: Tunnel task recovery could not be verified without adopting an existing process.'
        }
    }
    if ($stateMutated) {
        try {
            $productionTask = Get-ExactProductionTask
            if ([string]$productionTask.State -cne 'Running') {
                Assert-ProductionPortClearBeforeStart
                Start-ScheduledTask -InputObject $productionTask -ErrorAction Stop
            }
            Wait-Until -FailureMessage 'The production origin could not be restored after restart acceptance.' -Condition {
                $null = Get-LedgerListenerOwner -Port 8888 -ExpectedExecutable $ezbookkeeping -ExpectedConfigPath $ezbookkeepingConfig
                return (Test-LedgerOrigin -Port 8888)
            }

            $tunnelTask = Get-ExactTunnelTask -Name $TunnelTaskName -Runtime $runtime -Cloudflared $cloudflared -CloudflaredSha256 $ExpectedCloudflaredSha256 -TunnelConfig $tunnelConfig -EzBookkeeping $ezbookkeeping -EzBookkeepingConfig $ezbookkeepingConfig -SupervisorLog $tunnelLog
            if ([string]$tunnelTask.State -cne 'Running') {
                Assert-TunnelChildAbsentBeforeStart
                Start-ScheduledTask -InputObject $tunnelTask -ErrorAction Stop
            }
            Wait-Until -FailureMessage 'The Tunnel child could not be restored after restart acceptance.' -Condition {
                $null -ne (Get-ExpectedCloudflaredChild -Cloudflared $cloudflared -TunnelConfig $tunnelConfig -AllowAbsent)
            }
            $productionTask = Get-ExactProductionTask
            $tunnelTask = Get-ExactTunnelTask -Name $TunnelTaskName -Runtime $runtime -Cloudflared $cloudflared -CloudflaredSha256 $ExpectedCloudflaredSha256 -TunnelConfig $tunnelConfig -EzBookkeeping $ezbookkeeping -EzBookkeepingConfig $ezbookkeepingConfig -SupervisorLog $tunnelLog
            Assert-TaskRunning -Task $productionTask
            Assert-TaskRunning -Task $tunnelTask
            Invoke-LocalAcceptance
            Invoke-PublicAcceptance
            Invoke-OpenClawAcceptance
        } catch {
            $acceptanceFailure = 'RECOVERY_INCOMPLETE: restart acceptance changed runtime state and final recovery could not be verified.'
        }
    }
}

if ($null -ne $acceptanceFailure) { throw $acceptanceFailure }
Write-Output 'LEDGER_RESTART_ACCEPTANCE_OK'
