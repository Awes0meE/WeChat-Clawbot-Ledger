Set-StrictMode -Version Latest

function Get-LedgerNormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim())
    if ($expanded.Length -ge 2 -and $expanded[0] -eq [char]34 -and $expanded[$expanded.Length - 1] -eq [char]34) {
        $expanded = $expanded.Substring(1, $expanded.Length - 2)
    }
    $fullPath = [IO.Path]::GetFullPath($expanded)
    if ($fullPath.Length -gt 3) {
        $fullPath = $fullPath.TrimEnd([char[]]@('\', '/'))
    }
    return $fullPath
}

function Test-LedgerSamePath {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )

    return [string]::Equals(
        (Get-LedgerNormalizedPath -Path $Left),
        (Get-LedgerNormalizedPath -Path $Right),
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Test-LedgerSameFile {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )

    $leftPath = Get-LedgerNormalizedPath -Path $Left
    $rightPath = Get-LedgerNormalizedPath -Path $Right
    if (Test-LedgerSamePath -Left $leftPath -Right $rightPath) {
        return $true
    }
    if (-not (Test-Path -LiteralPath $leftPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $rightPath -PathType Leaf)) {
        return $false
    }
    Assert-LedgerNoExistingReparsePath -Path $leftPath
    Assert-LedgerNoExistingReparsePath -Path $rightPath

    if ($null -eq ('Clawbot.LedgerFileIdentityNativeMethods' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Clawbot {
    [StructLayout(LayoutKind.Sequential)]
    public struct LedgerFileInformation {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    public static class LedgerFileIdentityNativeMethods {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetFileInformationByHandle(
            SafeFileHandle fileHandle,
            out LedgerFileInformation fileInformation
        );
    }
}
'@
    }

    $leftStream = $null
    $rightStream = $null
    try {
        $sharing = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        $leftStream = [IO.File]::Open($leftPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, $sharing)
        $rightStream = [IO.File]::Open($rightPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, $sharing)
        $leftInformation = New-Object Clawbot.LedgerFileInformation
        $rightInformation = New-Object Clawbot.LedgerFileInformation
        if (-not [Clawbot.LedgerFileIdentityNativeMethods]::GetFileInformationByHandle($leftStream.SafeFileHandle, [ref]$leftInformation) -or
            -not [Clawbot.LedgerFileIdentityNativeMethods]::GetFileInformationByHandle($rightStream.SafeFileHandle, [ref]$rightInformation)) {
            throw 'A protected ledger file identity could not be verified.'
        }
        return $leftInformation.VolumeSerialNumber -eq $rightInformation.VolumeSerialNumber -and
            $leftInformation.FileIndexHigh -eq $rightInformation.FileIndexHigh -and
            $leftInformation.FileIndexLow -eq $rightInformation.FileIndexLow
    } finally {
        if ($null -ne $rightStream) { $rightStream.Dispose() }
        if ($null -ne $leftStream) { $leftStream.Dispose() }
    }
}

function Test-LedgerPathInside {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $candidatePath = Get-LedgerNormalizedPath -Path $Candidate
    $rootPath = Get-LedgerNormalizedPath -Path $Root
    if ([string]::Equals($candidatePath, $rootPath, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    return $candidatePath.StartsWith($rootPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-LedgerNoExistingReparsePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $current = Get-LedgerNormalizedPath -Path $Path
    while (-not [string]::IsNullOrWhiteSpace($current)) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if (([IO.FileAttributes]$item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'A protected ledger path contains a reparse point.'
            }
        }
        $trimmed = $current.TrimEnd([char[]]@('\', '/'))
        $parent = [IO.Path]::GetDirectoryName($trimmed)
        if ([string]::IsNullOrWhiteSpace($parent) -or
            [string]::Equals($parent, $current, [StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $current = $parent
    }
}

function Assert-LedgerExternalSecretPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $normalized = Get-LedgerNormalizedPath -Path $Path
    $repositoryRoot = Get-LedgerNormalizedPath -Path (Join-Path $PSScriptRoot '..')
    if ((Test-LedgerPathInside -Candidate $normalized -Root $repositoryRoot) -or
        $normalized -match '(?i)\\OneDrive(?:\s|\\|$)') {
        throw ($Description + ' must be outside the repository and OneDrive.')
    }
    Assert-LedgerNoExistingReparsePath -Path $normalized
    return $normalized
}

function Get-LedgerIniDocument {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'The expected ezBookkeeping configuration file was not found.'
    }
    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $text = [IO.File]::ReadAllText($Path, $strictUtf8)
    $lineEnding = if ($text.Contains("`r`n")) { "`r`n" } elseif ($text.Contains("`n")) { "`n" } elseif ($text.Contains("`r")) { "`r" } else { [Environment]::NewLine }
    $lines = [regex]::Split($text, "`r`n|`n|`r")
    $hasFinalLineEnding = $text.EndsWith("`r`n") -or $text.EndsWith("`n") -or $text.EndsWith("`r")
    $section = ''
    $indexes = @{}
    $values = @{}

    for ($index = 0; $index -lt $lines.Count; $index++) {
        $line = $lines[$index]
        if ($line -match '^\s*\[\s*([^\]]+)\s*\]\s*(?:[;#].*)?$') {
            $section = $matches[1].Trim().ToLowerInvariant()
            continue
        }
        if ($line -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$') {
            if ([string]::IsNullOrWhiteSpace($section)) {
                throw 'An ezBookkeeping setting appears outside a named section.'
            }
            $key = $section + '.' + $matches[1].ToLowerInvariant()
            if ($indexes.ContainsKey($key)) {
                throw 'The ezBookkeeping configuration contains a duplicated setting.'
            }
            $indexes[$key] = $index
            $values[$key] = $matches[2]
        }
    }

    return [pscustomobject]@{
        Text = $text
        Lines = $lines
        LineEnding = $lineEnding
        HasFinalLineEnding = $hasFinalLineEnding
        Indexes = $indexes
        Values = $values
        Encoding = $strictUtf8
    }
}

function Get-LedgerIniValue {
    param(
        [Parameter(Mandatory = $true)][object]$Document,
        [Parameter(Mandatory = $true)][string]$Section,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $key = $Section.ToLowerInvariant() + '.' + $Name.ToLowerInvariant()
    if (-not $Document.Values.ContainsKey($key)) {
        throw 'The ezBookkeeping configuration is missing a required setting.'
    }
    return [string]$Document.Values[$key]
}

function Set-LedgerIniValues {
    param(
        [Parameter(Mandatory = $true)][object]$Document,
        [Parameter(Mandatory = $true)][hashtable]$Settings
    )

    $lines = [string[]]$Document.Lines.Clone()
    foreach ($key in $Settings.Keys) {
        $normalizedKey = ([string]$key).ToLowerInvariant()
        if (-not $Document.Indexes.ContainsKey($normalizedKey)) {
            throw 'The ezBookkeeping configuration is missing a setting required for migration.'
        }
        $name = $normalizedKey.Substring($normalizedKey.IndexOf('.') + 1)
        $lines[$Document.Indexes[$normalizedKey]] = $name + ' = ' + [string]$Settings[$key]
    }
    $text = [string]::Join($Document.LineEnding, $lines)
    if ($Document.HasFinalLineEnding -and -not $text.EndsWith($Document.LineEnding)) {
        $text += $Document.LineEnding
    }
    return $text
}

function Write-LedgerTextAtomically {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text
    )

    $normalizedPath = Get-LedgerNormalizedPath -Path $Path
    if (-not (Test-Path -LiteralPath $normalizedPath -PathType Leaf)) {
        throw 'The protected ledger file to replace was not found.'
    }
    Assert-LedgerNoExistingReparsePath -Path $normalizedPath
    $directory = Split-Path -Parent $normalizedPath
    $leaf = Split-Path -Leaf $normalizedPath
    $temporaryPath = Join-Path $directory ('.' + $leaf + '.ledger-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $bytes = $encoding.GetBytes($Text)
    try {
        New-LedgerOwnerOnlyEmptyFile -Path $temporaryPath
        Write-LedgerBytesIntoExistingFile -Path $temporaryPath -Bytes $bytes
        Assert-LedgerOwnerOnlyFile -Path $temporaryPath
        Assert-LedgerNoExistingReparsePath -Path $normalizedPath
        Move-LedgerFileAtomicallyReplacingDestination -SourcePath $temporaryPath -DestinationPath $normalizedPath
        Protect-LedgerOwnerOnlyFile -Path $normalizedPath
    } finally {
        if ($null -ne $bytes -and $bytes.Length -gt 0) {
            [Array]::Clear($bytes, 0, $bytes.Length)
        }
        Remove-LedgerOwnedFileIfPresent -Path $temporaryPath
    }
}

function Resolve-LedgerDataPath {
    param(
        [Parameter(Mandatory = $true)][string]$InstallDirectory,
        [Parameter(Mandatory = $true)][string]$ConfiguredPath
    )

    if ([IO.Path]::IsPathRooted($ConfiguredPath)) {
        return Get-LedgerNormalizedPath -Path $ConfiguredPath
    }
    return Get-LedgerNormalizedPath -Path (Join-Path $InstallDirectory $ConfiguredPath)
}

function Get-LedgerExplicitServiceArguments {
    param([Parameter(Mandatory = $true)][string]$ConfigPath)

    $normalizedConfig = Get-LedgerNormalizedPath -Path $ConfigPath
    if ($normalizedConfig.Contains('"')) {
        throw 'The ezBookkeeping configuration path contains an unsupported character.'
    }
    return '--conf-path "' + $normalizedConfig + '" server run'
}

function Get-LedgerListeningTcpConnections {
    param([Parameter(Mandatory = $true)][int]$Port)

    try {
        return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop)
    } catch {
        if ([string]$_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') {
            return @()
        }
        throw
    }
}

function Get-LedgerListenerOwner {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
        [Parameter(Mandatory = $true)][string]$ExpectedConfigPath
    )

    $listeners = @(Get-LedgerListeningTcpConnections -Port $Port)
    if ($listeners.Count -ne 1 -or [string]$listeners[0].LocalAddress -cne '127.0.0.1') {
        throw 'The expected loopback listener was not found exactly once.'
    }
    $pidValue = [int]$listeners[0].OwningProcess
    if ($pidValue -le 0) {
        throw 'The loopback listener did not have a valid owner.'
    }
    $processes = @(Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $pidValue) -ErrorAction Stop)
    if ($processes.Count -ne 1) {
        throw 'The loopback listener owner could not be identified exactly once.'
    }
    $process = $processes[0]
    if (-not $process.ExecutablePath -or -not (Test-LedgerSamePath -Left ([string]$process.ExecutablePath) -Right $ExpectedExecutable)) {
        throw 'The loopback listener is owned by an unexpected executable.'
    }
    $normalizedExecutable = Get-LedgerNormalizedPath -Path $ExpectedExecutable
    $normalizedConfig = Get-LedgerNormalizedPath -Path $ExpectedConfigPath
    $serviceArguments = Get-LedgerExplicitServiceArguments -ConfigPath $ExpectedConfigPath
    $quotedCommandLine = '"' + $normalizedExecutable + '" ' + $serviceArguments
    $unquotedConfigCommandLine = '"' + $normalizedExecutable + '" --conf-path ' + $normalizedConfig + ' server run'
    $actualCommandLine = [string]$process.CommandLine
    $matchesQuoted = [string]::Equals($actualCommandLine, $quotedCommandLine, [StringComparison]::OrdinalIgnoreCase)
    $matchesUnquotedConfig = $normalizedConfig -notmatch '\s' -and
        [string]::Equals($actualCommandLine, $unquotedConfigCommandLine, [StringComparison]::OrdinalIgnoreCase)
    if (-not $process.CommandLine -or (-not $matchesQuoted -and -not $matchesUnquotedConfig)) {
        throw 'The loopback listener is not using the expected explicit configuration.'
    }
    return [pscustomobject]@{
        ProcessId = $pidValue
        CreationDate = $process.CreationDate
        ExecutablePath = Get-LedgerNormalizedPath -Path ([string]$process.ExecutablePath)
        CommandLine = [string]$process.CommandLine
    }
}

function Assert-LedgerOwnerOnlyFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'A protected local file was not found.'
    }
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $rules = @($acl.Access)
    if (-not $acl.AreAccessRulesProtected -or [string]$acl.Owner -cne $identity -or $rules.Count -ne 1) {
        throw 'A protected local file has an unsafe access control list.'
    }
    $rule = $rules[0]
    $ruleIdentity = [string]$rule.IdentityReference.Value
    $ruleAccessType = [string]$rule.AccessControlType
    $ruleRights = [string]$rule.FileSystemRights
    if ($ruleIdentity -cne $identity -or $ruleAccessType -cne 'Allow' -or $ruleRights -notmatch 'FullControl') {
        throw 'A protected local file has an unsafe access control list.'
    }
}

function Assert-LedgerTestConfiguration {
    param(
        [Parameter(Mandatory = $true)][string]$InstallDirectory,
        [Parameter(Mandatory = $true)][string]$ConfigPath
    )

    $document = Get-LedgerIniDocument -Path $ConfigPath
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
        $actual = Get-LedgerIniValue -Document $document -Section $key.Substring(0, $separator) -Name $key.Substring($separator + 1)
        if ($actual -cne $required[$key]) {
            throw 'The isolated test configuration is not ready.'
        }
    }
    if ($document.Text -notmatch '(?m)^; CLAWBOT_LEDGER_PROFILE=test\s*$') {
        throw 'The isolated test profile marker is missing.'
    }
    $secretKey = Get-LedgerIniValue -Document $document -Section 'security' -Name 'secret_key'
    if ([string]::IsNullOrWhiteSpace($secretKey) -or $secretKey.StartsWith('__')) {
        throw 'The isolated test secret has not been generated.'
    }
    $databasePath = Resolve-LedgerDataPath -InstallDirectory $InstallDirectory -ConfiguredPath (Get-LedgerIniValue -Document $document -Section 'database' -Name 'db_path')
    $normalizedInstall = Get-LedgerNormalizedPath -Path $InstallDirectory
    if (-not $databasePath.StartsWith($normalizedInstall + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The isolated test database is outside the test instance.'
    }
    if ($databasePath -match '(?i)\\ezbookkeeping\\data\\ezbookkeeping\.db$') {
        throw 'The isolated test database overlaps production.'
    }
    foreach ($configuredPath in @(
        (Get-LedgerIniValue -Document $document -Section 'log' -Name 'log_path'),
        (Get-LedgerIniValue -Document $document -Section 'storage' -Name 'local_filesystem_path')
    )) {
        $resolvedPath = Resolve-LedgerDataPath -InstallDirectory $InstallDirectory -ConfiguredPath $configuredPath
        if (-not $resolvedPath.StartsWith($normalizedInstall + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The isolated test runtime path is outside the test instance.'
        }
    }
    return $document
}

function Get-LedgerExpectedTask {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][string]$InstallDirectory,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [Parameter(Mandatory = $true)][ValidateSet('Legacy', 'Explicit')][string]$Mode
    )

    $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq $TaskName -and $_.TaskPath -eq '\' })
    if ($tasks.Count -ne 1) {
        throw 'The expected root ezBookkeeping scheduled task was not found exactly once.'
    }
    $task = $tasks[0]
    $actions = @($task.Actions)
    if ($actions.Count -ne 1) {
        throw 'The ezBookkeeping scheduled task action is ambiguous.'
    }
    $expectedArguments = if ($Mode -eq 'Legacy') { 'server run' } else { Get-LedgerExplicitServiceArguments -ConfigPath $ConfigPath }
    $action = $actions[0]
    $executeMatches = Test-LedgerSamePath -Left ([string]$action.Execute) -Right $ExpectedExecutable
    $workingDirectoryMatches = Test-LedgerSamePath -Left ([string]$action.WorkingDirectory) -Right $InstallDirectory
    $argumentsMatch = [string]::Equals([string]$action.Arguments, $expectedArguments, [StringComparison]::Ordinal)
    if (-not $executeMatches -or -not $workingDirectoryMatches -or -not $argumentsMatch) {
        throw 'The ezBookkeeping scheduled task action does not match the expected service command.'
    }
    return $task
}

function Get-LedgerLegacyListenerOwner {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutable
    )

    $listeners = @(Get-LedgerListeningTcpConnections -Port $Port)
    $localAddress = if ($listeners.Count -eq 1) { [string]$listeners[0].LocalAddress } else { '' }
    if ($listeners.Count -ne 1 -or $localAddress -cne '127.0.0.1') {
        throw 'The expected legacy loopback listener was not found exactly once.'
    }
    $pidValue = [int]$listeners[0].OwningProcess
    $processes = @(Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $pidValue) -ErrorAction Stop)
    if ($pidValue -le 0 -or $processes.Count -ne 1) {
        throw 'The legacy listener owner could not be identified exactly once.'
    }
    $process = $processes[0]
    $normalizedExecutable = Get-LedgerNormalizedPath -Path $ExpectedExecutable
    $executableMatches = if ($process.ExecutablePath) { Test-LedgerSamePath -Left ([string]$process.ExecutablePath) -Right $normalizedExecutable } else { $false }
    if (-not $executableMatches) {
        throw 'The legacy listener is owned by an unexpected executable.'
    }
    $actualCommandLine = [string]$process.CommandLine
    $quoted = '"' + $normalizedExecutable + '" server run'
    $unquoted = $normalizedExecutable + ' server run'
    $matchesQuoted = [string]::Equals($actualCommandLine, $quoted, [StringComparison]::OrdinalIgnoreCase)
    $matchesUnquoted = [string]::Equals($actualCommandLine, $unquoted, [StringComparison]::OrdinalIgnoreCase)
    if (-not $matchesQuoted -and -not $matchesUnquoted) {
        throw 'The legacy listener command line is not recognized.'
    }
    return [pscustomobject]@{
        ProcessId = $pidValue
        CreationDate = $process.CreationDate
        ExecutablePath = $normalizedExecutable
        CommandLine = $actualCommandLine
    }
}

function Wait-LedgerListenerExit {
    param(
        [AllowNull()][object]$Identity,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
        [Parameter(Mandatory = $true)][string]$ExpectedConfigPath,
        [switch]$Legacy,
        [ValidateRange(1, 100)][int]$Attempts = 20,
        [ValidateRange(1, 5000)][int]$IntervalMilliseconds = 100
    )

    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        $listeners = @(Get-LedgerListeningTcpConnections -Port $Port)
        if ($listeners.Count -eq 0) { return }
        if ($null -eq $Identity) {
            throw 'A listener appeared after the exact scheduled task was stopped.'
        }
        $current = if ($Legacy) {
            Get-LedgerLegacyListenerOwner -Port $Port -ExpectedExecutable $ExpectedExecutable
        } else {
            Get-LedgerListenerOwner -Port $Port -ExpectedExecutable $ExpectedExecutable -ExpectedConfigPath $ExpectedConfigPath
        }
        if ([int]$current.ProcessId -ne [int]$Identity.ProcessId -or
            [string]$current.CreationDate -cne [string]$Identity.CreationDate) {
            throw 'Listener ownership changed after the exact scheduled task was stopped.'
        }
        if ($attempt + 1 -lt $Attempts) {
            Start-Sleep -Milliseconds $IntervalMilliseconds
        }
    }
    throw 'The verified listener did not exit with the exact scheduled task.'
}

