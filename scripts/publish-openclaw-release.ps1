[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$SourceRoot,
    [string]$ReleaseRoot = 'D:\Clawbot\releases',
    [string]$BackupRoot = (Join-Path $env:USERPROFILE '.openclaw\backups'),
    [string]$OpenClawConfigPath = (Join-Path $env:USERPROFILE '.openclaw\openclaw.json'),
    [string]$GitExecutable = 'git',
    [string]$NpmExecutable = 'npm.cmd',
    [string]$NodeExecutable = 'node',
    [string]$OpenClawExecutable = 'openclaw',
    [string]$AclExecutable,
    [switch]$ReleaseOnly,
    [switch]$SwitchOpenClaw,
    [string]$ExistingReleasePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:StrictUtf8Encoding = [Text.UTF8Encoding]::new($false, $true)
$script:SupportedOpenClawVersion = '2026.8.2'

# Windows PowerShell 5.1 does not initialize $PSScriptRoot while evaluating
# parameter default expressions. Resolve this default only after param binding.
if ([string]::IsNullOrWhiteSpace($SourceRoot)) {
    $SourceRoot = Split-Path -Parent $PSScriptRoot
}

function Get-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
}

function Get-WindowsExtendedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = Get-FullPath -Path $Path
    if ($fullPath.StartsWith('\\?\', [StringComparison]::Ordinal)) { return $fullPath }
    if ($fullPath.StartsWith('\\', [StringComparison]::Ordinal)) {
        return '\\?\UNC\' + $fullPath.Substring(2)
    }
    return '\\?\' + $fullPath
}

function Test-PathInside {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $candidatePath = Get-FullPath -Path $Candidate
    $rootPath = Get-FullPath -Path $Root
    if ([string]::Equals($candidatePath, $rootPath, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    $prefix = $rootPath + [IO.Path]::DirectorySeparatorChar
    return $candidatePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Test-ReparsePoint {
    param([Parameter(Mandatory = $true)][IO.FileSystemInfo]$Item)

    return (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Test-RedirectingReparsePoint {
    param([Parameter(Mandatory = $true)][IO.FileSystemInfo]$Item)

    if (-not (Test-ReparsePoint -Item $Item)) { return $false }
    $linkTypeProperty = $Item.PSObject.Properties['LinkType']
    $targetProperty = $Item.PSObject.Properties['Target']
    return (($null -ne $linkTypeProperty -and -not [string]::IsNullOrWhiteSpace([string]$linkTypeProperty.Value)) -or
        ($null -ne $targetProperty -and -not [string]::IsNullOrWhiteSpace([string]($targetProperty.Value -join ''))))
}

function Assert-ExistingPathIsNotReparsePoint {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not [IO.Directory]::Exists($Path) -and -not [IO.File]::Exists($Path)) {
        throw 'A required source path is missing.'
    }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (Test-RedirectingReparsePoint -Item $item) {
        throw 'A required source path is a reparse point.'
    }
}

function Assert-NoExistingReparsePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $current = [IO.Path]::GetFullPath($Path)
    while (-not [string]::IsNullOrWhiteSpace($current)) {
        if ([IO.Directory]::Exists($current) -or [IO.File]::Exists($current)) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if (Test-ReparsePoint -Item $item) {
                throw 'A protected release, backup, or config path contains a reparse point.'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current.TrimEnd([char[]]@('\', '/')))
        if ([string]::IsNullOrWhiteSpace($parent) -or [string]::Equals($parent, $current, [StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $current = $parent
    }
}

function Assert-DirectoryTreeHasNoReparsePoints {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$FailureMessage = 'A protected directory tree contains a reparse point.'
    )

    Assert-NoExistingReparsePath -Path $Path
    if (-not [IO.Directory]::Exists($Path)) { return }
    $root = Get-WindowsExtendedPath -Path $Path
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($root)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($entryPath in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
            $attributes = [IO.File]::GetAttributes($entryPath)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw $FailureMessage
            }
            if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
                $pending.Push($entryPath)
            }
        }
    }
}

function Read-StrictUtf8 {
    param([Parameter(Mandatory = $true)][string]$Path)

    try {
        return [IO.File]::ReadAllText($Path, $script:StrictUtf8Encoding)
    } catch {
        throw 'A required JSON or commit file is not valid UTF-8.'
    }
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $algorithm.ComputeHash($stream)
        return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Get-RelativeChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Child
    )

    $rootPath = Get-FullPath -Path $Root
    $childPath = Get-FullPath -Path $Child
    $prefix = $rootPath + [IO.Path]::DirectorySeparatorChar
    if (-not $childPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A source entry resolved outside its component root.'
    }
    return $childPath.Substring($prefix.Length).Replace('\', '/')
}

function Test-IgnoredPath {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath,
        [Parameter(Mandatory = $true)][string[]]$IgnoredDirectories
    )

    foreach ($ignoredDirectory in $IgnoredDirectories) {
        if ([string]::Equals($RelativePath, $ignoredDirectory, [StringComparison]::OrdinalIgnoreCase) -or
            $RelativePath.StartsWith($ignoredDirectory + '/', [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Get-SafeSourceFiles {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [string[]]$IgnoredDirectories = @()
    )

    if (-not [IO.Directory]::Exists($Root)) {
        throw 'A required source component is missing.'
    }
    $rootItem = Get-Item -LiteralPath $Root -Force -ErrorAction Stop
    if (Test-RedirectingReparsePoint -Item $rootItem) {
        throw 'A source component root is a reparse point.'
    }

    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $files = New-Object 'System.Collections.Generic.List[object]'
    $stage = 'initialization'
    try {
        $pending.Push($Root)
        while ($pending.Count -gt 0) {
            $directory = $pending.Pop()
            $stage = 'enumeration'
            foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
                $stage = 'reparse validation'
                if (Test-RedirectingReparsePoint -Item $item) {
                    throw 'A source component contains a reparse-point entry.'
                }
                $stage = 'relative path validation'
                $relativePath = Get-RelativeChildPath -Root $Root -Child $item.FullName
                if ($item.PSIsContainer) {
                    $stage = 'ignored directory validation'
                    if (-not (Test-IgnoredPath -RelativePath $relativePath -IgnoredDirectories $IgnoredDirectories)) {
                        $pending.Push($item.FullName)
                    }
                } else {
                    $stage = 'file collection'
                    $files.Add([PSCustomObject]@{
                        FullName = $item.FullName
                        RelativePath = $relativePath
                    })
                }
            }
        }
    } catch {
        if ($_.Exception.Message -like 'A source component*') { throw }
        throw ('Source traversal failed during ' + $stage + '.')
    }
    return $files.ToArray()
}

function Test-ForbiddenArtifactName {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $leaf = [IO.Path]::GetFileName($RelativePath)
    if ($leaf -imatch '\.(db|db-wal|db-shm|sqlite|sqlite3|log|pem|key)$') {
        return $true
    }
    if ($leaf -imatch '^\.env($|\.)') {
        return $true
    }
    return ($leaf -imatch '(^|[._-])(secret|token|credential|transcript|session)([._-]|$)')
}

function Copy-AllowedSourceFile {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $destinationPath = Join-Path $DestinationRoot ($RelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar))
    $destinationDirectory = Split-Path -Parent $destinationPath
    $null = New-Item -ItemType Directory -Path $destinationDirectory -Force
    [IO.File]::Copy($SourcePath, $destinationPath, $false)
}

function Copy-BookkeepingSource {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

    $requiredFiles = @(
        'adapter.mjs',
        'bookkeeping-core.mjs',
        'categories.mjs',
        'expense-summary.mjs',
        'index.ts',
        'mcp-connection.mjs',
        'openclaw.plugin.json',
        'package.json',
        'package-lock.json'
    )
    $required = @{}
    foreach ($name in $requiredFiles) { $required[$name.ToLowerInvariant()] = $false }

    foreach ($file in @(Get-SafeSourceFiles -Root $SourcePath -IgnoredDirectories @('test', 'node_modules', '.git'))) {
        $key = $file.RelativePath.ToLowerInvariant()
        if ($required.ContainsKey($key)) {
            $required[$key] = $true
            Copy-AllowedSourceFile -SourcePath $file.FullName -DestinationRoot $DestinationPath -RelativePath $file.RelativePath
            continue
        }
        if (Test-ForbiddenArtifactName -RelativePath $file.RelativePath) {
            throw 'The bookkeeping source contains a forbidden data, log, credential, or state artifact.'
        }
        throw 'The bookkeeping source contains an unsupported file.'
    }
    if (@($required.GetEnumerator() | Where-Object { -not $_.Value }).Count -gt 0) {
        throw 'The bookkeeping source is missing a required allowlisted file.'
    }
}

function Copy-StableIdSource {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

    $requiredFiles = @('package.json', 'package-lock.json', 'openclaw.plugin.json', 'dist/index.js')
    $required = @{}
    foreach ($name in $requiredFiles) { $required[$name.ToLowerInvariant()] = $false }
    $ignoredFiles = @(
        'index.ts',
        'license',
        'readme.md',
        'readme.zh_cn.md',
        'changelog.md',
        'changelog.zh_cn.md',
        'clawbot-patch.md',
        'tsconfig.json'
    )
    $ignored = @{}
    foreach ($name in $ignoredFiles) { $ignored[$name.ToLowerInvariant()] = $true }

    foreach ($file in @(Get-SafeSourceFiles -Root $SourcePath -IgnoredDirectories @('src', 'test', 'node_modules', '.git'))) {
        $key = $file.RelativePath.ToLowerInvariant()
        $isCompiledFile = $key.StartsWith('dist/') -and ($key.EndsWith('.js') -or $key.EndsWith('.js.map'))
        if ($required.ContainsKey($key)) {
            $required[$key] = $true
        }
        if ($required.ContainsKey($key) -or $isCompiledFile) {
            Copy-AllowedSourceFile -SourcePath $file.FullName -DestinationRoot $DestinationPath -RelativePath $file.RelativePath
            continue
        }
        if ($ignored.ContainsKey($key)) {
            continue
        }
        if (Test-ForbiddenArtifactName -RelativePath $file.RelativePath) {
            throw 'The stable-ID source contains a forbidden data, log, credential, or state artifact.'
        }
        throw 'The stable-ID source contains an unsupported file.'
    }
    if (@($required.GetEnumerator() | Where-Object { -not $_.Value }).Count -gt 0) {
        throw 'The stable-ID source is missing a required allowlisted file.'
    }
}

function Copy-WorkspaceSource {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

    $requiredFiles = @('AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md')
    $required = @{}
    foreach ($name in $requiredFiles) { $required[$name.ToLowerInvariant()] = $false }

    foreach ($file in @(Get-SafeSourceFiles -Root $SourcePath -IgnoredDirectories @('memory', '.git'))) {
        $key = $file.RelativePath.ToLowerInvariant()
        if ($required.ContainsKey($key)) {
            $required[$key] = $true
            Copy-AllowedSourceFile -SourcePath $file.FullName -DestinationRoot $DestinationPath -RelativePath $file.RelativePath
            continue
        }
        if (Test-ForbiddenArtifactName -RelativePath $file.RelativePath) {
            throw 'The workspace source contains a forbidden data, log, credential, or state artifact.'
        }
        throw 'The workspace source contains an unsupported file.'
    }
    if (@($required.GetEnumerator() | Where-Object { -not $_.Value }).Count -gt 0) {
        throw 'The workspace source is missing a required allowlisted file.'
    }
}

function Invoke-ExternalCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$FailureMessage,
        [string]$WorkingDirectory
    )

    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        Push-Location -LiteralPath $WorkingDirectory
    }
    try {
        $global:LASTEXITCODE = 0
        $previousConsoleOut = [Console]::Out
        $previousConsoleError = [Console]::Error
        try {
            [Console]::SetOut([IO.TextWriter]::Null)
            [Console]::SetError([IO.TextWriter]::Null)
            $capturedOutput = @(& $Executable @Arguments *>&1)
        } catch {
            throw $FailureMessage
        } finally {
            [Console]::SetOut($previousConsoleOut)
            [Console]::SetError($previousConsoleError)
        }
        if ($LASTEXITCODE -ne 0) {
            throw $FailureMessage
        }
        return $capturedOutput
    } finally {
        if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
            Pop-Location
        }
    }
}

function Invoke-OpenClawCommandForConfig {
    param(
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    $previousConfigPath = [Environment]::GetEnvironmentVariable('OPENCLAW_CONFIG_PATH', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('OPENCLAW_CONFIG_PATH', $ConfigPath, 'Process')
        return Invoke-ExternalCommand -Executable $OpenClawExecutable -Arguments $Arguments -FailureMessage $FailureMessage
    } finally {
        [Environment]::SetEnvironmentVariable('OPENCLAW_CONFIG_PATH', $previousConfigPath, 'Process')
    }
}

function Get-OpenClawCliVersion {
    $versionOutput = @(Invoke-ExternalCommand -Executable $OpenClawExecutable -Arguments @('--version') -FailureMessage 'The OpenClaw CLI version check failed.')
    $versionText = ([string]::Join("`n", [string[]]$versionOutput)).Trim()
    if ($versionText -cnotmatch '^OpenClaw ([0-9]+(?:\.[0-9]+){2}(?:[-+][0-9A-Za-z.-]+)?)(?: \([0-9A-Za-z._-]+\))?$') {
        throw 'The OpenClaw CLI returned an invalid version marker.'
    }
    $version = [string]$Matches[1]
    if ($version -cne $script:SupportedOpenClawVersion) {
        throw 'The installed OpenClaw CLI version is outside the verified compatibility baseline.'
    }
    return $version
}

function Assert-OpenClawWeixinChannelStatus {
    param([Parameter(Mandatory = $true)][object[]]$Output)

    try {
        $status = ([string]::Join("`n", [string[]]@($Output))) | ConvertFrom-Json -ErrorAction Stop
        $accountsProperty = $status.channelAccounts.PSObject.Properties['openclaw-weixin']
        $defaultProperty = $status.channelDefaultAccountId.PSObject.Properties['openclaw-weixin']
        if ($null -eq $accountsProperty -or $null -eq $defaultProperty) { throw 'invalid' }
        $accounts = @($accountsProperty.Value)
        $defaultAccountId = [string]$defaultProperty.Value
        if ([string]::IsNullOrWhiteSpace($defaultAccountId)) { throw 'invalid' }
        $defaultAccounts = @($accounts | Where-Object {
            $null -ne $_ -and
            $null -ne $_.PSObject.Properties['accountId'] -and
            [string]::Equals([string]$_.accountId, $defaultAccountId, [StringComparison]::Ordinal)
        })
        if ($defaultAccounts.Count -ne 1) { throw 'invalid' }
        $account = $defaultAccounts[0]
        foreach ($name in @('enabled', 'configured', 'running', 'restartPending', 'lastError')) {
            if ($null -eq $account.PSObject.Properties[$name]) { throw 'invalid' }
        }
        if ($account.enabled -ne $true -or
            $account.configured -ne $true -or
            $account.running -ne $true -or
            $account.restartPending -ne $false -or
            $null -ne $account.lastError) {
            throw 'invalid'
        }
        $probeProperty = $account.PSObject.Properties['probe']
        if ($null -ne $probeProperty -and $null -ne $probeProperty.Value) {
            $probeOkProperty = $probeProperty.Value.PSObject.Properties['ok']
            if ($null -eq $probeOkProperty -or $probeOkProperty.Value -ne $true) { throw 'invalid' }
        }
    } catch {
        throw 'The OpenClaw WeChat channel status was not healthy.'
    }
}

function Get-CleanGitCommit {
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot)

    $safeDirectory = 'safe.directory=' + $RepositoryRoot
    $statusOutput = @(Invoke-ExternalCommand -Executable $GitExecutable -Arguments @('-c', $safeDirectory, '-C', $RepositoryRoot, 'status', '--porcelain') -FailureMessage 'Git source status failed.')
    if (-not [string]::IsNullOrWhiteSpace(($statusOutput -join "`n"))) {
        throw 'The release source must be clean; dirty or untracked files are not allowed.'
    }
    $headOutput = @(Invoke-ExternalCommand -Executable $GitExecutable -Arguments @('-c', $safeDirectory, '-C', $RepositoryRoot, 'rev-parse', '--verify', 'HEAD') -FailureMessage 'Git commit lookup failed.')
    $commit = ($headOutput -join '').Trim().ToLowerInvariant()
    if ($commit -cnotmatch '^[0-9a-f]{40}([0-9a-f]{24})?$') {
        throw 'The release source must resolve to a full hexadecimal Git commit.'
    }
    return $commit
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Value
    )

    [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false)))
}

