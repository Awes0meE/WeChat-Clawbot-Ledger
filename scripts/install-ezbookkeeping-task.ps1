[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$InstallDirectory = 'D:\Clawbot\ezbookkeeping',
    [string]$TaskName = 'Clawbot ezBookkeeping'
)

Set-StrictMode -Version Latest

$resolvedInstallDirectory = [IO.Path]::GetFullPath($InstallDirectory)
$executable = [IO.Path]::GetFullPath((Join-Path $resolvedInstallDirectory 'ezbookkeeping.exe'))
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw 'The expected ezBookkeeping executable was not found.'
}

if (-not $PSCmdlet.ShouldProcess($TaskName, 'Register persistent ezBookkeeping task')) {
    return
}

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $executable -Argument 'server run' -WorkingDirectory $resolvedInstallDirectory
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

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
