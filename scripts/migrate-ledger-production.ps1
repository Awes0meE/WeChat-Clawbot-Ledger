[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$InstallDirectory = 'D:\Clawbot\ezbookkeeping',
    [string]$TaskName = 'Clawbot ezBookkeeping',
    [string]$BackupRoot = 'D:\Clawbot\backups\ledger-production',
    [string]$OpenClawConfigPath = "$env:USERPROFILE\.openclaw\openclaw.json",
    [string]$NodeExecutablePath = 'node.exe',
    [string]$SqliteVerifierPath,
    [ValidateRange(1, 240)][int]$StartupCheckAttempts = 60,
    [ValidateRange(1, 5000)][int]$StartupCheckIntervalMilliseconds = 250
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'ledger-runtime-common.ps1')

if ([string]::IsNullOrWhiteSpace($SqliteVerifierPath)) {
    $SqliteVerifierPath = Join-Path $PSScriptRoot 'verify-ledger-sqlite.mjs'
}

$migratedSettingNames = @(
    'UUID_GENERATOR_TYPE',
    'UUID_SERVER_ID',
    'DUPLICATE_CHECKER_CHECKER_TYPE',
    'DUPLICATE_CHECKER_CLEANUP_INTERVAL',
    'DUPLICATE_CHECKER_DUPLICATE_SUBMISSIONS_INTERVAL',
    'SERVER_PROTOCOL',
    'SERVER_HTTP_ADDR',
    'SERVER_HTTP_PORT',
    'SERVER_DOMAIN',
    'SERVER_ROOT_URL',
    'MCP_ENABLE_MCP',
    'MCP_MCP_ALLOWED_REMOTE_IPS',
    'DATABASE_TYPE',
    'DATABASE_DB_PATH',
    'SECURITY_TRUSTED_PROXY_IPS',
    'SECURITY_TOKEN_EXPIRED_TIME',
    'SECURITY_TOKEN_MIN_REFRESH_INTERVAL',
    'SECURITY_ENABLE_API_TOKEN',
    'SECURITY_API_TOKEN_ALLOWED_REMOTE_IPS',
    'SECURITY_MAX_FAILURES_PER_IP_PER_MINUTE',
    'SECURITY_MAX_FAILURES_PER_USER_PER_MINUTE',
    'AUTH_ENABLE_INTERNAL_AUTH',
    'AUTH_ENABLE_OAUTH2_AUTH',
    'AUTH_ENABLE_TWO_FACTOR',
    'AUTH_ENABLE_FORGET_PASSWORD',
    'AUTH_OAUTH2_USER_IDENTIFIER',
    'USER_ENABLE_REGISTER',
    'MAP_AMAP_SECURITY_VERIFICATION_METHOD',
    'EXCHANGE_RATES_DATA_SOURCE'
)

$install = Get-LedgerNormalizedPath -Path $InstallDirectory
$configPath = Get-LedgerNormalizedPath -Path (Join-Path $install 'conf\ezbookkeeping.ini')
$executablePath = Get-LedgerNormalizedPath -Path (Join-Path $install 'ezbookkeeping.exe')
$backupBase = Assert-LedgerBackupRoot -BackupRoot $BackupRoot

if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    throw 'The expected production ezBookkeeping executable was not found.'
}
if (-not (Test-Path -LiteralPath $NodeExecutablePath -PathType Leaf) -and -not (Get-Command $NodeExecutablePath -ErrorAction SilentlyContinue)) {
    throw 'The required Node.js executable was not found.'
}
if (-not (Test-Path -LiteralPath $SqliteVerifierPath -PathType Leaf)) {
    throw 'The SQLite verifier was not found.'
}

Assert-LedgerNoConfigurationOverrides -SettingNames $migratedSettingNames
Assert-LedgerNoStaticMcpCredential -OpenClawConfigPath $OpenClawConfigPath