function Test-LedgerOrigin {
    param([Parameter(Mandatory = $true)][int]$Port)

    try {
        $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/healthz.json" -f $Port) -MaximumRedirection 0 -TimeoutSec 3 -ErrorAction Stop
        if ($health.success -ne $true) { return $false }
        $page = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/" -f $Port) -MaximumRedirection 0 -TimeoutSec 3 -ErrorAction Stop
        return [string]$page.Content -match '(?i)ezBookkeeping'
    } catch {
        return $false
    }
}

function Assert-LedgerNoConfigurationOverrides {
    param([Parameter(Mandatory = $true)][string[]]$SettingNames)

    foreach ($scope in @(
        [EnvironmentVariableTarget]::Process,
        [EnvironmentVariableTarget]::User,
        [EnvironmentVariableTarget]::Machine
    )) {
        $variables = [Environment]::GetEnvironmentVariables($scope)
        foreach ($name in @($variables.Keys)) {
            if ([string]$name -match '^(?i:EBK_|EBKCFP_)') {
                throw 'An ezBookkeeping environment override prevents safe migration.'
            }
        }
    }
}

function Assert-LedgerNoStaticMcpCredential {
    param([Parameter(Mandatory = $true)][string]$OpenClawConfigPath)

    if (-not (Test-Path -LiteralPath $OpenClawConfigPath -PathType Leaf)) {
        throw 'The OpenClaw configuration file was not found.'
    }
    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    try {
        $root = [IO.File]::ReadAllText($OpenClawConfigPath, $strictUtf8) | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw 'The OpenClaw configuration is not valid JSON.'
    }
    if ($root -isnot [pscustomobject]) {
        throw 'The OpenClaw configuration cannot be safely inspected for static MCP credentials.'
    }

    $mcpProperties = @($root.PSObject.Properties | Where-Object { $_.Name -ieq 'mcp' })
    if ($mcpProperties.Count -gt 1) {
        throw 'The OpenClaw configuration cannot be safely inspected for static MCP credentials.'
    }
    if ($mcpProperties.Count -eq 1) {
        $mcp = $mcpProperties[0].Value
        if ($null -eq $mcp -or $mcp -isnot [pscustomobject]) {
            throw 'The OpenClaw configuration cannot be safely inspected for static MCP credentials.'
        }
        $serverProperties = @($mcp.PSObject.Properties | Where-Object { $_.Name -ieq 'servers' })
        if ($serverProperties.Count -gt 1) {
            throw 'The OpenClaw configuration cannot be safely inspected for static MCP credentials.'
        }
        if ($serverProperties.Count -eq 1) {
            $servers = $serverProperties[0].Value
            if ($null -eq $servers -or $servers -isnot [pscustomobject]) {
                throw 'The OpenClaw configuration cannot be safely inspected for static MCP credentials.'
            }
            if (@($servers.PSObject.Properties | Where-Object { $_.Name -ieq 'ezbookkeeping' }).Count -gt 0) {
                throw 'The OpenClaw configuration contains a static MCP credential fallback.'
            }
        }
    }

    $pending = New-Object System.Collections.Stack
    $pending.Push($root)
    while ($pending.Count -gt 0) {
        $value = $pending.Pop()
        if ($null -eq $value -or $value -is [string] -or $value -is [ValueType]) { continue }
        if ($value -is [System.Collections.IEnumerable] -and $value -isnot [pscustomobject]) {
            foreach ($item in $value) { $pending.Push($item) }
            continue
        }
        foreach ($property in $value.PSObject.Properties) {
            if ($property.Name -match '^(?i:authorization|mcpToken|mcpTokenValue|mcpTokenFallback|staticMcpToken)$') {
                throw 'The OpenClaw configuration contains a static MCP credential fallback.'
            }
            $pending.Push($property.Value)
        }
    }
}