function Get-ReleasePayloadFiles {
    param([Parameter(Mandatory = $true)][string]$Root)

    $rootItem = Get-Item -LiteralPath $Root -Force -ErrorAction Stop
    if (Test-ReparsePoint -Item $rootItem) {
        throw 'The staged release root cannot be a reparse point.'
    }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $files = New-Object 'System.Collections.Generic.List[string]'
    $pending.Push($Root)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if (Test-ReparsePoint -Item $item) {
                throw 'The staged release contains a reparse-point entry.'
            }
            if ($item.PSIsContainer) {
                $pending.Push($item.FullName)
            } elseif ($item.Name -cne 'release-manifest.json' -or (Get-FullPath -Path $item.DirectoryName) -cne (Get-FullPath -Path $Root)) {
                $files.Add($item.FullName)
            }
        }
    }
    return $files.ToArray()
}

function Write-ReleaseManifest {
    param([Parameter(Mandatory = $true)][string]$StagingRoot)

    $entries = New-Object 'System.Collections.Generic.List[object]'
    [string[]]$payloadFiles = @(Get-ReleasePayloadFiles -Root $StagingRoot)
    [Array]::Sort($payloadFiles, [StringComparer]::Ordinal)
    foreach ($filePath in $payloadFiles) {
        $relativePath = Get-RelativeChildPath -Root $StagingRoot -Child $filePath
        $fileInfo = Get-Item -LiteralPath $filePath -Force -ErrorAction Stop
        $entries.Add([PSCustomObject][ordered]@{
            path = $relativePath
            length = [long]$fileInfo.Length
            sha256 = Get-Sha256 -Path $filePath
        })
    }
    if ($entries.Count -eq 0) {
        throw 'The staged release contains no payload files.'
    }
    $manifestJson = ConvertTo-Json -InputObject $entries.ToArray() -Depth 4
    Write-Utf8NoBom -Path (Join-Path $StagingRoot 'release-manifest.json') -Value ($manifestJson + "`n")
}

