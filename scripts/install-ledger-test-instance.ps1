[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$SourceInstallDirectory = 'D:\Clawbot\ezbookkeeping',
    [string]$InstallDirectory = 'D:\Clawbot\ezbookkeeping-test',
    [string]$TemplatePath,
    [string]$TestTokenPath = "$env:USERPROFILE\.openclaw\secrets\ezbookkeeping-test-token.txt",
    [string]$TaskName = 'Clawbot ezBookkeeping test',
    [string]$NodeExecutablePath = 'node.exe',
    [string]$SqliteVerifierPath,
    [ValidateRange(1, 120)]
    [int]$StartupCheckAttempts = 30,
    [ValidateRange(1, 10000)]
    [int]$StartupCheckIntervalMilliseconds = 500,
    [ValidateRange(60, 315360000)]
    [int]$ApiTokenExpiresInSeconds = 31536000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'ledger-runtime-common.ps1')

if ([string]::IsNullOrWhiteSpace($TemplatePath)) {
    $TemplatePath = Join-Path $PSScriptRoot '..\config\ezbookkeeping-test.example.ini'
}
if ([string]::IsNullOrWhiteSpace($SqliteVerifierPath)) {
    $SqliteVerifierPath = Join-Path $PSScriptRoot 'verify-ledger-sqlite.mjs'
}

function Assert-ExternalLedgerPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description
    )

    return Assert-LedgerExternalSecretPath -Path $Path -Description $Description
}

function Assert-NoLedgerReparsePoints {
    param([Parameter(Mandatory = $true)][string]$Path)

    $items = @((Get-Item -LiteralPath $Path -Force -ErrorAction Stop))
    if (Test-Path -LiteralPath $Path -PathType Container) {
        $items += @(Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction Stop)
    }
    foreach ($item in $items) {
        if (([IO.FileAttributes]$item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'A test-instance source or destination contains a reparse point.'
        }
    }
}

function Get-LedgerRandomHex {
    param([ValidateRange(16, 256)][int]$ByteCount = 64)

    $bytes = New-Object byte[] $ByteCount
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
        return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
        $generator.Dispose()
    }
}