$preflightConfigHash = Get-LedgerFileSha256 -Path $configPath
$document = Get-LedgerIniDocument -Path $configPath
if ((Get-LedgerFileSha256 -Path $configPath) -cne $preflightConfigHash) {
    throw 'The production configuration changed while migration preflight read it.'
}
$profileMarkers = [regex]::Matches($document.Text, '(?mi)^\s*[;#]\s*CLAWBOT_LEDGER_PROFILE\s*=\s*([^\r\n]+?)\s*$')
if ($profileMarkers.Count -gt 1 -or
    ($profileMarkers.Count -eq 1 -and $profileMarkers[0].Value.Trim() -cne '; CLAWBOT_LEDGER_PROFILE=production')) {
    throw 'The current production configuration has an invalid ledger profile marker.'
}
$currentRequirements = @{
    'global.mode' = 'production'
    'uuid.generator_type' = 'internal'
    'uuid.server_id' = '0'
    'duplicate_checker.checker_type' = 'in_memory'
    'duplicate_checker.cleanup_interval' = '60'
    'duplicate_checker.duplicate_submissions_interval' = '300'
    'server.protocol' = 'http'
    'server.http_addr' = '127.0.0.1'
    'server.http_port' = '8180'
    'database.type' = 'sqlite3'
}
foreach ($key in $currentRequirements.Keys) {
    $separator = $key.IndexOf('.')
    $actual = Get-LedgerIniValue -Document $document -Section $key.Substring(0, $separator) -Name $key.Substring($separator + 1)
    if ($actual -cne $currentRequirements[$key]) {
        throw 'The current production configuration does not match the recognized migration source.'
    }
}
$enableMcp = Get-LedgerIniValue -Document $document -Section 'mcp' -Name 'enable_mcp'
if ($enableMcp -cne 'true' -and $enableMcp -cne 'false') {
    throw 'The current MCP enable setting is invalid.'
}
$secretKey = Get-LedgerIniValue -Document $document -Section 'security' -Name 'secret_key'
if ([string]::IsNullOrWhiteSpace($secretKey) -or $secretKey.StartsWith('__')) {
    throw 'The production signing secret is not configured.'
}

$databasePath = Resolve-LedgerDataPath -InstallDirectory $install -ConfiguredPath (Get-LedgerIniValue -Document $document -Section 'database' -Name 'db_path')
$expectedDatabasePath = Get-LedgerNormalizedPath -Path (Join-Path $install 'data\ezbookkeeping.db')
if (-not (Test-LedgerSamePath -Left $databasePath -Right $expectedDatabasePath)) {
    throw 'The production database path does not match the recognized migration source.'
}
if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf)) {
    throw 'The production SQLite database was not found.'
}
if (@(Get-LedgerListeningTcpConnections -Port 8888).Count -ne 0) {
    throw 'Production port 8888 is already occupied.'
}
$task = Get-LedgerExpectedTask -TaskName $TaskName -InstallDirectory $install -ExpectedExecutable $executablePath -ConfigPath $configPath -Mode Legacy
if ([string]$task.State -cne 'Running') {
    throw 'The exact production ezBookkeeping task is not running.'
}
$taskWasRunning = $true
$legacyOwner = Get-LedgerLegacyListenerOwner -Port 8180 -ExpectedExecutable $executablePath
if (-not (Test-LedgerOrigin -Port 8180)) {
    throw 'The current production origin is unhealthy.'
}
$preflightDatabase = Invoke-LedgerSqliteVerifier -NodeExecutablePath $NodeExecutablePath -VerifierPath $SqliteVerifierPath -DatabasePath $databasePath
if ([int]$preflightDatabase.activeUserCount -ne 1) {
    throw 'Production migration requires exactly one active user.'
}
$taskXml = Export-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
if ([string]::IsNullOrWhiteSpace([string]$taskXml)) {
    throw 'The production task definition could not be exported.'
}

if (-not $PSCmdlet.ShouldProcess($configPath, 'Back up and migrate the verified production ledger to port 8888')) {
    return
}

$backupDirectory = $null
$backupConfigPath = $null
$backupTaskPath = $null
$taskStopped = $false
$configWritten = $false
$taskChangeAttempted = $false
$taskStarted = $false