function Protect-ReleaseTree {
    param([Parameter(Mandatory = $true)][string]$Path)

    Assert-DirectoryTreeHasNoReparsePoints -Path $Path -FailureMessage 'The release tree contains a reparse point before ACL hardening.'
    if (-not [string]::IsNullOrWhiteSpace($AclExecutable)) {
        $null = Invoke-ExternalCommand -Executable $AclExecutable -Arguments @('protect-release', $Path) -FailureMessage 'Protecting the immutable release ACL failed.'
        return
    }

    $identity = $null
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        if ($null -eq $identity.User) { throw 'missing runtime identity' }
        $runtimeSid = $identity.User
        $systemSid = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
        $administratorsSid = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)

        $items = @((Get-Item -LiteralPath $Path -Force -ErrorAction Stop))
        $items += @(Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction Stop)
        $items = @($items | Sort-Object { $_.FullName.Length } -Descending)
        foreach ($item in $items) {
            if (Test-ReparsePoint -Item $item) { throw 'reparse point' }
            if ($item.PSIsContainer) {
                $acl = New-Object Security.AccessControl.DirectorySecurity
                $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
            } else {
                $acl = New-Object Security.AccessControl.FileSecurity
                $inheritance = [Security.AccessControl.InheritanceFlags]::None
            }
            $acl.SetOwner($administratorsSid)
            $acl.SetAccessRuleProtection($true, $false)
            $propagation = [Security.AccessControl.PropagationFlags]::None
            $allow = [Security.AccessControl.AccessControlType]::Allow
            $null = $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($systemSid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow)))
            $null = $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($administratorsSid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow)))
            if ($runtimeSid.Value -cne $systemSid.Value -and $runtimeSid.Value -cne $administratorsSid.Value) {
                $null = $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($runtimeSid, [Security.AccessControl.FileSystemRights]::ReadAndExecute, $inheritance, $propagation, $allow)))
            }
            Set-Acl -LiteralPath $item.FullName -AclObject $acl -ErrorAction Stop
        }
    } catch {
        throw 'Protecting the immutable release ACL failed.'
    } finally {
        if ($null -ne $identity) { $identity.Dispose() }
    }
}

function Assert-Release {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$ExpectedCommit
    )

    $verifyScript = Join-Path $PSScriptRoot 'verify-openclaw-release.ps1'
    if (-not [string]::IsNullOrWhiteSpace($ExpectedCommit)) {
        $null = & $verifyScript -ReleasePath $Path -ExpectedCommit $ExpectedCommit -AclExecutable $AclExecutable
    } else {
        $null = & $verifyScript -ReleasePath $Path -AclExecutable $AclExecutable
    }
}

function Assert-ReleaseModules {
    param([Parameter(Mandatory = $true)][string]$ReleasePath)

    $bookkeepingPath = Join-Path $ReleasePath 'openclaw-plugins\clawbot-bookkeeping'
    $stablePath = Join-Path $ReleasePath 'openclaw-plugins\openclaw-weixin-stable-id'
    $bookkeepingValidation = @'
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
const root = process.argv.at(-1);
const requireFromRelease = createRequire(join(root, "package.json"));
const typeboxRoot = join(root, "node_modules", "typebox");
const typeboxPath = requireFromRelease.resolve("typebox");
const typeboxRelative = relative(typeboxRoot, typeboxPath);
if (typeboxRelative.startsWith("..") || typeboxRelative === "") throw new Error("typebox did not resolve from the release");
if (existsSync(join(root, "node_modules", "openclaw"))) throw new Error("bookkeeping peer is bundled in the release");
'@
    $null = Invoke-ExternalCommand -Executable $NodeExecutable -Arguments @('--input-type=module', '-e', $bookkeepingValidation, $bookkeepingPath) -FailureMessage 'The bookkeeping release module-resolution validation failed.'

    $stableValidation = @'
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv.at(-1);
const requireFromRelease = createRequire(join(root, "package.json"));
for (const [specifier, packageName] of [["zod", "zod"], ["qrcode-terminal", "qrcode-terminal"], ["openclaw/plugin-sdk/channel-config-schema", "openclaw"]]) {
  const packageRoot = join(root, "node_modules", packageName);
  const resolvedPath = requireFromRelease.resolve(specifier);
  const resolvedRelative = relative(packageRoot, resolvedPath);
  if (resolvedRelative.startsWith("..") || resolvedRelative === "") throw new Error(`${specifier} did not resolve from the release`);
}
await import(pathToFileURL(join(root, "dist", "index.js")).href);
'@
    $null = Invoke-ExternalCommand -Executable $NodeExecutable -Arguments @('--input-type=module', '-e', $stableValidation, $stablePath) -FailureMessage 'The stable-ID release module-resolution validation failed.'
}

function Remove-OwnedStagingDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    if (-not [IO.Directory]::Exists($Path)) { return }
    $parentPath = Get-FullPath -Path $Parent
    $ownedPath = Get-FullPath -Path $Path
    $pathParent = Get-FullPath -Path (Split-Path -Parent $ownedPath)
    $leaf = Split-Path -Leaf $ownedPath
    if (-not [string]::Equals($parentPath, $pathParent, [StringComparison]::OrdinalIgnoreCase) -or
        -not $leaf.StartsWith('.staging-', [StringComparison]::Ordinal)) {
        throw 'Refusing to clean an unowned staging directory.'
    }

    Assert-NoExistingReparsePath -Path $parentPath
    try {
        Assert-DirectoryTreeHasNoReparsePoints -Path $ownedPath -FailureMessage 'Suspicious staging contains a reparse point and was preserved.'
    } catch {
        throw
    }

    Assert-NoExistingReparsePath -Path $ownedPath
    [IO.Directory]::Delete((Get-WindowsExtendedPath -Path $ownedPath), $true)
}

function Publish-Release {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$ReleasesRoot
    )

    Assert-ExistingPathIsNotReparsePoint -Path $RepositoryRoot
    $commitBeforeBuild = Get-CleanGitCommit -RepositoryRoot $RepositoryRoot
    $stableSource = Join-Path $RepositoryRoot 'openclaw-plugins\openclaw-weixin-stable-id'
    Assert-ExistingPathIsNotReparsePoint -Path $stableSource
    $null = Invoke-ExternalCommand -Executable $NpmExecutable -Arguments @('run', 'build') -FailureMessage 'The stable-ID build failed.' -WorkingDirectory $stableSource
    $commitAfterBuild = Get-CleanGitCommit -RepositoryRoot $RepositoryRoot
    if ($commitAfterBuild -cne $commitBeforeBuild) {
        throw 'The Git HEAD commit changed during the stable-ID build.'
    }

    $releasePath = Join-Path $ReleasesRoot $commitAfterBuild
    if ([IO.Directory]::Exists($releasePath) -or [IO.File]::Exists($releasePath)) {
        throw 'The immutable release already exists.'
    }
    $null = New-Item -ItemType Directory -Path $ReleasesRoot -Force
    Assert-DirectoryTreeHasNoReparsePoints -Path $ReleasesRoot -FailureMessage 'The release root contains a reparse point.'
    $stagingContainer = Join-Path $ReleasesRoot ('.staging-' + [guid]::NewGuid().ToString('N'))
    $stagingPath = Join-Path $stagingContainer $commitAfterBuild
    if ([IO.Directory]::Exists($stagingContainer) -or [IO.File]::Exists($stagingContainer)) {
        throw 'The release staging path already exists.'
    }
    $null = New-Item -ItemType Directory -Path $stagingPath -Force

    try {
        $bookkeepingDestination = Join-Path $stagingPath 'openclaw-plugins\clawbot-bookkeeping'
        $stableDestination = Join-Path $stagingPath 'openclaw-plugins\openclaw-weixin-stable-id'
        $workspaceDestination = Join-Path $stagingPath 'openclaw-workspace'
        Copy-BookkeepingSource -SourcePath (Join-Path $RepositoryRoot 'openclaw-plugins\clawbot-bookkeeping') -DestinationPath $bookkeepingDestination
        Copy-StableIdSource -SourcePath $stableSource -DestinationPath $stableDestination
        Copy-WorkspaceSource -SourcePath (Join-Path $RepositoryRoot 'openclaw-workspace') -DestinationPath $workspaceDestination

        $null = Invoke-ExternalCommand -Executable $NpmExecutable -Arguments @('ci', '--omit=dev', '--omit=peer', '--ignore-scripts') -FailureMessage 'Installing locked bookkeeping runtime dependencies failed.' -WorkingDirectory $bookkeepingDestination
        if (-not [IO.File]::Exists((Join-Path $bookkeepingDestination 'node_modules\typebox\package.json'))) {
            throw 'The bookkeeping release is missing its locked typebox runtime dependency.'
        }
        if ([IO.Directory]::Exists((Join-Path $bookkeepingDestination 'node_modules\openclaw'))) {
            throw 'The bookkeeping release unexpectedly contains its OpenClaw host peer.'
        }

        $null = Invoke-ExternalCommand -Executable $NpmExecutable -Arguments @('ci', '--omit=dev', '--ignore-scripts') -FailureMessage 'Installing locked stable-ID runtime dependencies failed.' -WorkingDirectory $stableDestination

        Assert-ReleaseModules -ReleasePath $stagingPath

        Write-Utf8NoBom -Path (Join-Path $stagingPath 'release-commit.txt') -Value ($commitAfterBuild + "`n")
        Write-ReleaseManifest -StagingRoot $stagingPath
        Protect-ReleaseTree -Path $stagingPath
        Assert-Release -Path $stagingPath -ExpectedCommit $commitAfterBuild

        Assert-DirectoryTreeHasNoReparsePoints -Path $ReleasesRoot -FailureMessage 'The release root or staging tree contains a reparse point; staging was preserved.'
        $commitBeforePublish = Get-CleanGitCommit -RepositoryRoot $RepositoryRoot
        if ($commitBeforePublish -cne $commitBeforeBuild) {
            throw 'The Git HEAD commit changed before atomic release publication.'
        }
        Assert-NoExistingReparsePath -Path $ReleasesRoot
        Assert-NoExistingReparsePath -Path $stagingPath
        if ([IO.Directory]::Exists($releasePath) -or [IO.File]::Exists($releasePath)) {
            throw 'The immutable release already exists.'
        }
        [IO.Directory]::Move($stagingPath, $releasePath)
        Remove-OwnedStagingDirectory -Path $stagingContainer -Parent $ReleasesRoot
        Assert-Release -Path $releasePath -ExpectedCommit $commitAfterBuild
        return $releasePath
    } catch {
        $publicationError = $_
        if ([IO.Directory]::Exists($stagingContainer)) {
            try {
                Remove-OwnedStagingDirectory -Path $stagingContainer -Parent $ReleasesRoot
            } catch {
                $cleanupFailureType = $_.Exception.GetType().Name
                throw ('OpenClaw release publication failed and its owned staging cleanup also failed (' + $cleanupFailureType + ').')
            }
        }
        throw $publicationError
    }
}

