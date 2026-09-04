[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ConfigPath = 'D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini',
    [string]$InstallDirectory = 'D:\Clawbot\ezbookkeeping',
    [string]$ApiTokenPath = "$env:USERPROFILE\.openclaw\secrets\ezbookkeeping-token.txt",
    [string]$McpTokenPath = "$env:USERPROFILE\.openclaw\secrets\ezbookkeeping-mcp-token.txt",
    [string]$OpenClawConfigPath = "$env:USERPROFILE\.openclaw\openclaw.json",
    [string]$BackupRoot = 'D:\Clawbot\backups',
    [string]$TaskName = 'Clawbot ezBookkeeping',
    [ValidateRange(60, 315360000)]
    [int]$ExpiresInSeconds = 31536000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'ledger-runtime-common.ps1')

$ConfigPath = Assert-LedgerExternalSecretPath -Path $ConfigPath -Description 'The ezBookkeeping configuration path'
$ApiTokenPath = Assert-LedgerExternalSecretPath -Path $ApiTokenPath -Description 'The ezBookkeeping API token path'
$McpTokenPath = Assert-LedgerExternalSecretPath -Path $McpTokenPath -Description 'The ezBookkeeping MCP token path'
$OpenClawConfigPath = Assert-LedgerExternalSecretPath -Path $OpenClawConfigPath -Description 'The OpenClaw configuration path'
$BackupRoot = Assert-LedgerExternalSecretPath -Path $BackupRoot -Description 'The protected ledger backup root'
if (Test-LedgerSamePath -Left $ApiTokenPath -Right $McpTokenPath) {
    throw 'The API and MCP token paths must be different.'
}

function Get-UpdatedMcpConfiguration {
    param([Parameter(Mandatory = $true)][string]$Text)

    $lines = [regex]::Split($Text, "`r`n|`n|`r")
    $lineEnding = if ($Text.Contains("`r`n")) { "`r`n" } elseif ($Text.Contains("`n")) { "`n" } elseif ($Text.Contains("`r")) { "`r" } else { [Environment]::NewLine }
    $hasFinalLineEnding = $Text.EndsWith("`r`n") -or $Text.EndsWith("`n") -or $Text.EndsWith("`r")
    $currentSection = ''
    $settingIndexes = @{}

    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match '^\s*\[\s*([^\]]+)\s*\]\s*(?:[;#].*)?$') {
            $currentSection = $matches[1].Trim()
            continue
        }

        if ($lines[$index] -match '^\s*(enable_mcp|mcp_allowed_remote_ips)\s*=') {
            if ($currentSection -ine 'mcp') {
                throw 'The ezBookkeeping MCP settings are ambiguous or outside the [mcp] section.'
            }
            $key = $matches[1].ToLowerInvariant()
            if ($settingIndexes.ContainsKey($key)) {
                throw 'The ezBookkeeping MCP settings are duplicated or ambiguous.'
            }
            $settingIndexes[$key] = $index
        }
    }

    foreach ($key in @('enable_mcp', 'mcp_allowed_remote_ips')) {
        if (-not $settingIndexes.ContainsKey($key)) {
            throw 'Could not locate both ezBookkeeping MCP settings in the [mcp] section.'
        }
    }

    $lines[$settingIndexes['enable_mcp']] = 'enable_mcp = true'
    $lines[$settingIndexes['mcp_allowed_remote_ips']] = 'mcp_allowed_remote_ips = 127.0.0.1'
    $updated = [string]::Join($lineEnding, [string[]]$lines)
    if ($hasFinalLineEnding -and -not $updated.EndsWith($lineEnding)) {
        $updated += $lineEnding
    }
    return $updated
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw 'The ezBookkeeping configuration file was not found.'
}

if (-not $PSCmdlet.ShouldProcess($ConfigPath, 'Enable MCP, restart ezBookkeeping, and create a protected token')) {
    return
}

