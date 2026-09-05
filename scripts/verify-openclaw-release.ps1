[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReleasePath,
    [string]$ExpectedCommit,
    [string]$AclExecutable
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:StrictUtf8Encoding = [Text.UTF8Encoding]::new($false, $true)

function Test-ReparsePoint {
    param([Parameter(Mandatory = $true)][IO.FileSystemInfo]$Item)

    return (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
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

function Get-FileIntegrity {
    param([Parameter(Mandatory = $true)][string]$Path)

    $extendedPath = Get-WindowsExtendedPath -Path $Path
    $stream = [IO.File]::Open($extendedPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $length = [long]$stream.Length
        $bytes = $algorithm.ComputeHash($stream)
        if ([long]$stream.Length -ne $length) {
            throw 'A release file changed while its integrity metadata was being calculated.'
        }
        return [PSCustomObject][ordered]@{
            length = $length
            sha256 = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
        }
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    return (Get-FileIntegrity -Path $Path).sha256
}

function Get-ExtendedReleaseTreeEntries {
    param([Parameter(Mandatory = $true)][string]$RootPath)

    $extendedRoot = (Get-WindowsExtendedPath -Path $RootPath).TrimEnd([char[]]@('\', '/'))
    if (-not [IO.Directory]::Exists($extendedRoot)) {
        throw 'Release directory is missing.'
    }
    $rootAttributes = [IO.File]::GetAttributes($extendedRoot)
    if (($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Release verification rejected a reparse-point root.'
    }
    if (($rootAttributes -band [IO.FileAttributes]::Directory) -eq 0) {
        throw 'Release root is not a directory.'
    }

    $entries = New-Object 'System.Collections.Generic.List[object]'
    $entries.Add([PSCustomObject][ordered]@{
        ExtendedPath = $extendedRoot
        RelativePath = ''
        IsDirectory = $true
    })
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($extendedRoot)
    $prefixLength = $extendedRoot.Length + 1
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($entryPath in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
            $attributes = [IO.File]::GetAttributes($entryPath)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Release verification rejected a reparse-point entry.'
            }
            if (-not $entryPath.StartsWith($extendedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Release verification rejected an out-of-root entry.'
            }
            $isDirectory = (($attributes -band [IO.FileAttributes]::Directory) -ne 0)
            $relativePath = $entryPath.Substring($prefixLength).Replace('\', '/')
            if ([string]::IsNullOrWhiteSpace($relativePath)) {
                throw 'Release verification rejected an invalid entry path.'
            }
            $entries.Add([PSCustomObject][ordered]@{
                ExtendedPath = $entryPath
                RelativePath = $relativePath
                IsDirectory = $isDirectory
            })
            if ($isDirectory) {
                $pending.Push($entryPath)
            }
        }
    }
    return $entries.ToArray()
}

function Assert-ReleaseTreeAcl {
    param([Parameter(Mandatory = $true)][string]$RootPath)

    if (-not [string]::IsNullOrWhiteSpace($AclExecutable)) {
        $null = & $AclExecutable 'verify-release' $RootPath 2>$null
        if ($LASTEXITCODE -ne 0) {
            throw 'Release ACL verification failed.'
        }
        return
    }

    $identity = $null
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        if ($null -eq $identity.User) { throw 'missing runtime identity' }
        $runtimeSid = $identity.User.Value
        $systemSid = (New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)).Value
        $administratorsSid = (New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)).Value
        $expectedRights = @{}
        $expectedRights[$systemSid] = [int][Security.AccessControl.FileSystemRights]::FullControl
        $expectedRights[$administratorsSid] = [int][Security.AccessControl.FileSystemRights]::FullControl
        if (-not $expectedRights.ContainsKey($runtimeSid)) {
            # Windows normalizes an allow ACE for ReadAndExecute by adding Synchronize.
            # Keep the comparison exact so no write, delete, or ACL-management rights pass.
            $expectedRights[$runtimeSid] = [int]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
        }

        $aclSections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
        $items = @(Get-ExtendedReleaseTreeEntries -RootPath $RootPath)
        foreach ($item in $items) {
            $attributes = [IO.File]::GetAttributes($item.ExtendedPath)
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point' }
            $isDirectory = (($attributes -band [IO.FileAttributes]::Directory) -ne 0)
            if ($isDirectory -ne $item.IsDirectory) { throw 'entry type changed' }
            if ($isDirectory) {
                $acl = [IO.Directory]::GetAccessControl([string]$item.ExtendedPath, $aclSections)
            } else {
                $acl = [IO.File]::GetAccessControl([string]$item.ExtendedPath, $aclSections)
            }
            $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
            $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
            if (-not $acl.AreAccessRulesProtected -or
                $owner -cne $administratorsSid -or
                $rules.Count -ne $expectedRights.Count) {
                throw 'unexpected ACL shape'
            }
            foreach ($rule in $rules) {
                $ruleSid = $rule.IdentityReference.Value
                if ($rule.IsInherited -or
                    $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
                    -not $expectedRights.ContainsKey($ruleSid) -or
                    [int]$rule.FileSystemRights -ne [int]$expectedRights[$ruleSid]) {
                    throw 'unexpected ACL rule'
                }
            }
        }
    } catch {
        throw 'Release ACL verification failed.'
    } finally {
        if ($null -ne $identity) { $identity.Dispose() }
    }
}

function Assert-ManifestEntryPath {
    param(
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    if ([string]::IsNullOrWhiteSpace($RelativePath) -or
        [IO.Path]::IsPathRooted($RelativePath) -or
        $RelativePath.Contains('\') -or
        $RelativePath.Contains(':')) {
        throw 'Release manifest paths must be normalized relative paths.'
    }
    $segments = @($RelativePath.Split('/'))
    if ($segments.Count -eq 0 -or @($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0) {
        throw 'Release manifest paths must remain inside the release root.'
    }
}

$releaseRoot = Get-FullPath -Path $ReleasePath
if (-not [IO.Directory]::Exists($releaseRoot)) {
    throw 'Release directory is missing.'
}

$manifestPath = Join-Path $releaseRoot 'release-manifest.json'
if (-not [IO.File]::Exists($manifestPath)) {
    throw 'Release manifest is missing.'
}

$allEntries = @(Get-ExtendedReleaseTreeEntries -RootPath $releaseRoot)
$manifestExtendedPath = Get-WindowsExtendedPath -Path $manifestPath
$manifestAttributes = [IO.File]::GetAttributes($manifestExtendedPath)
if (($manifestAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Release verification rejected a reparse-point manifest.'
}

try {
    $manifestText = [IO.File]::ReadAllText($manifestExtendedPath, $script:StrictUtf8Encoding)
    if (-not $manifestText.TrimStart().StartsWith('[', [StringComparison]::Ordinal)) {
        throw 'not an array'
    }
    $manifestDocument = ConvertFrom-Json -InputObject $manifestText -ErrorAction Stop
    $manifestEntries = @($manifestDocument | ForEach-Object { $_ })
} catch {
    throw 'Release manifest is not valid JSON.'
}
if ($manifestEntries.Count -eq 0) {
    throw 'Release manifest contains no payload files.'
}

$manifestByPath = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $manifestEntries) {
    if ($null -eq $entry -or $entry -isnot [PSCustomObject]) {
        throw 'Release manifest entry is invalid.'
    }
    $propertyNames = @($entry.PSObject.Properties.Name | Sort-Object)
    if (($propertyNames -join ',') -cne 'length,path,sha256') {
        throw ('Release manifest entries may contain only path, length, and sha256; property count was ' + $propertyNames.Count + '.')
    }
    if ($entry.path -isnot [string] -or $entry.sha256 -isnot [string]) {
        throw 'Release manifest entry types are invalid.'
    }
    $relativePath = [string]$entry.path
    if ($relativePath -ceq 'release-manifest.json') {
        throw 'Release manifest cannot hash itself.'
    }
    Assert-ManifestEntryPath -RelativePath $relativePath
    if ($entry.length -isnot [int] -and $entry.length -isnot [long]) {
        throw 'Release manifest length is invalid.'
    }
    if ([long]$entry.length -lt 0 -or $entry.sha256 -cnotmatch '^[0-9a-f]{64}$') {
        throw 'Release manifest hash or length is invalid.'
    }
    if ($manifestByPath.ContainsKey($relativePath)) {
        throw 'Release manifest contains a duplicate path.'
    }
    $manifestByPath.Add($relativePath, $entry)
}

$actualByPath = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($fileEntry in $allEntries) {
    if ($fileEntry.IsDirectory -or $fileEntry.RelativePath -ceq 'release-manifest.json') {
        continue
    }
    $relativePath = $fileEntry.RelativePath
    if ($actualByPath.ContainsKey($relativePath)) {
        throw 'Release contains duplicate case-insensitive paths.'
    }
    $actualByPath.Add($relativePath, $fileEntry.ExtendedPath)
}

foreach ($relativePath in $manifestByPath.Keys) {
    if (-not $actualByPath.ContainsKey($relativePath)) {
        throw 'Release payload file is missing.'
    }
}
foreach ($relativePath in $actualByPath.Keys) {
    if (-not $manifestByPath.ContainsKey($relativePath)) {
        throw 'Release contains an extra file.'
    }
}

$requiredPayloadPaths = @(
    'release-commit.txt',
    'openclaw-plugins/clawbot-bookkeeping/adapter.mjs',
    'openclaw-plugins/clawbot-bookkeeping/bookkeeping-core.mjs',
    'openclaw-plugins/clawbot-bookkeeping/categories.mjs',
    'openclaw-plugins/clawbot-bookkeeping/expense-summary.mjs',
    'openclaw-plugins/clawbot-bookkeeping/index.ts',
    'openclaw-plugins/clawbot-bookkeeping/mcp-connection.mjs',
    'openclaw-plugins/clawbot-bookkeeping/openclaw.plugin.json',
    'openclaw-plugins/clawbot-bookkeeping/package.json',
    'openclaw-plugins/clawbot-bookkeeping/package-lock.json',
    'openclaw-plugins/clawbot-bookkeeping/node_modules/typebox/package.json',
    'openclaw-plugins/openclaw-weixin-stable-id/dist/index.js',
    'openclaw-plugins/openclaw-weixin-stable-id/openclaw.plugin.json',
    'openclaw-plugins/openclaw-weixin-stable-id/package.json',
    'openclaw-plugins/openclaw-weixin-stable-id/package-lock.json',
    'openclaw-plugins/openclaw-weixin-stable-id/node_modules/openclaw/package.json',
    'openclaw-plugins/openclaw-weixin-stable-id/node_modules/qrcode-terminal/package.json',
    'openclaw-plugins/openclaw-weixin-stable-id/node_modules/zod/package.json',
    'openclaw-workspace/AGENTS.md',
    'openclaw-workspace/IDENTITY.md',
    'openclaw-workspace/SOUL.md',
    'openclaw-workspace/USER.md'
)
foreach ($requiredPath in $requiredPayloadPaths) {
    if (-not $actualByPath.ContainsKey($requiredPath)) {
        throw 'Release required plugin, workspace, or dependency structure is incomplete.'
    }
}
foreach ($relativePath in $actualByPath.Keys) {
    if ($relativePath.StartsWith('openclaw-plugins/clawbot-bookkeeping/node_modules/openclaw/', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Release dependency structure unexpectedly installs the OpenClaw host peer for bookkeeping.'
    }
}

foreach ($relativePath in $manifestByPath.Keys) {
    $entry = $manifestByPath[$relativePath]
    $filePath = $actualByPath[$relativePath]
    $integrity = Get-FileIntegrity -Path $filePath
    if ([long]$entry.length -ne [long]$integrity.length) {
        throw 'Release payload length changed.'
    }
    if ($integrity.sha256 -cne [string]$entry.sha256) {
        throw 'Release payload hash changed.'
    }
}

# Read the plugin contract only after every payload file has passed its manifest hash.
# Older verified releases do not declare find_expenses and remain valid rollback targets.
$bookkeepingManifestPath = $actualByPath['openclaw-plugins/clawbot-bookkeeping/openclaw.plugin.json']
try {
    $bookkeepingManifestText = [IO.File]::ReadAllText($bookkeepingManifestPath, $script:StrictUtf8Encoding)
    $bookkeepingManifest = ConvertFrom-Json -InputObject $bookkeepingManifestText -ErrorAction Stop
    if ($null -eq $bookkeepingManifest -or $bookkeepingManifest -isnot [PSCustomObject]) {
        throw 'invalid plugin manifest'
    }
    $contractsProperty = $bookkeepingManifest.PSObject.Properties['contracts']
    if ($null -eq $contractsProperty -or $contractsProperty.Value -isnot [PSCustomObject]) {
        throw 'invalid plugin contracts'
    }
    $toolsProperty = $contractsProperty.Value.PSObject.Properties['tools']
    if ($null -eq $toolsProperty -or $toolsProperty.Value -isnot [Array]) {
        throw 'invalid plugin tool contracts'
    }
    $bookkeepingToolNames = $toolsProperty.Value
    foreach ($toolName in $bookkeepingToolNames) {
        if ($toolName -isnot [string] -or [string]::IsNullOrWhiteSpace($toolName)) {
            throw 'invalid plugin tool name'
        }
    }
} catch {
    throw 'Release bookkeeping plugin tool contracts are invalid.'
}
if ($bookkeepingToolNames -ccontains 'find_expenses' -and
    -not $actualByPath.ContainsKey('openclaw-plugins/clawbot-bookkeeping/expense-search.mjs')) {
    throw 'Release find_expenses contract requires the amount-search module.'
}

$commitMarkerPath = Join-Path $releaseRoot 'release-commit.txt'
if (-not [IO.File]::Exists($commitMarkerPath)) {
    throw 'Release commit marker is missing.'
}
$releaseCommit = [IO.File]::ReadAllText($commitMarkerPath, $script:StrictUtf8Encoding).Trim()
if ($releaseCommit -cnotmatch '^[0-9a-f]{40}([0-9a-f]{24})?$') {
    throw 'Release commit marker is not a full Git commit.'
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedCommit) -and $releaseCommit -cne $ExpectedCommit) {
    throw 'Release commit marker does not match the expected Git commit.'
}
$releaseLeaf = Split-Path -Leaf $releaseRoot
if ($releaseLeaf -cnotmatch '^[0-9a-f]{40}([0-9a-f]{24})?$') {
    throw 'Release directory name must be the full Git commit.'
}
if ($releaseLeaf -cne $releaseCommit) {
    throw 'Release directory name does not match its commit marker.'
}

Assert-ReleaseTreeAcl -RootPath $releaseRoot

Write-Output 'OPENCLAW_RELEASE_VERIFIED'