function ConvertTo-CanonicalValue {
    param($Value)

    if ($null -eq $Value) { return $null }
    if ($Value -is [string] -or $Value -is [ValueType]) { return $Value }
    if ($Value -is [PSCustomObject]) {
        $ordered = [ordered]@{}
        foreach ($property in @($Value.PSObject.Properties | Sort-Object Name)) {
            $ordered[$property.Name] = ConvertTo-CanonicalValue -Value $property.Value
        }
        return [PSCustomObject]$ordered
    }
    if ($Value -is [Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($key in @($Value.Keys | Sort-Object)) {
            $ordered[[string]$key] = ConvertTo-CanonicalValue -Value $Value[$key]
        }
        return [PSCustomObject]$ordered
    }
    if ($Value -is [Collections.IEnumerable] -and $Value -isnot [string]) {
        [object[]]$items = @($Value | ForEach-Object { ConvertTo-CanonicalValue -Value $_ })
        Write-Output -NoEnumerate $items
        return
    }
    return $Value
}

function ConvertTo-CanonicalJson {
    param($Value)

    return (ConvertTo-Json -InputObject (ConvertTo-CanonicalValue -Value $Value) -Depth 100 -Compress)
}

function Assert-OfficialCodexPin {
    param([Parameter(Mandatory = $true)]$Config)

    try {
        $bookkeeper = $Config.agents.entries.bookkeeper
        $fallbackProperties = @($bookkeeper.model.PSObject.Properties | Where-Object { $_.Name -ceq 'fallbacks' })
        if ($bookkeeper.model.primary -cne 'openai/gpt-5.6-sol' -or
            $bookkeeper.models.'openai/gpt-5.6-sol'.agentRuntime.id -cne 'codex' -or
            $fallbackProperties.Count -gt 1 -or
            ($fallbackProperties.Count -eq 1 -and @($fallbackProperties[0].Value).Count -ne 0)) {
            throw 'invalid'
        }
    } catch {
        throw 'The bookkeeper is not pinned to the approved official Codex harness.'
    }
}

function Assert-OpenClawModelPolicyMigrationComplete {
    param([Parameter(Mandatory = $true)]$Config)

    try {
        $lastTouchedVersion = $Config.meta.lastTouchedVersion
        if ($lastTouchedVersion -isnot [string] -or
            $lastTouchedVersion -cnotmatch '^[0-9]+(?:\.[0-9]+){2}$' -or
            ([Version]$lastTouchedVersion) -gt ([Version]$script:SupportedOpenClawVersion) -or
            $Config.meta.migrations.modelPolicyAllowlist -isnot [bool] -or
            $Config.meta.migrations.modelPolicyAllowlist -ne $true) {
            throw 'invalid'
        }
    } catch {
        throw 'The OpenClaw config metadata is outside the verified migration baseline; automatic config materialization was refused.'
    }
}

function Get-OwnerAllowlistFingerprint {
    param([Parameter(Mandatory = $true)]$Config)

    try {
        $allowlist = $Config.commands.ownerAllowFrom
        if ($null -eq $allowlist -or $allowlist -isnot [Array]) { throw 'missing' }
        return ConvertTo-CanonicalJson -Value $allowlist
    } catch {
        throw 'The OpenClaw owner allowlist is missing or invalid.'
    }
}

function Protect-PrivateFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not [string]::IsNullOrWhiteSpace($AclExecutable)) {
        $null = Invoke-ExternalCommand -Executable $AclExecutable -Arguments @('protect', $Path) -FailureMessage 'Protecting a private OpenClaw file ACL failed.'
        return
    }

    $identity = $null
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        if ($null -eq $identity.User) { throw 'missing identity' }
        $acl = New-Object Security.AccessControl.FileSecurity
        $acl.SetOwner($identity.User)
        $acl.SetAccessRuleProtection($true, $false)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $identity.User,
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.AccessControlType]::Allow
        )
        $null = $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
    } catch {
        throw 'Protecting a private OpenClaw file ACL failed.'
    } finally {
        if ($null -ne $identity) { $identity.Dispose() }
    }
}

function Assert-PrivateFileAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not [string]::IsNullOrWhiteSpace($AclExecutable)) {
        $null = Invoke-ExternalCommand -Executable $AclExecutable -Arguments @('verify', $Path) -FailureMessage 'Verifying a private OpenClaw file ACL failed.'
        return
    }

    $identity = $null
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        if ($null -eq $identity.User) { throw 'missing identity' }
        $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
        $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
        $rules = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
        if (-not $acl.AreAccessRulesProtected -or
            $owner.Value -cne $identity.User.Value -or
            $rules.Count -ne 1 -or
            $rules[0].IsInherited -or
            $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rules[0].IdentityReference.Value -cne $identity.User.Value -or
            (($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)) {
            throw 'invalid ACL'
        }
    } catch {
        throw 'Verifying a private OpenClaw file ACL failed.'
    } finally {
        if ($null -ne $identity) { $identity.Dispose() }
    }
}

function Protect-PrivateDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not [string]::IsNullOrWhiteSpace($AclExecutable)) {
        $null = Invoke-ExternalCommand -Executable $AclExecutable -Arguments @('protect-directory', $Path) -FailureMessage 'Protecting a private OpenClaw directory ACL failed.'
        return
    }

    $identity = $null
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        if ($null -eq $identity.User) { throw 'missing identity' }
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetOwner($identity.User)
        $acl.SetAccessRuleProtection($true, $false)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $identity.User,
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        $null = $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
    } catch {
        throw 'Protecting a private OpenClaw directory ACL failed.'
    } finally {
        if ($null -ne $identity) { $identity.Dispose() }
    }
}

function Assert-PrivateDirectoryAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not [string]::IsNullOrWhiteSpace($AclExecutable)) {
        $null = Invoke-ExternalCommand -Executable $AclExecutable -Arguments @('verify-directory', $Path) -FailureMessage 'Verifying a private OpenClaw directory ACL failed.'
        return
    }

    $identity = $null
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        if ($null -eq $identity.User) { throw 'missing identity' }
        $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
        $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
        $rules = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
        if (-not $acl.AreAccessRulesProtected -or
            $owner.Value -cne $identity.User.Value -or
            $rules.Count -ne 1 -or
            $rules[0].IsInherited -or
            $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rules[0].IdentityReference.Value -cne $identity.User.Value -or
            (($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)) {
            throw 'invalid ACL'
        }
    } catch {
        throw 'Verifying a private OpenClaw directory ACL failed.'
    } finally {
        if ($null -ne $identity) { $identity.Dispose() }
    }
}

function New-ProtectedPrivateDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    Assert-NoExistingReparsePath -Path $Path
    if ([IO.Directory]::Exists($Path) -or [IO.File]::Exists($Path)) {
        throw 'The private OpenClaw staging path already exists.'
    }
    $null = [IO.Directory]::CreateDirectory($Path)
    try {
        Protect-PrivateDirectory -Path $Path
        Assert-PrivateDirectoryAcl -Path $Path
    } catch {
        if ([IO.Directory]::Exists($Path) -and @(Get-ChildItem -LiteralPath $Path -Force).Count -eq 0) {
            [IO.Directory]::Delete($Path, $false)
        }
        throw
    }
}