function Write-NewLedgerProtectedText {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text
    )

    if (Test-Path -LiteralPath $Path) {
        throw 'A protected test-instance file already exists.'
    }
    $parent = Split-Path -Parent $Path
    Assert-LedgerNoExistingReparsePath -Path $Path
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -ErrorAction Stop | Out-Null
        Assert-LedgerNoExistingReparsePath -Path $parent
        Set-LedgerOwnerOnlyAcl -Path $parent
    }
    New-LedgerOwnerOnlyEmptyFile -Path $Path
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $bytes = $encoding.GetBytes($Text)
    try {
        Write-LedgerBytesIntoExistingFile -Path $Path -Bytes $bytes
        Protect-LedgerOwnerOnlyFile -Path $Path
        Assert-LedgerOwnerOnlyFile -Path $Path
    } catch {
        Remove-LedgerOwnedFileIfPresent -Path $Path
        throw
    } finally {
        if ($bytes.Length -gt 0) { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
}

function Copy-LedgerPublicAssets {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    Assert-NoLedgerReparsePoints -Path $Source
    New-Item -ItemType Directory -Path $Destination -ErrorAction Stop | Out-Null
    foreach ($item in @(Get-ChildItem -LiteralPath $Source -Force -Recurse -ErrorAction Stop)) {
        $relative = $item.FullName.Substring($Source.Length).TrimStart([char[]]@('\', '/'))
        if ([string]::IsNullOrWhiteSpace($relative)) { continue }
        $target = Join-Path $Destination $relative
        if ($item.PSIsContainer) {
            New-Item -ItemType Directory -Path $target -ErrorAction Stop | Out-Null
        } else {
            $parent = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
                New-Item -ItemType Directory -Path $parent -ErrorAction Stop | Out-Null
            }
            [IO.File]::Copy($item.FullName, $target, $false)
            if ((Get-LedgerFileSha256 -Path $item.FullName) -cne (Get-LedgerFileSha256 -Path $target)) {
                throw 'A copied public asset did not pass verification.'
            }
        }
    }
}

function Assert-LedgerTestTemplate {
    param([Parameter(Mandatory = $true)][object]$Document)

    $required = @{
        'global.mode' = 'production'
        'uuid.generator_type' = 'internal'
        'uuid.server_id' = '1'
        'duplicate_checker.checker_type' = 'in_memory'
        'duplicate_checker.cleanup_interval' = '60'
        'duplicate_checker.duplicate_submissions_interval' = '300'
        'server.protocol' = 'http'
        'server.http_addr' = '127.0.0.1'
        'server.http_port' = '18888'
        'server.domain' = '127.0.0.1'
        'server.root_url' = 'http://127.0.0.1:18888/'
        'mcp.enable_mcp' = 'false'
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
        $actual = Get-LedgerIniValue -Document $Document -Section $key.Substring(0, $separator) -Name $key.Substring($separator + 1)
        if ($actual -cne $required[$key]) {
            throw 'The isolated test template does not match the required boundary.'
        }
    }
    if ($Document.Text -notmatch '(?m)^; CLAWBOT_LEDGER_PROFILE=test\s*$') {
        throw 'The isolated test template marker is missing.'
    }
    if ((Get-LedgerIniValue -Document $Document -Section 'security' -Name 'secret_key') -cne '__GENERATE_LOCAL_TEST_SECRET__') {
        throw 'The isolated test template contains an unsafe secret value.'
    }
}

function Wait-LedgerTestOrigin {
    param(
        [Parameter(Mandatory = $true)][string]$ExecutablePath,
        [Parameter(Mandatory = $true)][string]$ConfigPath
    )

    for ($attempt = 0; $attempt -lt $StartupCheckAttempts; $attempt++) {
        try {
            $owner = Get-LedgerListenerOwner -Port 18888 -ExpectedExecutable $ExecutablePath -ExpectedConfigPath $ConfigPath
            if (Test-LedgerOrigin -Port 18888) {
                return $owner
            }
        } catch {
            # Retry only inside the fixed local startup window.
        }
        if ($attempt + 1 -lt $StartupCheckAttempts) {
            Start-Sleep -Milliseconds $StartupCheckIntervalMilliseconds
        }
    }
    throw 'The isolated test instance did not pass its bounded startup checks.'
}

function Stop-LedgerTestService {
    param(
        [Parameter(Mandatory = $true)][object]$Task,
        [Parameter(Mandatory = $true)][string]$ExecutablePath,
        [Parameter(Mandatory = $true)][string]$ConfigPath
    )

    $identity = $null
    $listeners = @(Get-LedgerListeningTcpConnections -Port 18888)
    if ($listeners.Count -gt 0) {
        $identity = Get-LedgerListenerOwner -Port 18888 -ExpectedExecutable $ExecutablePath -ExpectedConfigPath $ConfigPath
    }
    if ([string]$Task.State -cne 'Running') {
        if ($listeners.Count -gt 0) {
            throw 'The isolated test listener is detached from the exact scheduled task.'
        }
        return
    }
    Stop-ScheduledTask -InputObject $Task -ErrorAction Stop
    Wait-LedgerListenerExit -Identity $identity -Port 18888 -ExpectedExecutable $ExecutablePath -ExpectedConfigPath $ConfigPath
}

function ConvertFrom-LedgerSecureString {
    param([Parameter(Mandatory = $true)][Security.SecureString]$Value)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

$sourceRoot = Get-LedgerNormalizedPath -Path $SourceInstallDirectory
$installRoot = Assert-ExternalLedgerPath -Path $InstallDirectory -Description 'The isolated test install directory'
$tokenPath = Assert-ExternalLedgerPath -Path $TestTokenPath -Description 'The isolated test token path'
$template = Get-LedgerNormalizedPath -Path $TemplatePath
$verifier = Get-LedgerNormalizedPath -Path $SqliteVerifierPath
$sourceExecutable = Get-LedgerNormalizedPath -Path (Join-Path $sourceRoot 'ezbookkeeping.exe')
$sourcePublic = Get-LedgerNormalizedPath -Path (Join-Path $sourceRoot 'public')
$testExecutable = Get-LedgerNormalizedPath -Path (Join-Path $installRoot 'ezbookkeeping.exe')
$testConfig = Get-LedgerNormalizedPath -Path (Join-Path $installRoot 'conf\ezbookkeeping-test.ini')
$testDatabase = Get-LedgerNormalizedPath -Path (Join-Path $installRoot 'data\ezbookkeeping-test.db')
$testLog = Get-LedgerNormalizedPath -Path (Join-Path $installRoot 'log\ezbookkeeping-test.log')
$testStorage = Get-LedgerNormalizedPath -Path (Join-Path $installRoot 'storage')
$installMarker = Get-LedgerNormalizedPath -Path (Join-Path $installRoot '.clawbot-ledger-test-instance-installing')
$readyMarker = Get-LedgerNormalizedPath -Path (Join-Path $installRoot '.clawbot-ledger-test-instance-ready')
$productionToken = Get-LedgerNormalizedPath -Path "$env:USERPROFILE\.openclaw\secrets\ezbookkeeping-token.txt"

if ((Test-LedgerPathInside -Candidate $installRoot -Root $sourceRoot) -or
    (Test-LedgerPathInside -Candidate $sourceRoot -Root $installRoot) -or
    (Test-LedgerSamePath -Left $installRoot -Right 'D:\Clawbot\ezbookkeeping')) {
    throw 'The isolated test instance overlaps the production installation.'
}
if (Test-LedgerSamePath -Left $tokenPath -Right $productionToken) {
    throw 'The isolated test installer refuses the production token path.'
}
if ((Split-Path -Leaf $tokenPath) -cne 'ezbookkeeping-test-token.txt') {
    throw 'The isolated test token file name is invalid.'
}
foreach ($runtimeRoot in @($sourceRoot, $installRoot)) {
    if ([string]::Equals($tokenPath, $runtimeRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $tokenPath.StartsWith($runtimeRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The isolated test token path overlaps a ledger installation.'
    }
}
foreach ($requiredPath in @($sourceExecutable, $sourcePublic, $template, $verifier)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw 'A required test-instance source asset was not found.'
    }
}
if (-not (Test-Path -LiteralPath $sourceExecutable -PathType Leaf) -or
    -not (Test-Path -LiteralPath $sourcePublic -PathType Container) -or
    -not (Test-Path -LiteralPath $template -PathType Leaf) -or
    -not (Test-Path -LiteralPath $verifier -PathType Leaf)) {
    throw 'A required test-instance source asset has the wrong type.'
}
foreach ($protectedPath in @($sourceRoot, $sourceExecutable, $sourcePublic, $installRoot, $tokenPath)) {
    Assert-LedgerNoExistingReparsePath -Path $protectedPath
}
if (-not (Test-Path -LiteralPath $NodeExecutablePath -PathType Leaf) -and
    -not (Get-Command $NodeExecutablePath -ErrorAction SilentlyContinue)) {
    throw 'The required Node.js executable was not found.'
}
$nodeVersionText = [string](& $NodeExecutablePath --version 2>$null)
if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v([0-9]+)\.' -or [int]$matches[1] -lt 24) {
    throw 'Node.js 24 or newer is required for isolated SQLite verification.'
}
Assert-NoLedgerReparsePoints -Path $sourceExecutable
Assert-NoLedgerReparsePoints -Path $sourcePublic

$templateDocument = Get-LedgerIniDocument -Path $template
Assert-LedgerTestTemplate -Document $templateDocument
Assert-LedgerNoConfigurationOverrides -SettingNames @(
    'GLOBAL_MODE',
    'UUID_GENERATOR_TYPE', 'UUID_SERVER_ID',
    'DUPLICATE_CHECKER_CHECKER_TYPE', 'DUPLICATE_CHECKER_CLEANUP_INTERVAL', 'DUPLICATE_CHECKER_DUPLICATE_SUBMISSIONS_INTERVAL',
    'SERVER_PROTOCOL', 'SERVER_HTTP_ADDR', 'SERVER_HTTP_PORT', 'SERVER_DOMAIN', 'SERVER_ROOT_URL',
    'MCP_ENABLE_MCP', 'MCP_MCP_ALLOWED_REMOTE_IPS',
    'DATABASE_TYPE', 'DATABASE_DB_PATH',
    'LOG_MODE', 'LOG_LEVEL', 'LOG_LOG_PATH',
    'STORAGE_TYPE', 'STORAGE_LOCAL_FILESYSTEM_PATH',
    'SECURITY_SECRET_KEY', 'SECURITY_TRUSTED_PROXY_IPS', 'SECURITY_TOKEN_EXPIRED_TIME',
    'SECURITY_TOKEN_MIN_REFRESH_INTERVAL', 'SECURITY_ENABLE_API_TOKEN', 'SECURITY_API_TOKEN_ALLOWED_REMOTE_IPS',
    'SECURITY_MAX_FAILURES_PER_IP_PER_MINUTE', 'SECURITY_MAX_FAILURES_PER_USER_PER_MINUTE',
    'AUTH_ENABLE_INTERNAL_AUTH', 'AUTH_ENABLE_OAUTH2_AUTH', 'AUTH_ENABLE_TWO_FACTOR', 'AUTH_ENABLE_FORGET_PASSWORD',
    'AUTH_OAUTH2_USER_IDENTIFIER', 'USER_ENABLE_REGISTER', 'MAP_AMAP_SECURITY_VERIFICATION_METHOD',
    'EXCHANGE_RATES_DATA_SOURCE'
)

$allTasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
    $null -ne $_ -and
    $null -ne $_.PSObject.Properties['TaskName'] -and
    $null -ne $_.PSObject.Properties['TaskPath'] -and
    $_.TaskName -eq $TaskName -and $_.TaskPath -eq '\'
})
$installExists = Test-Path -LiteralPath $installRoot -PathType Container
$installEntries = @()
if ($installExists) {
    $installEntries = @(Get-ChildItem -LiteralPath $installRoot -Force -ErrorAction Stop)
}
$isRetry = $false
$retryTask = $null
$retryListenerIdentity = $null

if ($installEntries.Count -gt 0) {
    $hasInstallMarker = Test-Path -LiteralPath $installMarker -PathType Leaf
    $hasReadyMarker = Test-Path -LiteralPath $readyMarker -PathType Leaf
    if ($hasInstallMarker -and $hasReadyMarker) {
        throw 'The isolated test instance has ambiguous state markers.'
    }
    if ($hasReadyMarker) {
        Assert-NoLedgerReparsePoints -Path $installRoot
        Assert-LedgerOwnerOnlyFile -Path $readyMarker
        $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
        if ([IO.File]::ReadAllText($readyMarker, $strictUtf8).Trim() -cne 'CLAWBOT_LEDGER_TEST_INSTANCE_READY_V1') {
            throw 'The isolated test ready marker is invalid.'
        }
        Assert-LedgerOwnerOnlyFile -Path $testConfig
        $null = Assert-LedgerTestConfiguration -InstallDirectory $installRoot -ConfigPath $testConfig
        if ((Get-LedgerFileSha256 -Path $sourceExecutable) -cne (Get-LedgerFileSha256 -Path $testExecutable)) {
            throw 'The ready test executable no longer matches its verified source asset.'
        }
        $readyTask = Get-LedgerExpectedTask -TaskName $TaskName -InstallDirectory $installRoot -ExpectedExecutable $testExecutable -ConfigPath $testConfig -Mode Explicit
        if ([string]$readyTask.State -cne 'Running') {
            throw 'The isolated test ready marker does not have a running exact scheduled task.'
        }
        $readyIdentity = Get-LedgerListenerOwner -Port 18888 -ExpectedExecutable $testExecutable -ExpectedConfigPath $testConfig
        Assert-LedgerOwnerOnlyFile -Path $tokenPath
        if (-not $PSCmdlet.ShouldProcess($installRoot, 'Verify the existing isolated ezBookkeeping test instance')) {
            return
        }
        $readyTask = Get-LedgerExpectedTask -TaskName $TaskName -InstallDirectory $installRoot -ExpectedExecutable $testExecutable -ConfigPath $testConfig -Mode Explicit
        if ([string]$readyTask.State -cne 'Running') {
            throw 'The exact isolated test task stopped during ready-state verification.'
        }
        $currentReadyIdentity = Get-LedgerListenerOwner -Port 18888 -ExpectedExecutable $testExecutable -ExpectedConfigPath $testConfig
        if ([int]$currentReadyIdentity.ProcessId -ne [int]$readyIdentity.ProcessId -or
            [string]$currentReadyIdentity.CreationDate -cne [string]$readyIdentity.CreationDate) {
            throw 'The isolated test listener changed during ready-state verification.'
        }
        if (-not (Test-LedgerOrigin -Port 18888)) {
            throw 'The isolated test ready marker does not have a healthy local origin.'
        }
        if (-not (Test-Path -LiteralPath $testDatabase -PathType Leaf)) {
            throw 'The isolated test ready marker does not have its expected database.'
        }
        $readyDatabase = Invoke-LedgerSqliteVerifier -NodeExecutablePath $NodeExecutablePath -VerifierPath $verifier -DatabasePath $testDatabase
        if ([int]$readyDatabase.activeUserCount -ne 1) {
            throw 'The isolated test ready marker does not have exactly one enabled user.'
        }
        [pscustomobject]@{ Status = 'already_ready'; Port = 18888 }
        return
    }
    if (-not $hasInstallMarker) {
        throw 'The isolated test install directory is non-empty and unmarked.'
    }
    Assert-NoLedgerReparsePoints -Path $installRoot
    Assert-LedgerOwnerOnlyFile -Path $installMarker
    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    if ([IO.File]::ReadAllText($installMarker, $strictUtf8).Trim() -notmatch '^CLAWBOT_LEDGER_TEST_INSTANCE_INSTALLING_V1:[0-9a-f]{32}$') {
        throw 'The isolated test installation marker is invalid.'
    }
    $allowedNames = @(
        '.clawbot-ledger-test-instance-installing',
        'conf', 'data', 'ezbookkeeping.exe', 'log', 'public', 'storage'
    )
    foreach ($entry in $installEntries) {
        if ($allowedNames -notcontains $entry.Name) {
            throw 'The marked test install directory contains an unexpected item.'
        }
    }
    foreach ($requiredPath in @($testExecutable, $testConfig, (Join-Path $installRoot 'public'))) {
        if (-not (Test-Path -LiteralPath $requiredPath)) {
            throw 'The marked test install directory is incomplete.'
        }
    }
    if ((Get-LedgerFileSha256 -Path $sourceExecutable) -cne (Get-LedgerFileSha256 -Path $testExecutable)) {
        throw 'The marked test executable does not match the source asset.'
    }
    Assert-LedgerOwnerOnlyFile -Path $testConfig
    $null = Assert-LedgerTestConfiguration -InstallDirectory $installRoot -ConfigPath $testConfig
    $retryTask = Get-LedgerExpectedTask -TaskName $TaskName -InstallDirectory $installRoot -ExpectedExecutable $testExecutable -ConfigPath $testConfig -Mode Explicit
    if (Test-Path -LiteralPath $tokenPath) {
        throw 'The isolated test token path is already occupied during bootstrap.'
    }
    $retryListeners = @(Get-LedgerListeningTcpConnections -Port 18888)
    if ($retryListeners.Count -gt 0) {
        $retryListenerIdentity = Get-LedgerListenerOwner -Port 18888 -ExpectedExecutable $testExecutable -ExpectedConfigPath $testConfig
    }
    $isRetry = $true
} else {
    if ($allTasks.Count -ne 0) {
        throw 'A same-name scheduled task already exists for a new test instance.'
    }
    if (Test-Path -LiteralPath $tokenPath) {
        throw 'The isolated test token path already exists.'
    }
    if (@(Get-LedgerListeningTcpConnections -Port 18888).Count -ne 0) {
        throw 'The isolated test port is already occupied.'
    }
}

if (-not $PSCmdlet.ShouldProcess($installRoot, 'Install and bootstrap the isolated ezBookkeeping test instance')) {
    return
}

$task = $null
$listenerIdentity = $null
$tokenCreated = $false
$readyCreated = $false
$configPrepared = $false
$mutationStarted = $false
$securePassword = $null
$plainPassword = $null
$sessionToken = $null
$apiToken = $null
$requestBody = $null
$requestHeaders = $null
$taskRegistrationAttempted = $false

try {
    if (-not $isRetry -and @(Get-LedgerListeningTcpConnections -Port 18888).Count -ne 0) {
        throw 'The isolated test port became occupied before installation.'
    }
    $mutationStarted = $true
    if (-not $isRetry) {
        if (-not $installExists) {
            New-Item -ItemType Directory -Path $installRoot -ErrorAction Stop | Out-Null
        }
        Set-LedgerOwnerOnlyAcl -Path $installRoot
        foreach ($directoryPath in @(
            (Join-Path $installRoot 'conf'),
            (Join-Path $installRoot 'data'),
            (Join-Path $installRoot 'log'),
            $testStorage
        )) {
            New-Item -ItemType Directory -Path $directoryPath -ErrorAction Stop | Out-Null
            Set-LedgerOwnerOnlyAcl -Path $directoryPath
        }
        Write-NewLedgerProtectedText -Path $installMarker -Text ('CLAWBOT_LEDGER_TEST_INSTANCE_INSTALLING_V1:' + [Guid]::NewGuid().ToString('N') + "`n")
        [IO.File]::Copy($sourceExecutable, $testExecutable, $false)
        if ((Get-LedgerFileSha256 -Path $sourceExecutable) -cne (Get-LedgerFileSha256 -Path $testExecutable)) {
            throw 'The copied test executable did not pass verification.'
        }
        Copy-LedgerPublicAssets -Source $sourcePublic -Destination (Join-Path $installRoot 'public')

        $renderedConfig = Set-LedgerIniValues -Document $templateDocument -Settings @{
            'database.db_path' = $testDatabase
            'log.log_path' = $testLog
            'storage.local_filesystem_path' = $testStorage
            'security.secret_key' = (Get-LedgerRandomHex -ByteCount 64)
            'user.enable_register' = 'true'
        }
        Write-NewLedgerProtectedText -Path $testConfig -Text $renderedConfig
        $configPrepared = $true

        $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $action = New-ScheduledTaskAction -Execute $testExecutable -Argument (Get-LedgerExplicitServiceArguments -ConfigPath $testConfig) -WorkingDirectory $installRoot
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
        $taskRegistrationAttempted = $true
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Isolated loopback-only ezBookkeeping test instance' -ErrorAction Stop | Out-Null
    } else {
        $task = Get-LedgerExpectedTask -TaskName $TaskName -InstallDirectory $installRoot -ExpectedExecutable $testExecutable -ConfigPath $testConfig -Mode Explicit
        $currentRetryListeners = @(Get-LedgerListeningTcpConnections -Port 18888)
        if ($currentRetryListeners.Count -gt 0) {
            $currentRetryIdentity = Get-LedgerListenerOwner -Port 18888 -ExpectedExecutable $testExecutable -ExpectedConfigPath $testConfig
            if ($null -ne $retryListenerIdentity -and
                ([int]$currentRetryIdentity.ProcessId -ne [int]$retryListenerIdentity.ProcessId -or
                [string]$currentRetryIdentity.CreationDate -cne [string]$retryListenerIdentity.CreationDate)) {
                throw 'The isolated test listener identity changed before retry shutdown.'
            }
        }
        Stop-LedgerTestService -Task $task -ExecutablePath $testExecutable -ConfigPath $testConfig
        $document = Get-LedgerIniDocument -Path $testConfig
        $openRegistration = Set-LedgerIniValues -Document $document -Settings @{ 'user.enable_register' = 'true' }
        Write-LedgerTextAtomically -Path $testConfig -Text $openRegistration
        $configPrepared = $true
    }

    $task = Get-LedgerExpectedTask -TaskName $TaskName -InstallDirectory $installRoot -ExpectedExecutable $testExecutable -ConfigPath $testConfig -Mode Explicit
    Start-ScheduledTask -InputObject $task -ErrorAction Stop
    $listenerIdentity = Wait-LedgerTestOrigin -ExecutablePath $testExecutable -ConfigPath $testConfig

    $username = [string](Read-Host 'Isolated test username')
    $email = [string](Read-Host 'Isolated test email')
    $nickname = [string](Read-Host 'Isolated test nickname')
    $securePassword = Read-Host 'Isolated test password' -AsSecureString
    if ([string]::IsNullOrWhiteSpace($username) -or [string]::IsNullOrWhiteSpace($email) -or
        [string]::IsNullOrWhiteSpace($nickname) -or $null -eq $securePassword) {
        throw 'The isolated test account input was incomplete.'
    }
    $plainPassword = ConvertFrom-LedgerSecureString -Value $securePassword
    if ([string]::IsNullOrWhiteSpace($plainPassword)) {
        throw 'The isolated test password was empty.'
    }

    $requestBody = @{
        username = $username.Trim()
        email = $email.Trim()
        nickname = $nickname.Trim()
        password = $plainPassword
        language = 'en'
        defaultCurrency = 'SGD'
        firstDayOfWeek = 1
        categories = @()
    } | ConvertTo-Json -Depth 8 -Compress
    try {
        $registration = Invoke-RestMethod `
            -Method Post `
            -Uri 'http://127.0.0.1:18888/api/register.json' `
            -ContentType 'application/json; charset=utf-8' `
            -Body $requestBody `
            -MaximumRedirection 0 `
            -TimeoutSec 5 `
            -ErrorAction Stop
    } catch {
        throw 'The isolated local registration request failed.'
    }
    $sessionToken = ([string]$registration.result.token).Trim()
    if ($registration.success -ne $true -or [string]::IsNullOrWhiteSpace($sessionToken) -or $sessionToken -match '[\r\n]') {
        throw 'The isolated local registration request was rejected.'
    }

    $requestHeaders = @{ Authorization = 'Bearer ' + $sessionToken }
    $requestBody = @{ expiresInSeconds = $ApiTokenExpiresInSeconds; password = $plainPassword } | ConvertTo-Json -Compress
    try {
        $tokenResponse = Invoke-RestMethod `
            -Method Post `
            -Uri 'http://127.0.0.1:18888/api/v1/tokens/generate/api.json' `
            -Headers $requestHeaders `
            -ContentType 'application/json; charset=utf-8' `
            -Body $requestBody `
            -MaximumRedirection 0 `
            -TimeoutSec 5 `
            -ErrorAction Stop
    } catch {
        throw 'The isolated API token request failed.'
    }
    $apiToken = ([string]$tokenResponse.result.token).Trim()
    if ($tokenResponse.success -ne $true -or [string]::IsNullOrWhiteSpace($apiToken) -or $apiToken -match '[\r\n]') {
        throw 'The isolated API token request was rejected.'
    }
    Write-NewLedgerProtectedText -Path $tokenPath -Text $apiToken
    $tokenCreated = $true

    $task = Get-LedgerExpectedTask -TaskName $TaskName -InstallDirectory $installRoot -ExpectedExecutable $testExecutable -ConfigPath $testConfig -Mode Explicit
    Stop-LedgerTestService -Task $task -ExecutablePath $testExecutable -ConfigPath $testConfig
    $document = Get-LedgerIniDocument -Path $testConfig
    $lockedConfig = Set-LedgerIniValues -Document $document -Settings @{ 'user.enable_register' = 'false' }
    Write-LedgerTextAtomically -Path $testConfig -Text $lockedConfig
    $null = Assert-LedgerTestConfiguration -InstallDirectory $installRoot -ConfigPath $testConfig

    $task = Get-LedgerExpectedTask -TaskName $TaskName -InstallDirectory $installRoot -ExpectedExecutable $testExecutable -ConfigPath $testConfig -Mode Explicit
    Start-ScheduledTask -InputObject $task -ErrorAction Stop
    $listenerIdentity = Wait-LedgerTestOrigin -ExecutablePath $testExecutable -ConfigPath $testConfig

    if (-not (Test-Path -LiteralPath $testDatabase -PathType Leaf)) {
        throw 'The isolated test database was not created.'
    }
    $verification = Invoke-LedgerSqliteVerifier -NodeExecutablePath $NodeExecutablePath -VerifierPath $verifier -DatabasePath $testDatabase
    if ([int]$verification.activeUserCount -ne 1) {
        throw 'The isolated test database does not contain exactly one enabled user.'
    }
    Assert-LedgerOwnerOnlyFile -Path $testConfig
    Assert-LedgerOwnerOnlyFile -Path $tokenPath
    Write-NewLedgerProtectedText -Path $readyMarker -Text "CLAWBOT_LEDGER_TEST_INSTANCE_READY_V1`n"
    $readyCreated = $true
    Remove-Item -LiteralPath $installMarker -Force -ErrorAction Stop

    [pscustomobject]@{
        Status = 'ready'
        Port = 18888
        ActiveUserCount = 1
    }
} catch {
    $rollbackSucceeded = $true
    if ($mutationStarted -and (Test-Path -LiteralPath $testConfig -PathType Leaf)) {
        try {
            $document = Get-LedgerIniDocument -Path $testConfig
            $lockedConfig = Set-LedgerIniValues -Document $document -Settings @{ 'user.enable_register' = 'false' }
            Write-LedgerTextAtomically -Path $testConfig -Text $lockedConfig
        } catch {
            $rollbackSucceeded = $false
        }
    }
    if ($mutationStarted) {
        try {
            $verifiedTask = Get-LedgerExpectedTask -TaskName $TaskName -InstallDirectory $installRoot -ExpectedExecutable $testExecutable -ConfigPath $testConfig -Mode Explicit
            Stop-LedgerTestService -Task $verifiedTask -ExecutablePath $testExecutable -ConfigPath $testConfig
        } catch {
            if ($taskRegistrationAttempted -or $null -ne $task) {
                $rollbackSucceeded = $false
            }
        }
    }
    if ($readyCreated -and (Test-Path -LiteralPath $readyMarker -PathType Leaf)) {
        try { Remove-Item -LiteralPath $readyMarker -Force -ErrorAction Stop } catch { $rollbackSucceeded = $false }
    }
    if ($tokenCreated -and (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
        try { Remove-Item -LiteralPath $tokenPath -Force -ErrorAction Stop } catch { $rollbackSucceeded = $false }
    }
    if (-not $rollbackSucceeded) {
        throw 'The isolated test bootstrap failed and its safe stopped state could not be fully verified.'
    }
    throw 'The isolated test bootstrap failed; registration is disabled, the recognized task is stopped, and no ready marker was created.'
} finally {
    $requestHeaders = $null
    $requestBody = $null
    $apiToken = $null
    $sessionToken = $null
    $plainPassword = $null
    $securePassword = $null
}