function Copy-ConfigToUniqueBackup {
    param(
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [Parameter(Mandatory = $true)][string]$ExpectedSourceHash
    )

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    if ((Get-LedgerFileSha256 -Path $ConfigPath) -cne $ExpectedSourceHash) {
        throw 'The ezBookkeeping configuration changed before its backup was created.'
    }
    for ($suffix = 0; $suffix -lt 100; $suffix++) {
        $backupPath = if ($suffix -eq 0) { "$ConfigPath.before-mcp-$stamp" } else { "$ConfigPath.before-mcp-$stamp-$suffix" }
        $backupCreated = $false
        try {
            New-LedgerOwnerOnlyEmptyFile -Path $backupPath
            $backupCreated = $true
            Copy-LedgerFileBytesIntoExistingFile -SourcePath $ConfigPath -DestinationPath $backupPath
            Assert-LedgerOwnerOnlyFile -Path $backupPath
            if ((Get-LedgerFileSha256 -Path $ConfigPath) -cne $ExpectedSourceHash -or
                (Get-LedgerFileSha256 -Path $backupPath) -cne $ExpectedSourceHash) {
                Remove-LedgerOwnedFileIfPresent -Path $backupPath
                throw 'The ezBookkeeping configuration backup did not pass hash verification.'
            }
            return $backupPath
        } catch [System.IO.IOException] {
            if (-not $backupCreated -and [IO.File]::Exists($backupPath)) {
                continue
            }
            if ($backupCreated) { Remove-LedgerOwnedFileIfPresent -Path $backupPath }
            throw
        } catch {
            if ($backupCreated) { Remove-LedgerOwnedFileIfPresent -Path $backupPath }
            throw
        }
    }
    throw 'Could not create a unique ezBookkeeping configuration backup.'
}

function Write-ConfigAtomically {
    param(
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][System.Text.Encoding]$Encoding
    )

    Write-LedgerTextAtomically -Path $ConfigPath -Text $Text
    Assert-LedgerOwnerOnlyFile -Path $ConfigPath
}

function Assert-McpTokenDestination {
    param(
        [Parameter(Mandatory = $true)][string]$TokenPath,
        [Parameter(Mandatory = $true)][string]$ConfigurationPath,
        [Parameter(Mandatory = $true)][string]$ProductionTokenPath,
        [Parameter(Mandatory = $true)][string]$OpenClawPath,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$ProtectedBackupRoot
    )

    $document = Get-LedgerIniDocument -Path $ConfigurationPath
    $tokenDestinations = @($TokenPath, $ProductionTokenPath)
    foreach ($tokenDestination in $tokenDestinations) {
        if (Test-LedgerPathInside -Candidate $tokenDestination -Root $InstallRoot) {
            throw 'Bookkeeping token destinations must be outside the ezBookkeeping install tree.'
        }
    }
    $staticRootEntry = $document.Values['server.static_root_path']
    if ($null -ne $staticRootEntry -and -not [string]::IsNullOrWhiteSpace([string]$staticRootEntry)) {
        $staticRoot = Resolve-LedgerDataPath -InstallDirectory $InstallRoot -ConfiguredPath ([string]$staticRootEntry)
        foreach ($tokenDestination in $tokenDestinations) {
            if (Test-LedgerPathInside -Candidate $tokenDestination -Root $staticRoot) {
                throw 'Bookkeeping token destinations must be outside the configured static content root.'
            }
        }
    }
    $protectedPaths = New-Object 'System.Collections.Generic.List[string]'
    foreach ($path in @($ConfigurationPath, $ProductionTokenPath, $OpenClawPath)) {
        $protectedPaths.Add((Get-LedgerNormalizedPath -Path $path))
    }
    $databaseEntry = $document.Values['database.db_path']
    $databasePath = if ($null -ne $databaseEntry -and -not [string]::IsNullOrWhiteSpace([string]$databaseEntry)) {
        Resolve-LedgerDataPath -InstallDirectory $InstallRoot -ConfiguredPath ([string]$databaseEntry)
    } else {
        Get-LedgerNormalizedPath -Path (Join-Path $InstallRoot 'data\ezbookkeeping.db')
    }
    $protectedPaths.Add($databasePath)

    $configurationDirectory = Split-Path -Parent $ConfigurationPath
    $configurationLeaf = Split-Path -Leaf $ConfigurationPath
    foreach ($backup in @(Get-ChildItem -LiteralPath $configurationDirectory -Filter ($configurationLeaf + '.before-mcp-*') -Force -File -ErrorAction Stop)) {
        $protectedPaths.Add((Get-LedgerNormalizedPath -Path $backup.FullName))
    }
    if (Test-Path -LiteralPath $ProtectedBackupRoot -PathType Container) {
        Assert-LedgerNoExistingReparsePath -Path $ProtectedBackupRoot
        foreach ($backup in @(Get-ChildItem -LiteralPath $ProtectedBackupRoot -Recurse -Force -File -ErrorAction Stop)) {
            $protectedPaths.Add((Get-LedgerNormalizedPath -Path $backup.FullName))
        }
    }

    foreach ($protectedPath in @($protectedPaths | Select-Object -Unique)) {
        if (Test-LedgerSameFile -Left $TokenPath -Right $protectedPath) {
            throw 'The MCP token destination aliases a protected production file.'
        }
    }
}