function Remove-PrivateFileIfPresent {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([IO.File]::Exists($Path)) {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer) {
            throw 'Refusing to recursively remove a private file path.'
        }
        [IO.File]::Delete($Path)
    }
}

function Get-OpenClawPrivateStagingFiles {
    param([Parameter(Mandatory = $true)][string]$DirectoryPath)

    Assert-NoExistingReparsePath -Path $DirectoryPath
    Assert-PrivateDirectoryAcl -Path $DirectoryPath
    $allowedNames = @{
        'openclaw.json' = $true
        'openclaw.json.bak' = $true
        'openclaw.json.bak.1' = $true
        'openclaw.json.bak.2' = $true
        'openclaw.json.bak.3' = $true
        'openclaw.json.bak.4' = $true
        'openclaw.json.pre-update' = $true
    }
    $files = New-Object 'System.Collections.Generic.List[IO.FileInfo]'
    foreach ($item in @(Get-ChildItem -LiteralPath $DirectoryPath -Force -ErrorAction Stop)) {
        if ($item.PSIsContainer -or (Test-ReparsePoint -Item $item)) {
            throw 'The private OpenClaw staging directory contains an unsafe entry.'
        }
        if (-not $allowedNames.ContainsKey($item.Name) -and
            $item.Name -cnotmatch '^openclaw\.json\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$') {
            throw 'The private OpenClaw staging directory contains an unexpected artifact.'
        }
        $files.Add($item)
    }
    return $files.ToArray()
}

function Protect-OpenClawPrivateStagingFiles {
    param([Parameter(Mandatory = $true)][string]$DirectoryPath)

    foreach ($file in @(Get-OpenClawPrivateStagingFiles -DirectoryPath $DirectoryPath)) {
        Protect-PrivateFile -Path $file.FullName
        Assert-PrivateFileAcl -Path $file.FullName
    }
}

function Remove-OpenClawPrivateStagingDirectory {
    param([Parameter(Mandatory = $true)][string]$DirectoryPath)

    if (-not [IO.Directory]::Exists($DirectoryPath)) { return }
    foreach ($file in @(Get-OpenClawPrivateStagingFiles -DirectoryPath $DirectoryPath)) {
        Protect-PrivateFile -Path $file.FullName
        Assert-PrivateFileAcl -Path $file.FullName
        Remove-PrivateFileIfPresent -Path $file.FullName
    }
    Assert-PrivateDirectoryAcl -Path $DirectoryPath
    [IO.Directory]::Delete($DirectoryPath, $false)
}

function New-ProtectedEmptyFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    Assert-NoExistingReparsePath -Path $Path
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $stream.Dispose()
    try {
        Protect-PrivateFile -Path $Path
        Assert-PrivateFileAcl -Path $Path
    } catch {
        Remove-PrivateFileIfPresent -Path $Path
        throw
    }
}

function Copy-FileBytesIntoExistingFile {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

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

function Write-ProtectedUtf8File {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Value
    )

    try {
        New-ProtectedEmptyFile -Path $Path
        $bytes = $script:StrictUtf8Encoding.GetBytes($Value)
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Truncate, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally {
            $stream.Dispose()
        }
        Assert-PrivateFileAcl -Path $Path
    } catch {
        Remove-PrivateFileIfPresent -Path $Path
        throw
    }
}

function New-VerifiedPrivateBackup {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$BackupPath,
        [Parameter(Mandatory = $true)][string]$ExpectedHash
    )

    $backupDirectory = Split-Path -Parent $BackupPath
    $temporaryPath = Join-Path $backupDirectory ('.openclaw-backup-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        New-ProtectedEmptyFile -Path $temporaryPath
        Copy-FileBytesIntoExistingFile -SourcePath $SourcePath -DestinationPath $temporaryPath
        Assert-PrivateFileAcl -Path $temporaryPath
        if ((Get-Sha256 -Path $temporaryPath) -cne $ExpectedHash) {
            throw 'The OpenClaw configuration backup failed verification.'
        }
        Assert-NoExistingReparsePath -Path $temporaryPath
        Assert-NoExistingReparsePath -Path $BackupPath
        [IO.File]::Move($temporaryPath, $BackupPath)
        Assert-NoExistingReparsePath -Path $BackupPath
        Assert-PrivateFileAcl -Path $BackupPath
        if ((Get-Sha256 -Path $BackupPath) -cne $ExpectedHash) {
            throw 'The OpenClaw configuration backup failed verification.'
        }
    } catch {
        Remove-PrivateFileIfPresent -Path $temporaryPath
        Remove-PrivateFileIfPresent -Path $BackupPath
        throw
    }
}

function Move-FileAtomicallyReplacingDestination {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath,
        [string]$ExpectedDestinationHash
    )

    if ($null -eq ('Clawbot.ReleaseNativeMethods' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Clawbot {
    public static class ReleaseNativeMethods {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool MoveFileEx(string existingFileName, string newFileName, int flags);
    }
}
'@
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedDestinationHash)) {
        if (-not [IO.File]::Exists($DestinationPath) -or
            (Get-Sha256 -Path $DestinationPath) -cne $ExpectedDestinationHash) {
            throw 'The destination changed immediately before atomic replacement.'
        }
    }
    if (-not [Clawbot.ReleaseNativeMethods]::MoveFileEx($SourcePath, $DestinationPath, 9)) {
        throw 'Atomic OpenClaw configuration restore failed.'
    }
}

function Restore-VerifiedConfigBackup {
    param(
        [Parameter(Mandatory = $true)][string]$BackupPath,
        [Parameter(Mandatory = $true)][string]$ExpectedHash,
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [string]$ExpectedCurrentHash
    )

    Assert-PrivateFileAcl -Path $BackupPath
    if ((Get-Sha256 -Path $BackupPath) -cne $ExpectedHash) {
        throw 'The configuration backup failed verification during rollback.'
    }
    $restoreTemp = Join-Path (Split-Path -Parent $ConfigPath) ('.openclaw-rollback-' + [guid]::NewGuid().ToString('N') + '.json')
    try {
        New-ProtectedEmptyFile -Path $restoreTemp
        Copy-FileBytesIntoExistingFile -SourcePath $BackupPath -DestinationPath $restoreTemp
        Assert-PrivateFileAcl -Path $restoreTemp
        if ((Get-Sha256 -Path $restoreTemp) -cne $ExpectedHash) {
            throw 'The rollback copy failed verification.'
        }
        Assert-NoExistingReparsePath -Path $ConfigPath
        if (-not [string]::IsNullOrWhiteSpace($ExpectedCurrentHash)) {
            if (-not [IO.File]::Exists($ConfigPath) -or
                (Get-Sha256 -Path $ConfigPath) -cne $ExpectedCurrentHash) {
                throw 'The live OpenClaw config changed while rollback was being prepared; automatic rollback was refused.'
            }
        }
        Move-FileAtomicallyReplacingDestination -SourcePath $restoreTemp -DestinationPath $ConfigPath -ExpectedDestinationHash $ExpectedCurrentHash
        Protect-PrivateFile -Path $ConfigPath
        Assert-PrivateFileAcl -Path $ConfigPath
        if ((Get-Sha256 -Path $ConfigPath) -cne $ExpectedHash) {
            throw 'The restored OpenClaw configuration failed verification.'
        }
    } finally {
        Remove-PrivateFileIfPresent -Path $restoreTemp
    }
}