try {
    Assert-LedgerNoConfigurationOverrides -SettingNames $migratedSettingNames
    if (@(Get-LedgerListeningTcpConnections -Port 8888).Count -ne 0) {
        throw 'Production port 8888 became occupied after migration preflight.'
    }
    $task = Get-LedgerExpectedTask -TaskName $TaskName -InstallDirectory $install -ExpectedExecutable $executablePath -ConfigPath $configPath -Mode Legacy
    if ([string]$task.State -cne 'Running') {
        throw 'The exact production ezBookkeeping task stopped after migration preflight.'
    }
    $finalTaskXml = Export-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
    if ([string]$finalTaskXml -cne [string]$taskXml) {
        throw 'The production task definition changed after migration preflight.'
    }
    if ((Get-LedgerFileSha256 -Path $configPath) -cne $preflightConfigHash) {
        throw 'The production configuration changed after migration preflight.'
    }
    $finalLegacyOwner = Get-LedgerLegacyListenerOwner -Port 8180 -ExpectedExecutable $executablePath
    if ([int]$finalLegacyOwner.ProcessId -ne [int]$legacyOwner.ProcessId -or
        [string]$finalLegacyOwner.CreationDate -cne [string]$legacyOwner.CreationDate -or
        [string]$finalLegacyOwner.CommandLine -cne [string]$legacyOwner.CommandLine) {
        throw 'The production listener identity changed after migration preflight.'
    }
    $legacyOwner = $finalLegacyOwner
    Stop-ScheduledTask -InputObject $task -ErrorAction Stop
    $taskStopped = $true
    Wait-LedgerListenerExit -Identity $legacyOwner -Port 8180 -ExpectedExecutable $executablePath -ExpectedConfigPath $configPath -Legacy
    if (@(Get-LedgerListeningTcpConnections -Port 8888).Count -ne 0) {
        throw 'Production port 8888 became occupied before migration files were changed.'
    }
    if ((Get-LedgerFileSha256 -Path $configPath) -cne $preflightConfigHash) {
        throw 'The production configuration changed while the verified service was stopping.'
    }
    $document = Get-LedgerIniDocument -Path $configPath
    if ((Get-LedgerFileSha256 -Path $configPath) -cne $preflightConfigHash) {
        throw 'The production configuration changed while the stopped snapshot was re-read.'
    }
    Protect-LedgerOwnerOnlyFile -Path $configPath
    Assert-LedgerOwnerOnlyFile -Path $configPath

    New-Item -ItemType Directory -Path $backupBase -Force -ErrorAction Stop | Out-Null
    Assert-LedgerNoExistingReparsePath -Path $backupBase
    Set-LedgerOwnerOnlyAcl -Path $backupBase
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
    for ($suffix = 0; $suffix -lt 100; $suffix++) {
        $leaf = if ($suffix -eq 0) { $stamp } else { $stamp + '-' + $suffix }
        $candidate = Join-Path $backupBase $leaf
        if (-not (Test-Path -LiteralPath $candidate)) {
            Assert-LedgerNoExistingReparsePath -Path $candidate
            $backupDirectory = $candidate
            New-Item -ItemType Directory -Path $backupDirectory -ErrorAction Stop | Out-Null
            Assert-LedgerNoExistingReparsePath -Path $backupDirectory
            break
        }
    }
    if ([string]::IsNullOrWhiteSpace($backupDirectory)) {
        throw 'A unique production backup directory could not be created.'
    }
    Set-LedgerOwnerOnlyAcl -Path $backupDirectory

    $backupConfigPath = Join-Path $backupDirectory 'ezbookkeeping.ini'
    New-LedgerOwnerOnlyEmptyFile -Path $backupConfigPath
    Copy-LedgerFileBytesIntoExistingFile -SourcePath $configPath -DestinationPath $backupConfigPath
    Assert-LedgerOwnerOnlyFile -Path $backupConfigPath
    if ((Get-LedgerFileSha256 -Path $configPath) -cne $preflightConfigHash -or
        (Get-LedgerFileSha256 -Path $backupConfigPath) -cne $preflightConfigHash) {
        throw 'The production configuration backup hash did not match.'
    }

    $backupTaskPath = Join-Path $backupDirectory 'task-definition.xml'
    New-LedgerOwnerOnlyEmptyFile -Path $backupTaskPath
    $taskBytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes([string]$taskXml)
    try {
        Write-LedgerBytesIntoExistingFile -Path $backupTaskPath -Bytes $taskBytes
    } finally {
        if ($taskBytes.Length -gt 0) { [Array]::Clear($taskBytes, 0, $taskBytes.Length) }
    }
    Protect-LedgerOwnerOnlyFile -Path $backupTaskPath
    $savedTaskXml = [IO.File]::ReadAllText($backupTaskPath, (New-Object System.Text.UTF8Encoding($false, $true)))
    if ($savedTaskXml -cne [string]$taskXml) {
        throw 'The production task-definition backup did not pass verification.'
    }
    Assert-LedgerOwnerOnlyFile -Path $backupTaskPath

    $backupDatabasePath = Join-Path $backupDirectory 'ezbookkeeping.db'
    $backupDatabase = Invoke-LedgerSqliteVerifier -NodeExecutablePath $NodeExecutablePath -VerifierPath $SqliteVerifierPath -DatabasePath $databasePath -BackupPath $backupDatabasePath
    if ([int]$backupDatabase.activeUserCount -ne 1) {
        throw 'The production database backup did not contain exactly one active user.'
    }
    Protect-LedgerOwnerOnlyFile -Path $backupDatabasePath
    Assert-LedgerOwnerOnlyFile -Path $backupDatabasePath

    $manifest = [ordered]@{
        schemaVersion = 1
        activeUserCount = 1
        files = @(
            [ordered]@{ name = 'ezbookkeeping.ini'; sha256 = Get-LedgerFileSha256 -Path $backupConfigPath },
            [ordered]@{ name = 'ezbookkeeping.db'; sha256 = Get-LedgerFileSha256 -Path $backupDatabasePath },
            [ordered]@{ name = 'task-definition.xml'; sha256 = Get-LedgerFileSha256 -Path $backupTaskPath }
        )
    }
    $manifestPath = Join-Path $backupDirectory 'backup-manifest.json'
    New-LedgerOwnerOnlyEmptyFile -Path $manifestPath
    $manifestBytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes(($manifest | ConvertTo-Json -Depth 5))
    try {
        Write-LedgerBytesIntoExistingFile -Path $manifestPath -Bytes $manifestBytes
    } finally {
        if ($manifestBytes.Length -gt 0) { [Array]::Clear($manifestBytes, 0, $manifestBytes.Length) }
    }
    Protect-LedgerOwnerOnlyFile -Path $manifestPath
    Assert-LedgerOwnerOnlyFile -Path $manifestPath

    if ((Get-LedgerFileSha256 -Path $configPath) -cne $preflightConfigHash -or
        (Get-LedgerFileSha256 -Path $backupConfigPath) -cne $preflightConfigHash) {
        throw 'The production configuration changed after its verified backup was created.'
    }
    $updatedText = Set-LedgerIniValues -Document $document -Settings @{
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
    if ($updatedText -notmatch '(?m)^; CLAWBOT_LEDGER_PROFILE=production\s*$') {
        $updatedText = '; CLAWBOT_LEDGER_PROFILE=production' + $document.LineEnding + $updatedText
    }
    if ((Get-LedgerFileSha256 -Path $configPath) -cne $preflightConfigHash -or
        (Get-LedgerFileSha256 -Path $backupConfigPath) -cne $preflightConfigHash) {
        throw 'The production configuration changed immediately before migration write.'
    }
    Assert-LedgerNoConfigurationOverrides -SettingNames $migratedSettingNames
    $configWritten = $true
    Write-LedgerTextAtomically -Path $configPath -Text $updatedText
    Assert-LedgerOwnerOnlyFile -Path $configPath
    $migratedDocument = Get-LedgerIniDocument -Path $configPath
    if ([regex]::Matches($migratedDocument.Text, '(?m)^; CLAWBOT_LEDGER_PROFILE=production\s*$').Count -ne 1) {
        throw 'The migrated production profile marker could not be verified.'
    }
    $explicitArguments = Get-LedgerExplicitServiceArguments -ConfigPath $configPath
    $newAction = New-ScheduledTaskAction -Execute $executablePath -Argument $explicitArguments -WorkingDirectory $install
    $taskChangeAttempted = $true
    $task = Set-ScheduledTask -InputObject $task -Action $newAction -ErrorAction Stop
    $task = Get-LedgerExpectedTask -TaskName $TaskName -InstallDirectory $install -ExpectedExecutable $executablePath -ConfigPath $configPath -Mode Explicit
    Start-ScheduledTask -InputObject $task -ErrorAction Stop
    $taskStarted = $true

    $ready = $false
    for ($attempt = 0; $attempt -lt $StartupCheckAttempts; $attempt++) {
        try {
            $null = Get-LedgerListenerOwner -Port 8888 -ExpectedExecutable $executablePath -ExpectedConfigPath $configPath
            if (Test-LedgerOrigin -Port 8888) {
                $ready = $true
                break
            }
        } catch {
            # Retry only within the bounded local startup window.
        }
        if ($attempt + 1 -lt $StartupCheckAttempts) {
            Start-Sleep -Milliseconds $StartupCheckIntervalMilliseconds
        }
    }
    if (-not $ready) {
        throw 'The migrated production origin did not become healthy.'
    }
    if (@(Get-LedgerListeningTcpConnections -Port 8180).Count -ne 0) {
        throw 'The legacy production port is still listening.'
    }

    [pscustomobject]@{
        Status = 'migrated'
        Port = 8888
        ActiveUserCount = 1
        BackupDirectory = $backupDirectory
    }
} catch {
    $rollbackSucceeded = $true
    try {
        if ($taskStarted) {
            $currentTask = Get-LedgerExpectedTask -TaskName $TaskName -InstallDirectory $install -ExpectedExecutable $executablePath -ConfigPath $configPath -Mode Explicit
            if ([string]$currentTask.State -cne 'Running') {
                throw 'The migrated production task is not running during rollback.'
            }
            $newOwner = $null
            try {
                $newOwner = Get-LedgerListenerOwner -Port 8888 -ExpectedExecutable $executablePath -ExpectedConfigPath $configPath
            } catch {
                $newOwner = $null
            }
            Stop-ScheduledTask -InputObject $currentTask -ErrorAction Stop
            Wait-LedgerListenerExit -Identity $newOwner -Port 8888 -ExpectedExecutable $executablePath -ExpectedConfigPath $configPath
        }
        if ($configWritten) {
            Assert-LedgerOwnerOnlyFile -Path $backupConfigPath
            $configurationNeedsRestore = $true
            if ((Test-Path -LiteralPath $configPath -PathType Leaf) -and
                (Get-LedgerFileSha256 -Path $configPath) -ceq (Get-LedgerFileSha256 -Path $backupConfigPath)) {
                Assert-LedgerOwnerOnlyFile -Path $configPath
                $configurationNeedsRestore = $false
            }
            if ($configurationNeedsRestore) {
                $originalText = [IO.File]::ReadAllText($backupConfigPath, (New-Object System.Text.UTF8Encoding($false, $true)))
                Write-LedgerTextAtomically -Path $configPath -Text $originalText
                Assert-LedgerOwnerOnlyFile -Path $configPath
            }
        }
        if ($taskChangeAttempted) {
            $taskAlreadyLegacy = $false
            try {
                $task = Get-LedgerExpectedTask -TaskName $TaskName -InstallDirectory $install -ExpectedExecutable $executablePath -ConfigPath $configPath -Mode Explicit
            } catch {
                $task = Get-LedgerExpectedTask -TaskName $TaskName -InstallDirectory $install -ExpectedExecutable $executablePath -ConfigPath $configPath -Mode Legacy
                $taskAlreadyLegacy = $true
            }
            if (-not $taskAlreadyLegacy) {
                $legacyAction = New-ScheduledTaskAction -Execute $executablePath -Argument 'server run' -WorkingDirectory $install
                $task = Set-ScheduledTask -InputObject $task -Action $legacyAction -ErrorAction Stop
                $task = Get-LedgerExpectedTask -TaskName $TaskName -InstallDirectory $install -ExpectedExecutable $executablePath -ConfigPath $configPath -Mode Legacy
            }
        }
        if ($taskWasRunning -and $taskStopped) {
            if (@(Get-LedgerListeningTcpConnections -Port 8180).Count -ne 0) {
                throw 'The legacy port is not clear for rollback.'
            }
            Start-ScheduledTask -InputObject $task -ErrorAction Stop
        }
    } catch {
        $rollbackSucceeded = $false
    }
    if (-not $rollbackSucceeded) {
        throw 'Production ledger migration failed and automatic rollback was incomplete. Keep the verified backup for manual recovery.'
    }
    throw 'Production ledger migration failed; configuration and recognized task state were restored.'
}