function Assert-LedgerBackupRoot {
    param([Parameter(Mandatory = $true)][string]$BackupRoot)

    return Assert-LedgerExternalSecretPath -Path $BackupRoot -Description 'The production backup root'
}

function Set-LedgerOwnerOnlyAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $windowsIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $identity = $windowsIdentity.Name
    $acl = New-Object Security.AccessControl.FileSecurity
    if (Test-Path -LiteralPath $Path -PathType Container) {
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
    }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($windowsIdentity.User)
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
}

function Protect-LedgerOwnerOnlyFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    Assert-LedgerNoExistingReparsePath -Path $Path
    Set-LedgerOwnerOnlyAcl -Path $Path
    Assert-LedgerNoExistingReparsePath -Path $Path
    Assert-LedgerOwnerOnlyFile -Path $Path
}

function Remove-LedgerOwnedFileIfPresent {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not [IO.File]::Exists($Path)) { return }
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or
            (([IO.FileAttributes]$item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            return
        }
        [IO.File]::Delete($Path)
    } catch {
        # Cleanup must never broaden into deleting an unrecognized path.
    }
}

function New-LedgerOwnerOnlyEmptyFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    $normalized = Get-LedgerNormalizedPath -Path $Path
    $parent = Split-Path -Parent $normalized
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw 'The protected ledger file parent directory was not found.'
    }
    Assert-LedgerNoExistingReparsePath -Path $normalized
    $stream = $null
    try {
        $stream = [IO.File]::Open($normalized, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
    try {
        Protect-LedgerOwnerOnlyFile -Path $normalized
    } catch {
        Remove-LedgerOwnedFileIfPresent -Path $normalized
        throw
    }
}

function Write-LedgerBytesIntoExistingFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$Bytes
    )

    Assert-LedgerNoExistingReparsePath -Path $Path
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Truncate, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
}