function Get-ConfiguredReleaseRoot {
    param(
        [Parameter(Mandatory = $true)][string]$ConfiguredPath,
        [Parameter(Mandatory = $true)][string]$ComponentSuffix,
        [Parameter(Mandatory = $true)][string]$ReleasesRoot
    )

    $path = Get-FullPath -Path $ConfiguredPath
    $suffix = [IO.Path]::DirectorySeparatorChar + $ComponentSuffix.TrimStart([char[]]@('\', '/'))
    if (-not $path.EndsWith($suffix, [StringComparison]::OrdinalIgnoreCase)) {
        return $null
    }
    $candidateLength = $path.Length - $suffix.Length
    if ($candidateLength -le 0) { return $null }
    $candidate = Get-FullPath -Path $path.Substring(0, $candidateLength)
    $candidateParent = Get-FullPath -Path (Split-Path -Parent $candidate)
    if (-not [string]::Equals($candidateParent, (Get-FullPath -Path $ReleasesRoot), [StringComparison]::OrdinalIgnoreCase)) {
        return $null
    }
    return $candidate
}

function Switch-OpenClawRelease {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$ReleasePath,
        [Parameter(Mandatory = $true)][string]$ReleasesRoot,
        [Parameter(Mandatory = $true)][string]$ConfigPath,
        [Parameter(Mandatory = $true)][string]$BackupsRoot
    )

    Assert-NoExistingReparsePath -Path $ReleasesRoot
    Assert-Release -Path $ReleasePath
    Assert-ReleaseModules -ReleasePath $ReleasePath
    $releaseCommit = (Read-StrictUtf8 -Path (Join-Path $ReleasePath 'release-commit.txt')).Trim()
    if ($releaseCommit -cnotmatch '^[0-9a-f]{40}([0-9a-f]{24})?$') {
        throw 'The release commit marker is invalid.'
    }
    if (-not [IO.File]::Exists($ConfigPath)) {
        throw 'The OpenClaw configuration is missing.'
    }
    Assert-NoExistingReparsePath -Path $ConfigPath

    $configHash = Get-Sha256 -Path $ConfigPath
    $configText = Read-StrictUtf8 -Path $ConfigPath
    if ((Get-Sha256 -Path $ConfigPath) -cne $configHash) {
        throw 'The OpenClaw configuration changed while a stable migration snapshot was being read.'
    }
    try {
        $config = ConvertFrom-Json -InputObject $configText -ErrorAction Stop
        $candidate = ConvertFrom-Json -InputObject $configText -ErrorAction Stop
    } catch {
        throw 'The OpenClaw configuration is not valid JSON.'
    }
    Assert-OfficialCodexPin -Config $config
    Assert-OpenClawModelPolicyMigrationComplete -Config $config
    $ownerAllowlistBefore = Get-OwnerAllowlistFingerprint -Config $config

    $sourceBookkeeping = Join-Path $RepositoryRoot 'openclaw-plugins\clawbot-bookkeeping'
    $sourceStable = Join-Path $RepositoryRoot 'openclaw-plugins\openclaw-weixin-stable-id'
    $sourceWorkspace = Join-Path $RepositoryRoot 'openclaw-workspace'
    $releaseBookkeeping = Join-Path $ReleasePath 'openclaw-plugins\clawbot-bookkeeping'
    $releaseStable = Join-Path $ReleasePath 'openclaw-plugins\openclaw-weixin-stable-id'
    $releaseWorkspace = Join-Path $ReleasePath 'openclaw-workspace'

    try {
        $paths = @($candidate.plugins.load.paths)
        if ($paths.Count -eq 0) { throw 'invalid' }
    } catch {
        throw 'The OpenClaw plugin load path list is missing or invalid.'
    }
    $bookkeepingMatches = 0
    $stableMatches = 0
    $bookkeepingSourceKind = $null
    $stableSourceKind = $null
    $bookkeepingSourceRelease = $null
    $stableSourceRelease = $null
    $updatedPaths = New-Object 'System.Collections.Generic.List[object]'
    foreach ($path in $paths) {
        if ($path -isnot [string]) {
            throw 'The OpenClaw plugin load path list is invalid.'
        }
        if ([string]::Equals((Get-FullPath -Path $path), (Get-FullPath -Path $sourceBookkeeping), [StringComparison]::OrdinalIgnoreCase)) {
            $bookkeepingMatches++
            $bookkeepingSourceKind = 'repository'
            $updatedPaths.Add($releaseBookkeeping)
        } elseif ([string]::Equals((Get-FullPath -Path $path), (Get-FullPath -Path $sourceStable), [StringComparison]::OrdinalIgnoreCase)) {
            $stableMatches++
            $stableSourceKind = 'repository'
            $updatedPaths.Add($releaseStable)
        } else {
            $bookkeepingRoot = Get-ConfiguredReleaseRoot -ConfiguredPath $path -ComponentSuffix 'openclaw-plugins\clawbot-bookkeeping' -ReleasesRoot $ReleasesRoot
            $stableRoot = Get-ConfiguredReleaseRoot -ConfiguredPath $path -ComponentSuffix 'openclaw-plugins\openclaw-weixin-stable-id' -ReleasesRoot $ReleasesRoot
            if (-not [string]::IsNullOrWhiteSpace($bookkeepingRoot)) {
                $bookkeepingMatches++
                $bookkeepingSourceKind = 'release'
                $bookkeepingSourceRelease = $bookkeepingRoot
                $updatedPaths.Add($releaseBookkeeping)
            } elseif (-not [string]::IsNullOrWhiteSpace($stableRoot)) {
                $stableMatches++
                $stableSourceKind = 'release'
                $stableSourceRelease = $stableRoot
                $updatedPaths.Add($releaseStable)
            } else {
                Assert-NoExistingReparsePath -Path $path
                if (Test-PathInside -Candidate $path -Root $RepositoryRoot) {
                    throw 'The OpenClaw plugin load path list contains a residual Git checkout path.'
                }
                $updatedPaths.Add($path)
            }
        }
    }
    if ($bookkeepingMatches -ne 1 -or $stableMatches -ne 1) {
        throw 'The OpenClaw configuration does not contain exactly one known bookkeeping and stable-ID source.'
    }
    try {
        $workspace = [string]$candidate.agents.entries.bookkeeper.workspace
        $workspaceSourceKind = $null
        $workspaceSourceRelease = $null
        if ([string]::Equals((Get-FullPath -Path $workspace), (Get-FullPath -Path $sourceWorkspace), [StringComparison]::OrdinalIgnoreCase)) {
            $workspaceSourceKind = 'repository'
        } else {
            $workspaceSourceRelease = Get-ConfiguredReleaseRoot -ConfiguredPath $workspace -ComponentSuffix 'openclaw-workspace' -ReleasesRoot $ReleasesRoot
            if (-not [string]::IsNullOrWhiteSpace($workspaceSourceRelease)) {
                $workspaceSourceKind = 'release'
            }
        }
        $null = $candidate.plugins.entries.'clawbot-bookkeeping'.config.serverBaseUrl
    } catch {
        throw 'The configured bookkeeper workspace or plugin configuration is invalid.'
    }

    if ($bookkeepingSourceKind -ceq 'repository' -and
        $stableSourceKind -ceq 'repository' -and
        $workspaceSourceKind -ceq 'repository') {
        # Initial repository-to-release activation.
    } elseif ($bookkeepingSourceKind -ceq 'release' -and
        $stableSourceKind -ceq 'release' -and
        $workspaceSourceKind -ceq 'release' -and
        [string]::Equals($bookkeepingSourceRelease, $stableSourceRelease, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals($bookkeepingSourceRelease, $workspaceSourceRelease, [StringComparison]::OrdinalIgnoreCase)) {
        Assert-Release -Path $bookkeepingSourceRelease
        Assert-ReleaseModules -ReleasePath $bookkeepingSourceRelease
    } else {
        throw 'The configured plugin and workspace paths mix repository or different release sources.'
    }

    try {
        $currentServerBaseUrl = [string]$config.plugins.entries.'clawbot-bookkeeping'.config.serverBaseUrl
    } catch {
        throw 'The configured bookkeeping origin is missing or invalid.'
    }
    $requiresLegacyBootstrap = $currentServerBaseUrl -ceq 'http://127.0.0.1:8180'
    if (-not $requiresLegacyBootstrap -and $currentServerBaseUrl -cne 'http://127.0.0.1:8888') {
        throw 'The configured bookkeeping origin is not an approved exact loopback migration source.'
    }
    if ($requiresLegacyBootstrap -and
        ($bookkeepingSourceKind -cne 'repository' -or
         $stableSourceKind -cne 'repository' -or
         $workspaceSourceKind -cne 'repository')) {
        throw 'The legacy bookkeeping origin may be bootstrapped only from the exact repository source set.'
    }
    if ($requiresLegacyBootstrap) {
        $configVolume = [IO.Path]::GetPathRoot((Get-FullPath -Path $ConfigPath))
        $backupVolume = [IO.Path]::GetPathRoot((Get-FullPath -Path $BackupsRoot))
        if ([string]::IsNullOrWhiteSpace($configVolume) -or
            [string]::IsNullOrWhiteSpace($backupVolume) -or
            -not [string]::Equals($configVolume, $backupVolume, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The legacy bootstrap staging and OpenClaw config must remain on the same volume for atomic promotion.'
        }
    }
    $openClawVersion = Get-OpenClawCliVersion

    $legacyBaseline = $null
    if ($requiresLegacyBootstrap) {
        $legacyBaseline = ConvertFrom-Json -InputObject $configText -ErrorAction Stop
        $legacyBaseline.plugins.entries.'clawbot-bookkeeping'.config.serverBaseUrl = 'http://127.0.0.1:8888'
        Assert-OfficialCodexPin -Config $legacyBaseline
        if ((Get-OwnerAllowlistFingerprint -Config $legacyBaseline) -cne $ownerAllowlistBefore) {
            throw 'The owner allowlist changed while preparing the legacy bookkeeping origin bootstrap.'
        }
        $legacyProof = ConvertFrom-Json -InputObject (ConvertTo-Json -InputObject $legacyBaseline -Depth 100) -ErrorAction Stop
        $legacyProof.plugins.entries.'clawbot-bookkeeping'.config.serverBaseUrl = 'http://127.0.0.1:8180'
        if ((ConvertTo-CanonicalJson -Value $legacyProof) -cne (ConvertTo-CanonicalJson -Value $config)) {
            throw 'The legacy bookkeeping origin bootstrap changed values outside the approved replacement.'
        }
    }

    $candidate.plugins.load.paths = $updatedPaths.ToArray()
    $candidate.agents.entries.bookkeeper.workspace = $releaseWorkspace
    $candidate.plugins.entries.'clawbot-bookkeeping'.config.serverBaseUrl = 'http://127.0.0.1:8888'
    $candidate.meta.lastTouchedVersion = $openClawVersion
    Assert-OfficialCodexPin -Config $candidate
    if ((Get-OwnerAllowlistFingerprint -Config $candidate) -cne $ownerAllowlistBefore) {
        throw 'The owner allowlist changed while preparing the OpenClaw patch.'
    }

    $patch = [PSCustomObject][ordered]@{
        plugins = [PSCustomObject][ordered]@{
            load = [PSCustomObject][ordered]@{ paths = $updatedPaths.ToArray() }
            entries = [PSCustomObject][ordered]@{
                'clawbot-bookkeeping' = [PSCustomObject][ordered]@{
                    config = [PSCustomObject][ordered]@{ serverBaseUrl = 'http://127.0.0.1:8888' }
                }
            }
        }
        agents = [PSCustomObject][ordered]@{
            entries = [PSCustomObject][ordered]@{
                bookkeeper = [PSCustomObject][ordered]@{ workspace = $releaseWorkspace }
            }
        }
    }

    if (Test-PathInside -Candidate $BackupsRoot -Root $RepositoryRoot) {
        throw 'OpenClaw backups must remain outside the source repository.'
    }
    if ($BackupsRoot -match '(?i)\\OneDrive(?:\s|\\|$)') {
        throw 'OpenClaw backups must remain outside OneDrive.'
    }
    $null = New-Item -ItemType Directory -Path $BackupsRoot -Force
    Assert-DirectoryTreeHasNoReparsePoints -Path $BackupsRoot -FailureMessage 'The OpenClaw backup root contains a reparse point.'
    $timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
    $backupPath = Join-Path $BackupsRoot ('openclaw-' + $timestamp + '-' + $releaseCommit + '-' + [guid]::NewGuid().ToString('N') + '.json')
    $patchPath = Join-Path $BackupsRoot ('.openclaw-patch-' + [guid]::NewGuid().ToString('N') + '.json')
    $legacyStagingDirectory = $null
    $legacyStagedConfigPath = $null
    $legacyBaselinePath = $null
    $legacyBaselineHash = $null
    Assert-NoExistingReparsePath -Path $ConfigPath
    try {
        New-VerifiedPrivateBackup -SourcePath $ConfigPath -BackupPath $backupPath -ExpectedHash $configHash
        Write-ProtectedUtf8File -Path $patchPath -Value ((ConvertTo-Json -InputObject $patch -Depth 20) + "`n")
        if ($requiresLegacyBootstrap) {
            $legacyStagingDirectory = Join-Path $BackupsRoot ('.openclaw-bootstrap-stage-' + [guid]::NewGuid().ToString('N'))
            New-ProtectedPrivateDirectory -Path $legacyStagingDirectory
            $legacyStagedConfigPath = Join-Path $legacyStagingDirectory 'openclaw.json'
            Write-ProtectedUtf8File -Path $legacyStagedConfigPath -Value ((ConvertTo-Json -InputObject $legacyBaseline -Depth 100) + "`n")
            $legacyBaselineHash = Get-Sha256 -Path $legacyStagedConfigPath
            $legacyBaselinePath = Join-Path $BackupsRoot ('openclaw-bootstrap-baseline-' + $timestamp + '-' + $releaseCommit + '-' + [guid]::NewGuid().ToString('N') + '.json')
            New-VerifiedPrivateBackup -SourcePath $legacyStagedConfigPath -BackupPath $legacyBaselinePath -ExpectedHash $legacyBaselineHash
        }
    } catch {
        if (-not [string]::IsNullOrWhiteSpace($legacyStagingDirectory)) {
            Remove-OpenClawPrivateStagingDirectory -DirectoryPath $legacyStagingDirectory
        }
        if (-not [string]::IsNullOrWhiteSpace($legacyBaselinePath)) {
            Remove-PrivateFileIfPresent -Path $legacyBaselinePath
        }
        Remove-PrivateFileIfPresent -Path $patchPath
        Remove-PrivateFileIfPresent -Path $backupPath
        throw
    }

    $livePatchAttempted = $false
    $legacyLivePromoted = $false
    $promotedHash = $null
    $verifiedPatchedHash = $null
    $patchTargetPath = if ($requiresLegacyBootstrap) { $legacyStagedConfigPath } else { $ConfigPath }
    $switchStage = 'Gateway preflight'
    try {
        Assert-PrivateFileAcl -Path $backupPath
        Assert-PrivateFileAcl -Path $patchPath
        if ($requiresLegacyBootstrap) {
            Assert-PrivateDirectoryAcl -Path $legacyStagingDirectory
            Assert-PrivateFileAcl -Path $legacyStagedConfigPath
            Assert-PrivateFileAcl -Path $legacyBaselinePath
            if ((Get-Sha256 -Path $legacyStagedConfigPath) -cne $legacyBaselineHash -or
                (Get-Sha256 -Path $legacyBaselinePath) -cne $legacyBaselineHash) {
                throw 'The validated legacy bootstrap baseline changed before use.'
            }
        }
        $null = Invoke-ExternalCommand -Executable $OpenClawExecutable -Arguments @('gateway', 'status') -FailureMessage 'The OpenClaw Gateway was not running before the switch.'
        if ($requiresLegacyBootstrap) {
            $switchStage = 'legacy bootstrap validation'
            $null = Invoke-OpenClawCommandForConfig -ConfigPath $legacyStagedConfigPath -Arguments @('config', 'validate') -FailureMessage 'The legacy bookkeeping origin bootstrap candidate was invalid.'
            Protect-OpenClawPrivateStagingFiles -DirectoryPath $legacyStagingDirectory
            if ((Get-Sha256 -Path $ConfigPath) -cne $configHash -or
                (Get-Sha256 -Path $backupPath) -cne $configHash -or
                (Get-Sha256 -Path $legacyStagedConfigPath) -cne $legacyBaselineHash -or
                (Get-Sha256 -Path $legacyBaselinePath) -cne $legacyBaselineHash) {
                throw 'The live or staged OpenClaw configuration changed during legacy bootstrap validation.'
            }
        }
        $switchStage = 'config patch dry-run'
        $null = Invoke-OpenClawCommandForConfig -ConfigPath $patchTargetPath -Arguments @('config', 'patch', '--dry-run', '--file', $patchPath) -FailureMessage 'The OpenClaw config patch dry-run failed.'
        $switchStage = 'dry-run integrity verification'
        if ((Get-Sha256 -Path $ConfigPath) -cne $configHash -or
            (Get-Sha256 -Path $backupPath) -cne $configHash) {
            throw 'The dry-run changed the config or its verified backup.'
        }
        if ($requiresLegacyBootstrap -and
            ((Get-Sha256 -Path $legacyStagedConfigPath) -cne $legacyBaselineHash -or
             (Get-Sha256 -Path $legacyBaselinePath) -cne $legacyBaselineHash)) {
            throw 'The dry-run changed the staged bootstrap config or its verified baseline.'
        }
        Assert-PrivateFileAcl -Path $backupPath
        if ($requiresLegacyBootstrap) {
            Protect-OpenClawPrivateStagingFiles -DirectoryPath $legacyStagingDirectory
        } else {
            Protect-PrivateFile -Path $ConfigPath
            Assert-PrivateFileAcl -Path $ConfigPath
        }

        if (-not $requiresLegacyBootstrap) { $livePatchAttempted = $true }
        $switchStage = if ($requiresLegacyBootstrap) { 'staged config patch' } else { 'live config patch' }
        $null = Invoke-OpenClawCommandForConfig -ConfigPath $patchTargetPath -Arguments @('config', 'patch', '--file', $patchPath) -FailureMessage 'The OpenClaw config patch failed.'

        $switchStage = 'patched config verification'
        Assert-NoExistingReparsePath -Path $patchTargetPath
        if ($requiresLegacyBootstrap) {
            Protect-OpenClawPrivateStagingFiles -DirectoryPath $legacyStagingDirectory
        } else {
            Protect-PrivateFile -Path $ConfigPath
            Assert-PrivateFileAcl -Path $ConfigPath
        }
        $verifiedPatchedHash = Get-Sha256 -Path $patchTargetPath
        $patchedText = Read-StrictUtf8 -Path $patchTargetPath
        if ((Get-Sha256 -Path $patchTargetPath) -cne $verifiedPatchedHash) {
            throw 'The patched OpenClaw config changed while its stable verification snapshot was being read.'
        }
        try { $patchedConfig = ConvertFrom-Json -InputObject $patchedText -ErrorAction Stop } catch { throw 'The patched OpenClaw config is invalid.' }
        if ((ConvertTo-CanonicalJson -Value $patchedConfig) -cne (ConvertTo-CanonicalJson -Value $candidate)) {
            throw 'The OpenClaw config patch changed values outside the approved replacement.'
        }
        Assert-OfficialCodexPin -Config $patchedConfig
        if ((Get-OwnerAllowlistFingerprint -Config $patchedConfig) -cne $ownerAllowlistBefore) {
            throw 'The owner allowlist changed during the OpenClaw config patch.'
        }
        Assert-Release -Path $ReleasePath -ExpectedCommit $releaseCommit

        if ($requiresLegacyBootstrap) {
            $switchStage = 'atomic config promotion'
            Assert-PrivateFileAcl -Path $legacyBaselinePath
            if ((Get-Sha256 -Path $backupPath) -cne $configHash -or
                (Get-Sha256 -Path $legacyBaselinePath) -cne $legacyBaselineHash -or
                (Get-Sha256 -Path $legacyStagedConfigPath) -cne $verifiedPatchedHash) {
                throw 'A staged config or verified backup changed before atomic promotion.'
            }
            $promotedHash = $verifiedPatchedHash
            Assert-NoExistingReparsePath -Path $ConfigPath
            if ((Get-Sha256 -Path $ConfigPath) -cne $configHash) {
                throw 'The live config changed immediately before atomic promotion.'
            }
            Move-FileAtomicallyReplacingDestination -SourcePath $legacyStagedConfigPath -DestinationPath $ConfigPath -ExpectedDestinationHash $configHash
            $legacyLivePromoted = $true
            Protect-PrivateFile -Path $ConfigPath
            Assert-PrivateFileAcl -Path $ConfigPath
            if ((Get-Sha256 -Path $ConfigPath) -cne $promotedHash) {
                throw 'The atomically promoted OpenClaw configuration changed.'
            }
            $promotedConfig = ConvertFrom-Json -InputObject (Read-StrictUtf8 -Path $ConfigPath) -ErrorAction Stop
            if ((ConvertTo-CanonicalJson -Value $promotedConfig) -cne (ConvertTo-CanonicalJson -Value $candidate)) {
                throw 'The atomically promoted OpenClaw configuration was not the verified candidate.'
            }
        } else {
            $promotedHash = Get-Sha256 -Path $ConfigPath
        }

        $switchStage = 'Gateway restart'
        $null = Invoke-ExternalCommand -Executable $OpenClawExecutable -Arguments @('gateway', 'restart') -FailureMessage 'The OpenClaw Gateway restart failed.'
        $switchStage = 'Gateway health check'
        $null = Invoke-ExternalCommand -Executable $OpenClawExecutable -Arguments @('gateway', 'status') -FailureMessage 'The OpenClaw Gateway health check failed.'
        $switchStage = 'channel probe'
        $channelStatus = @(Invoke-ExternalCommand -Executable $OpenClawExecutable -Arguments @('channels', 'status', '--probe', '--json') -FailureMessage 'The OpenClaw channel probe failed.')
        Assert-OpenClawWeixinChannelStatus -Output $channelStatus
        $switchStage = 'bookkeeping plugin check'
        $null = Invoke-ExternalCommand -Executable $OpenClawExecutable -Arguments @('plugins', 'info', 'clawbot-bookkeeping') -FailureMessage 'The bookkeeping plugin load check failed.'
        $switchStage = 'stable-ID plugin check'
        $null = Invoke-ExternalCommand -Executable $OpenClawExecutable -Arguments @('plugins', 'info', 'openclaw-weixin') -FailureMessage 'The stable-ID plugin load check failed.'
        $switchStage = 'Codex harness check'
        $null = Invoke-ExternalCommand -Executable $OpenClawExecutable -Arguments @('plugins', 'inspect', 'codex') -FailureMessage 'The Codex harness check failed.'
        $switchStage = 'bookkeeper model check'
        $null = Invoke-ExternalCommand -Executable $OpenClawExecutable -Arguments @('models', 'status', '--agent', 'bookkeeper', '--json') -FailureMessage 'The bookkeeper model status check failed.'
    } catch {
        if ($legacyLivePromoted) {
            Restore-VerifiedConfigBackup -BackupPath $legacyBaselinePath -ExpectedHash $legacyBaselineHash -ConfigPath $ConfigPath -ExpectedCurrentHash $promotedHash
            try {
                $null = Invoke-ExternalCommand -Executable $OpenClawExecutable -Arguments @('gateway', 'restart') -FailureMessage 'The rollback Gateway restart failed.'
                $null = Invoke-ExternalCommand -Executable $OpenClawExecutable -Arguments @('gateway', 'status') -FailureMessage 'The rollback Gateway verification failed.'
            } catch {
                throw 'The OpenClaw switch failed and the valid bootstrap baseline was restored, but the Gateway rollback verification failed.'
            }
            throw ('The OpenClaw switch failed during ' + $switchStage + '; the valid bootstrap baseline was restored.')
        } elseif ($livePatchAttempted) {
            $currentPatchedHash = $null
            if ([IO.File]::Exists($ConfigPath)) {
                $currentPatchedHash = Get-Sha256 -Path $ConfigPath
                if ($currentPatchedHash -ceq $configHash) {
                    throw ('The OpenClaw switch failed during ' + $switchStage + '; the live config remained unchanged.')
                }
                try {
                    $currentPatchedText = Read-StrictUtf8 -Path $ConfigPath
                    if ((Get-Sha256 -Path $ConfigPath) -cne $currentPatchedHash) { throw 'changed' }
                    $currentPatchedConfig = ConvertFrom-Json -InputObject $currentPatchedText -ErrorAction Stop
                } catch {
                    throw 'The OpenClaw switch failed and the live config changed concurrently; automatic rollback was refused.'
                }
                if ((ConvertTo-CanonicalJson -Value $currentPatchedConfig) -cne (ConvertTo-CanonicalJson -Value $candidate)) {
                    throw 'The OpenClaw switch failed and the live config changed concurrently; automatic rollback was refused.'
                }
            }
            Restore-VerifiedConfigBackup -BackupPath $backupPath -ExpectedHash $configHash -ConfigPath $ConfigPath -ExpectedCurrentHash $currentPatchedHash
            try {
                $null = Invoke-ExternalCommand -Executable $OpenClawExecutable -Arguments @('gateway', 'restart') -FailureMessage 'The rollback Gateway restart failed.'
                $null = Invoke-ExternalCommand -Executable $OpenClawExecutable -Arguments @('gateway', 'status') -FailureMessage 'The rollback Gateway verification failed.'
            } catch {
                throw 'The OpenClaw switch failed and the verified config was restored, but the Gateway rollback verification failed.'
            }
            throw ('The OpenClaw switch failed during ' + $switchStage + '; the verified configuration backup was restored.')
        }
        throw
    } finally {
        Remove-PrivateFileIfPresent -Path $patchPath
        if (-not [string]::IsNullOrWhiteSpace($legacyStagingDirectory)) {
            Remove-OpenClawPrivateStagingDirectory -DirectoryPath $legacyStagingDirectory
        }
    }
}

if ($ReleaseOnly -and $SwitchOpenClaw) {
    throw 'Choose either ReleaseOnly or SwitchOpenClaw, not both.'
}
if (-not $ReleaseOnly -and -not $SwitchOpenClaw) {
    throw 'Choose ReleaseOnly or SwitchOpenClaw explicitly.'
}
if (-not [string]::IsNullOrWhiteSpace($ExistingReleasePath) -and (-not $SwitchOpenClaw -or $ReleaseOnly)) {
    throw 'ExistingReleasePath may be used only with SwitchOpenClaw.'
}

$sourcePath = Get-FullPath -Path $SourceRoot
$releasesPath = Get-FullPath -Path $ReleaseRoot
$backupsPath = Get-FullPath -Path $BackupRoot
$configPath = Get-FullPath -Path $OpenClawConfigPath
if (-not [IO.Directory]::Exists($sourcePath)) {
    throw 'The release source repository is missing.'
}
Assert-ExistingPathIsNotReparsePoint -Path $sourcePath
if (Test-PathInside -Candidate $releasesPath -Root $sourcePath) {
    throw 'The release root must remain outside the source repository.'
}
if (Test-PathInside -Candidate $backupsPath -Root $sourcePath) {
    throw 'The backup root must remain outside the source repository.'
}
if ($backupsPath -match '(?i)\\OneDrive(?:\s|\\|$)') {
    throw 'The backup root must remain outside OneDrive.'
}
if (Test-PathInside -Candidate $configPath -Root $sourcePath) {
    throw 'The OpenClaw config must remain outside the source repository.'
}
Assert-NoExistingReparsePath -Path $releasesPath
Assert-NoExistingReparsePath -Path $backupsPath
Assert-NoExistingReparsePath -Path $configPath

if (-not $PSCmdlet.ShouldProcess($releasesPath, 'Publish or activate a verified OpenClaw release')) {
    return
}

if ([string]::IsNullOrWhiteSpace($ExistingReleasePath)) {
    $releasePath = Publish-Release -RepositoryRoot $sourcePath -ReleasesRoot $releasesPath
    Write-Output 'OPENCLAW_RELEASE_PUBLISHED'
} else {
    $releasePath = Get-FullPath -Path $ExistingReleasePath
    if (-not [string]::Equals((Get-FullPath -Path (Split-Path -Parent $releasePath)), $releasesPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The existing release must be a direct child of the configured release root.'
    }
    Assert-Release -Path $releasePath
}

if ($SwitchOpenClaw) {
    Switch-OpenClawRelease -RepositoryRoot $sourcePath -ReleasePath $releasePath -ReleasesRoot $releasesPath -ConfigPath $configPath -BackupsRoot $backupsPath
    Write-Output 'OPENCLAW_RELEASE_SWITCHED'
}
