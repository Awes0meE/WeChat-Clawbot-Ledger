[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$InstallDirectory = 'D:\Clawbot\ezbookkeeping',
    [string]$ConfigPath,
    [string]$TaskName = 'Clawbot ezBookkeeping'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'ledger-runtime-common.ps1')

$resolvedInstallDirectory = Get-LedgerNormalizedPath -Path $InstallDirectory
$resolvedConfigPath = if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    Get-LedgerNormalizedPath -Path (Join-Path $resolvedInstallDirectory 'conf\ezbookkeeping.ini')
} else {
    Get-LedgerNormalizedPath -Path $ConfigPath
}
$executable = Get-LedgerNormalizedPath -Path (Join-Path $resolvedInstallDirectory 'ezbookkeeping.exe')

if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw 'The expected ezBookkeeping executable was not found.'
}
if (-not (Test-Path -LiteralPath $resolvedConfigPath -PathType Leaf)) {
    throw 'The expected ezBookkeeping configuration file was not found.'
}
if (-not $resolvedConfigPath.StartsWith($resolvedInstallDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The ezBookkeeping configuration must be inside the installation directory.'
}

$matchingTasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
    $null -ne $_ -and
    $null -ne $_.PSObject.Properties['TaskName'] -and
    $null -ne $_.PSObject.Properties['TaskPath'] -and
    $_.TaskName -eq $TaskName -and $_.TaskPath -eq '\'
})
if ($matchingTasks.Count -gt 1) {
    throw 'The root ezBookkeeping scheduled task is ambiguous.'
}
if ($matchingTasks.Count -eq 1) {
    $null = Get-LedgerExpectedTask `
        -TaskName $TaskName `
        -InstallDirectory $resolvedInstallDirectory `
        -ExpectedExecutable $executable `
        -ConfigPath $resolvedConfigPath `
        -Mode Explicit
    [pscustomobject]@{ Status = 'already_configured' }
    return
}

if (-not $PSCmdlet.ShouldProcess($TaskName, 'Register persistent ezBookkeeping task with an explicit configuration')) {
    return
}

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction `
    -Execute $executable `
    -Argument (Get-LedgerExplicitServiceArguments -ConfigPath $resolvedConfigPath) `
    -WorkingDirectory $resolvedInstallDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Loopback-only ezBookkeeping service with an explicit configuration' `
    -ErrorAction Stop | Out-Null

[pscustomobject]@{ Status = 'registered' }