function Move-LedgerFileAtomicallyReplacingDestination {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

    if ($null -eq ('Clawbot.LedgerRuntimeNativeMethods' -as [type])) {
        Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
namespace Clawbot {
    public static class LedgerRuntimeNativeMethods {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool MoveFileEx(string existingFileName, string newFileName, int flags);
    }
}
'@
    }
    if (-not [Clawbot.LedgerRuntimeNativeMethods]::MoveFileEx($SourcePath, $DestinationPath, 9)) {
        throw 'Atomic ledger file replacement failed.'
    }
}

function Copy-LedgerFileBytesIntoExistingFile {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

    Assert-LedgerNoExistingReparsePath -Path $SourcePath
    Assert-LedgerNoExistingReparsePath -Path $DestinationPath
    $sourceStream = $null
    $destinationStream = $null
    try {
        $sourceStream = [IO.File]::Open($SourcePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $destinationStream = [IO.File]::Open($DestinationPath, [IO.FileMode]::Truncate, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $sourceStream.CopyTo($destinationStream)
        $destinationStream.Flush($true)
    } finally {
        if ($null -ne $destinationStream) { $destinationStream.Dispose() }
        if ($null -ne $sourceStream) { $sourceStream.Dispose() }
    }
}

function Get-LedgerFileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Invoke-LedgerSqliteVerifier {
    param(
        [Parameter(Mandatory = $true)][string]$NodeExecutablePath,
        [Parameter(Mandatory = $true)][string]$VerifierPath,
        [Parameter(Mandatory = $true)][string]$DatabasePath,
        [string]$BackupPath
    )

    $arguments = @($VerifierPath, '--database', $DatabasePath)
    if (-not [string]::IsNullOrWhiteSpace($BackupPath)) {
        $arguments += @('--backup-to', $BackupPath)
    }
    $output = & $NodeExecutablePath @arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw 'SQLite verification failed.'
    }
    try {
        $verification = ([string]::Join("`n", [string[]]@($output))) | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw 'SQLite verification returned an invalid status.'
    }
    if ($verification.status -cne 'verified' -or $verification.headerValid -ne $true -or $verification.quickCheck -cne 'ok') {
        throw 'SQLite verification failed.'
    }
    return $verification
}
