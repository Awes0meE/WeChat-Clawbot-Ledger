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
$systemRoot = [Environment]::GetEnvironmentVariable('SystemRoot')
if ([string]::IsNullOrWhiteSpace($systemRoot)) {
    throw 'Could not locate the Windows PowerShell executable.'
}
$powershellExecutable = [IO.Path]::GetFullPath((Join-Path $systemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'))
if (-not (Test-Path -LiteralPath $powershellExecutable -PathType Leaf)) {
    throw 'Could not locate the Windows PowerShell executable.'
}
$escapedExecutable = $executable.Replace("'", "''")
$serviceCommand = '& ' + [char]39 + $escapedExecutable + [char]39 + ' server run'
$serviceArguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "' + $serviceCommand + '"'

if (-not $PSCmdlet.ShouldProcess($TaskName, 'Register persistent ezBookkeeping task')) {
    return
}

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $powershellExecutable -Argument $serviceArguments -WorkingDirectory $resolvedInstallDirectory
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