function Set-OwnerOnlyTokenFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Token,
        [Parameter(Mandatory = $true)][System.Text.Encoding]$Encoding
    )

    $Path = Assert-LedgerExternalSecretPath -Path $Path -Description 'The MCP token path'
    $directory = Split-Path -Parent $Path
    if ([string]::IsNullOrWhiteSpace($directory)) {
        throw 'The MCP token path must include a directory.'
    }
    Assert-LedgerNoExistingReparsePath -Path $Path
    New-Item -ItemType Directory -Path $directory -Force -ErrorAction Stop | Out-Null
    Assert-LedgerNoExistingReparsePath -Path $Path
    $tokenFileCreated = $false
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        New-LedgerOwnerOnlyEmptyFile -Path $Path
        $tokenFileCreated = $true
    } else {
        Protect-LedgerOwnerOnlyFile -Path $Path
    }
    try {
        Write-LedgerTextAtomically -Path $Path -Text $Token
        Protect-LedgerOwnerOnlyFile -Path $Path
        Assert-LedgerOwnerOnlyFile -Path $Path
    } catch {
        if ($tokenFileCreated) { Remove-LedgerOwnedFileIfPresent -Path $Path }
        throw
    }
}

function Restore-ConfigurationAndService {
    param(
        [Parameter(Mandatory = $true)][string]$BackupPath,
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [Parameter(Mandatory = $true)][object]$Task,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
        [Parameter(Mandatory = $true)][string]$ExpectedInstallDirectory,
        [Parameter(Mandatory = $true)][string]$ExpectedConfigPath,
        [bool]$TaskWasRunning,
        [bool]$TaskStopped,
        [bool]$TaskStarted
    )

    if ($TaskStarted) {
        $verifiedTask = Get-LedgerExpectedTask -TaskName $Task.TaskName -InstallDirectory $ExpectedInstallDirectory -ExpectedExecutable $ExpectedExecutable -ConfigPath $ExpectedConfigPath -Mode Explicit
        if ([string]$verifiedTask.State -cne 'Running') {
            throw 'The restarted ezBookkeeping task is not running during rollback.'
        }
        $rollbackIdentity = $null
        if (@(Get-LedgerListeningTcpConnections -Port 8888).Count -gt 0) {
            $rollbackIdentity = Get-LedgerListenerOwner -Port 8888 -ExpectedExecutable $ExpectedExecutable -ExpectedConfigPath $ExpectedConfigPath
        }
        Stop-ScheduledTask -InputObject $verifiedTask -ErrorAction Stop
        Wait-LedgerListenerExit -Identity $rollbackIdentity -Port 8888 -ExpectedExecutable $ExpectedExecutable -ExpectedConfigPath $ExpectedConfigPath
    }
    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $backupText = [IO.File]::ReadAllText($BackupPath, $strictUtf8)
    Write-LedgerTextAtomically -Path $ConfigPath -Text $backupText
    Assert-LedgerOwnerOnlyFile -Path $ConfigPath
    if ($TaskWasRunning -and $TaskStopped) {
        Start-ScheduledTask -InputObject $Task -ErrorAction Stop
    }
}

$passwordPointer = [IntPtr]::Zero
$securePassword = $null
$plainPassword = $null
$apiToken = $null
$mcpToken = $null
$headers = $null
$body = $null
$backupPath = $null
$task = $null
$expectedExecutable = $null
$normalizedInstallDirectory = $null
$taskWasRunning = $false
$taskStopped = $false
$taskStarted = $false
$configWritten = $false
$strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$configurationSettingNames = @(
    'SERVER_PROTOCOL', 'SERVER_HTTP_ADDR', 'SERVER_HTTP_PORT', 'SERVER_DOMAIN', 'SERVER_ROOT_URL',
    'MCP_ENABLE_MCP', 'MCP_MCP_ALLOWED_REMOTE_IPS',
    'SECURITY_TRUSTED_PROXY_IPS', 'SECURITY_ENABLE_API_TOKEN', 'SECURITY_API_TOKEN_ALLOWED_REMOTE_IPS',
    'SECURITY_MAX_FAILURES_PER_IP_PER_MINUTE', 'SECURITY_MAX_FAILURES_PER_USER_PER_MINUTE',
    'AUTH_ENABLE_FORGET_PASSWORD', 'USER_ENABLE_REGISTER'
)

try {
    $normalizedInstallDirectory = Get-LedgerNormalizedPath -Path $InstallDirectory
    $ConfigPath = Get-LedgerNormalizedPath -Path $ConfigPath
    $expectedExecutable = Get-LedgerNormalizedPath -Path (Join-Path $normalizedInstallDirectory 'ezbookkeeping.exe')
    if (-not (Test-Path -LiteralPath $expectedExecutable -PathType Leaf)) {
        throw 'The expected ezBookkeeping executable was not found.'
    }
    if (-not $ConfigPath.StartsWith($normalizedInstallDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The ezBookkeeping configuration is outside the installation directory.'
    }
    Assert-LedgerNoConfigurationOverrides -SettingNames $configurationSettingNames
    $approvedConfigHash = Get-LedgerFileSha256 -Path $ConfigPath
    $configText = [IO.File]::ReadAllText($ConfigPath, $strictUtf8)
    if ((Get-LedgerFileSha256 -Path $ConfigPath) -cne $approvedConfigHash) {
        throw 'The ezBookkeeping configuration changed while it was read.'
    }
    $updatedConfig = Get-UpdatedMcpConfiguration -Text $configText
    Assert-McpTokenDestination -TokenPath $McpTokenPath -ConfigurationPath $ConfigPath -ProductionTokenPath $ApiTokenPath -OpenClawPath $OpenClawConfigPath -InstallRoot $normalizedInstallDirectory -ProtectedBackupRoot $BackupRoot
    if ((Get-LedgerFileSha256 -Path $ConfigPath) -cne $approvedConfigHash) {
        throw 'The ezBookkeeping configuration changed during MCP preflight.'
    }
    $task = Get-LedgerExpectedTask -TaskName $TaskName -InstallDirectory $normalizedInstallDirectory -ExpectedExecutable $expectedExecutable -ConfigPath $ConfigPath -Mode Explicit
    $taskWasRunning = [string]$task.State -ceq 'Running'
    if (-not $taskWasRunning) {
        throw 'The exact ezBookkeeping scheduled task is not running.'
    }
    $listenerIdentity = Get-LedgerListenerOwner -Port 8888 -ExpectedExecutable $expectedExecutable -ExpectedConfigPath $ConfigPath
    if (-not (Test-LedgerOrigin -Port 8888)) {
        throw 'The local ezBookkeeping service did not pass its preflight checks.'
    }

    Assert-LedgerNoConfigurationOverrides -SettingNames $configurationSettingNames
    if ((Get-LedgerFileSha256 -Path $ConfigPath) -cne $approvedConfigHash) {
        throw 'The ezBookkeeping configuration changed after MCP preflight.'
    }
    Protect-LedgerOwnerOnlyFile -Path $ConfigPath
    Assert-LedgerOwnerOnlyFile -Path $ConfigPath
    $backupPath = Copy-ConfigToUniqueBackup -ConfigPath $ConfigPath -ExpectedSourceHash $approvedConfigHash
    $backupText = [IO.File]::ReadAllText($backupPath, $strictUtf8)
    $updatedConfig = Get-UpdatedMcpConfiguration -Text $backupText
    if ((Get-LedgerFileSha256 -Path $ConfigPath) -cne $approvedConfigHash -or
        (Get-LedgerFileSha256 -Path $backupPath) -cne $approvedConfigHash) {
        throw 'The ezBookkeeping configuration changed before the MCP update.'
    }
    $configWritten = $true
    Write-ConfigAtomically -ConfigPath $ConfigPath -Text $updatedConfig -Encoding $utf8NoBom
    $task = Get-LedgerExpectedTask -TaskName $TaskName -InstallDirectory $normalizedInstallDirectory -ExpectedExecutable $expectedExecutable -ConfigPath $ConfigPath -Mode Explicit
    if ([string]$task.State -cne 'Running') {
        throw 'The exact ezBookkeeping scheduled task stopped before controlled restart.'
    }
    $finalListenerIdentity = Get-LedgerListenerOwner -Port 8888 -ExpectedExecutable $expectedExecutable -ExpectedConfigPath $ConfigPath
    if ([int]$finalListenerIdentity.ProcessId -ne [int]$listenerIdentity.ProcessId -or
        [string]$finalListenerIdentity.CreationDate -cne [string]$listenerIdentity.CreationDate) {
        throw 'The ezBookkeeping listener identity changed before controlled restart.'
    }
    Assert-LedgerNoConfigurationOverrides -SettingNames $configurationSettingNames
    Stop-ScheduledTask -InputObject $task -ErrorAction Stop
    $taskStopped = $true
    Wait-LedgerListenerExit -Identity $listenerIdentity -Port 8888 -ExpectedExecutable $expectedExecutable -ExpectedConfigPath $ConfigPath
    Start-ScheduledTask -InputObject $task -ErrorAction Stop
    $taskStarted = $true

    $healthy = $false
    $healthDeadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $healthDeadline) {
        try {
            $null = Get-LedgerListenerOwner -Port 8888 -ExpectedExecutable $expectedExecutable -ExpectedConfigPath $ConfigPath
            if (Test-LedgerOrigin -Port 8888) {
                $healthy = $true
                break
            }
        } catch {
            # Retry until the bounded health window expires.
        }
        if ((Get-Date) -lt $healthDeadline) {
            Start-Sleep -Seconds 1
        }
    }
    if (-not $healthy) {
        throw 'ezBookkeeping did not become healthy after restart.'
    }

    $securePassword = Read-Host 'ezBookkeeping password' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    if (-not (Test-Path -LiteralPath $ApiTokenPath -PathType Leaf)) {
        throw 'The local ezBookkeeping API token was not found.'
    }
    Protect-LedgerOwnerOnlyFile -Path $ApiTokenPath
    Assert-LedgerOwnerOnlyFile -Path $ApiTokenPath
    $apiToken = [IO.File]::ReadAllText($ApiTokenPath, $strictUtf8).Trim()
    if ([string]::IsNullOrWhiteSpace($apiToken)) {
        throw 'The local ezBookkeeping API token is empty.'
    }
    $headers = @{ Authorization = "Bearer $apiToken" }
    $body = @{ expiresInSeconds = $ExpiresInSeconds; password = $plainPassword } | ConvertTo-Json -Compress
    $response = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8888/api/v1/tokens/generate/mcp.json' -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body -MaximumRedirection 0 -TimeoutSec 15 -ErrorAction Stop
    $mcpToken = ([string]$response.result.token).Trim()
    if ($response.success -ne $true -or [string]::IsNullOrWhiteSpace($mcpToken) -or $mcpToken -match '[\r\n]') {
        throw 'ezBookkeeping did not return an MCP token.'
    }
    Set-OwnerOnlyTokenFile -Path $McpTokenPath -Token $mcpToken -Encoding $utf8NoBom
    Write-Host 'MCP enabled and token stored securely.'
} catch {
    $rollbackSucceeded = $true
    if ($configWritten) {
        $configurationNeedsRestore = $true
        try {
            Assert-LedgerOwnerOnlyFile -Path $backupPath
            if (-not $taskStopped -and -not $taskStarted -and
                (Get-LedgerFileSha256 -Path $ConfigPath) -ceq (Get-LedgerFileSha256 -Path $backupPath)) {
                Assert-LedgerOwnerOnlyFile -Path $ConfigPath
                $configurationNeedsRestore = $false
            }
        } catch {
            $configurationNeedsRestore = $true
        }
        if ($configurationNeedsRestore) {
            try {
                Restore-ConfigurationAndService -BackupPath $backupPath -ConfigPath $ConfigPath -Task $task -ExpectedExecutable $expectedExecutable -ExpectedInstallDirectory $normalizedInstallDirectory -ExpectedConfigPath $ConfigPath -TaskWasRunning $taskWasRunning -TaskStopped $taskStopped -TaskStarted $taskStarted
            } catch {
                $rollbackSucceeded = $false
            }
        }
    }
    if (-not $rollbackSucceeded) {
        throw ("Local ezBookkeeping MCP setup failed and automatic rollback could not be completed. Restore the configuration backup at '{0}' and service state before retrying." -f $backupPath)
    }
    throw 'Could not complete local ezBookkeeping MCP setup. Check the configuration, task, and service health, then retry.'
} finally {
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    $body = $null
    $headers = $null
    $mcpToken = $null
    $apiToken = $null
    $plainPassword = $null
    $securePassword = $null
}
