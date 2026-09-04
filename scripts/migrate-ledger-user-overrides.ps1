[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$InstallDirectory = 'D:\Clawbot\ezbookkeeping',
    [string]$ConfigPath,
    [string]$BackupRoot = 'D:\Clawbot\backups\ledger-user-overrides'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'ledger-runtime-common.ps1')
Add-Type -AssemblyName System.Security

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $InstallDirectory 'conf\ezbookkeeping.ini'
}

$script:ExpectedUserOverrideNames = @(
    'EBK_SECURITY_SECRET_KEY',
    'EBK_SERVER_ROOT_URL',
    'EBK_SECURITY_ENABLE_API_TOKEN',
    'EBK_SERVER_HTTP_ADDR',
    'EBK_SERVER_DOMAIN'
)
$script:UserEnvironmentRegistryPath = 'Registry::HKEY_CURRENT_USER\Environment'
$script:MachineEnvironmentRegistryPath = 'Registry::HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
$script:StrictUtf8Encoding = New-Object System.Text.UTF8Encoding($false, $true)
$script:Utf8Encoding = New-Object System.Text.UTF8Encoding($false)
$script:DpapiEntropy = $script:Utf8Encoding.GetBytes('Clawbot-Ledger-User-Overrides-V1')

function Get-LedgerBytesSha256 {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
}

function Get-LedgerRegistryOverrideMap {
    param([Parameter(Mandatory = $true)][string]$RegistryPath)

    $properties = Get-ItemProperty -LiteralPath $RegistryPath -ErrorAction Stop
    $result = [ordered]@{}
    foreach ($property in @($properties.PSObject.Properties)) {
        $normalizedName = $property.Name.ToUpperInvariant()
        if ($normalizedName -notmatch '^(?:EBK_|EBKCFP_)') { continue }
        if ($result.Contains($normalizedName)) {
            throw 'Duplicate case-insensitive ezBookkeeping environment overrides were found.'
        }
        $result[$normalizedName] = [string]$property.Value
    }
    return $result
}

function Get-LedgerProcessOverrideNames {
    $names = New-Object 'System.Collections.Generic.List[string]'
    foreach ($name in @([Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process).Keys)) {
        $normalizedName = ([string]$name).ToUpperInvariant()
        if ($normalizedName -match '^(?:EBK_|EBKCFP_)') { $names.Add($normalizedName) }
    }
    return @($names.ToArray() | Sort-Object -Unique)
}

function Assert-LedgerExactOverrideNames {
    param([Parameter(Mandatory = $true)][Collections.IDictionary]$Overrides)

    [string[]]$actual = @($Overrides.Keys | ForEach-Object { ([string]$_).ToUpperInvariant() } | Sort-Object)
    [string[]]$expected = @($script:ExpectedUserOverrideNames | Sort-Object)
    if (($actual -join "`n") -cne ($expected -join "`n")) {
        throw 'The User environment does not contain exactly the recognized five legacy ezBookkeeping overrides.'
    }
}

function Get-LedgerEnvironmentSnapshot {
    if (@(Get-LedgerProcessOverrideNames).Count -ne 0) {
        throw 'A Process-scoped ezBookkeeping override prevents safe remediation.'
    }
    $machineOverrides = Get-LedgerRegistryOverrideMap -RegistryPath $script:MachineEnvironmentRegistryPath
    if ($machineOverrides.Count -ne 0) {
        throw 'A Machine-scoped ezBookkeeping override prevents safe remediation.'
    }
    $userOverrides = Get-LedgerRegistryOverrideMap -RegistryPath $script:UserEnvironmentRegistryPath
    Assert-LedgerExactOverrideNames -Overrides $userOverrides

    $secret = [string]$userOverrides['EBK_SECURITY_SECRET_KEY']
    if ([string]::IsNullOrWhiteSpace($secret) -or
        $secret.StartsWith('__', [StringComparison]::Ordinal) -or
        $secret.Trim() -cne $secret -or
        $secret.IndexOfAny([char[]]@("`r", "`n", "`0")) -ge 0) {
        throw 'The effective ezBookkeeping signing secret is not safe to persist.'
    }
    return $userOverrides
}

function Test-LedgerEnvironmentSnapshotEqual {
    param(
        [Parameter(Mandatory = $true)][Collections.IDictionary]$Left,
        [Parameter(Mandatory = $true)][Collections.IDictionary]$Right
    )

    if ($Left.Count -ne $Right.Count) { return $false }
    foreach ($name in $script:ExpectedUserOverrideNames) {
        if (-not $Left.Contains($name) -or -not $Right.Contains($name) -or
            [string]$Left[$name] -cne [string]$Right[$name]) {
            return $false
        }
    }
    return $true
}

function Assert-LedgerOwnerOnlyPathAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $rules = @($acl.Access)
    if (-not $acl.AreAccessRulesProtected -or
        [string]$acl.Owner -cne $identity -or
        $rules.Count -ne 1 -or
        [string]$rules[0].IdentityReference.Value -cne $identity -or
        [string]$rules[0].AccessControlType -cne 'Allow' -or
        [string]$rules[0].FileSystemRights -notmatch 'FullControl') {
        throw 'A remediation backup path does not have an owner-only ACL.'
    }
}

function Write-LedgerProtectedBytes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][byte[]]$Bytes
    )

    New-LedgerOwnerOnlyEmptyFile -Path $Path
    try {
        Write-LedgerBytesIntoExistingFile -Path $Path -Bytes $Bytes
        Protect-LedgerOwnerOnlyFile -Path $Path
        Assert-LedgerOwnerOnlyPathAcl -Path $Path
    } catch {
        Remove-LedgerOwnedFileIfPresent -Path $Path
        throw
    }
}

function ConvertTo-LedgerEnvironmentPayloadBytes {
    param([Parameter(Mandatory = $true)][Collections.IDictionary]$Snapshot)

    $variables = [ordered]@{}
    foreach ($name in $script:ExpectedUserOverrideNames) {
        $variables[$name] = [string]$Snapshot[$name]
    }
    $payload = [ordered]@{
        schemaVersion = 1
        scope = 'User'
        variables = $variables
    }
    return $script:Utf8Encoding.GetBytes(($payload | ConvertTo-Json -Depth 5 -Compress))
}

function Read-LedgerVerifiedEnvironmentBackup {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedPlaintextHash
    )

    Assert-LedgerOwnerOnlyPathAcl -Path $Path
    $ciphertext = $null
    $plaintext = $null
    try {
        $ciphertext = [IO.File]::ReadAllBytes($Path)
        $plaintext = [Security.Cryptography.ProtectedData]::Unprotect(
            $ciphertext,
            $script:DpapiEntropy,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        if ((Get-LedgerBytesSha256 -Bytes $plaintext) -cne $ExpectedPlaintextHash) {
            throw 'hash mismatch'
        }
        $payloadText = $script:StrictUtf8Encoding.GetString($plaintext)
        $payload = $payloadText | ConvertFrom-Json -ErrorAction Stop
        if ([int]$payload.schemaVersion -ne 1 -or [string]$payload.scope -cne 'User') {
            throw 'invalid payload'
        }
        $snapshot = [ordered]@{}
        foreach ($property in @($payload.variables.PSObject.Properties)) {
            $name = $property.Name.ToUpperInvariant()
            if ($snapshot.Contains($name)) { throw 'duplicate variable' }
            $snapshot[$name] = [string]$property.Value
        }
        Assert-LedgerExactOverrideNames -Overrides $snapshot
        return $snapshot
    } catch {
        throw 'The encrypted User environment backup could not be verified.'
    } finally {
        if ($null -ne $plaintext -and $plaintext.Length -gt 0) { [Array]::Clear($plaintext, 0, $plaintext.Length) }
        if ($null -ne $ciphertext -and $ciphertext.Length -gt 0) { [Array]::Clear($ciphertext, 0, $ciphertext.Length) }
    }
}

function New-LedgerUniqueBackupDirectory {
    param([Parameter(Mandatory = $true)][string]$Root)

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        New-Item -ItemType Directory -Path $Root -ErrorAction Stop | Out-Null
    }
    Assert-LedgerNoExistingReparsePath -Path $Root
    Set-LedgerOwnerOnlyAcl -Path $Root
    Assert-LedgerOwnerOnlyPathAcl -Path $Root
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
    for ($suffix = 0; $suffix -lt 100; $suffix++) {
        $leaf = if ($suffix -eq 0) { $stamp } else { $stamp + '-' + $suffix }
        $candidate = Join-Path $Root $leaf
        if (Test-Path -LiteralPath $candidate) { continue }
        Assert-LedgerNoExistingReparsePath -Path $candidate
        New-Item -ItemType Directory -Path $candidate -ErrorAction Stop | Out-Null
        Set-LedgerOwnerOnlyAcl -Path $candidate
        Assert-LedgerOwnerOnlyPathAcl -Path $candidate
        return $candidate
    }
    throw 'A unique User environment remediation backup directory could not be created.'
}

function Restore-LedgerUserOverrides {
    param([Parameter(Mandatory = $true)][Collections.IDictionary]$Snapshot)

    $current = Get-LedgerRegistryOverrideMap -RegistryPath $script:UserEnvironmentRegistryPath
    foreach ($name in @($current.Keys)) {
        if ($script:ExpectedUserOverrideNames -cnotcontains [string]$name -or
            [string]$current[$name] -cne [string]$Snapshot[$name]) {
            throw 'The User environment changed independently during rollback.'
        }
    }
    foreach ($name in $script:ExpectedUserOverrideNames) {
        if (-not $current.Contains($name)) {
            Set-ItemProperty -LiteralPath $script:UserEnvironmentRegistryPath -Name $name -Value ([string]$Snapshot[$name]) -ErrorAction Stop
        }
    }
    $restored = Get-LedgerRegistryOverrideMap -RegistryPath $script:UserEnvironmentRegistryPath
    Assert-LedgerExactOverrideNames -Overrides $restored
    if (-not (Test-LedgerEnvironmentSnapshotEqual -Left $Snapshot -Right $restored)) {
        throw 'The User environment override rollback did not match its verified backup.'
    }
}

$installRoot = Get-LedgerNormalizedPath -Path $InstallDirectory
$configurationPath = Get-LedgerNormalizedPath -Path $ConfigPath
$expectedConfigPath = Get-LedgerNormalizedPath -Path (Join-Path $installRoot 'conf\ezbookkeeping.ini')
$backupBase = Assert-LedgerBackupRoot -BackupRoot $BackupRoot
if (-not (Test-LedgerSamePath -Left $configurationPath -Right $expectedConfigPath)) {
    throw 'The remediation configuration must be the exact production ezBookkeeping INI.'
}
if ((Test-LedgerPathInside -Candidate $backupBase -Root $installRoot) -or
    (Test-LedgerPathInside -Candidate $installRoot -Root $backupBase)) {
    throw 'The remediation backup root must not overlap the production installation.'
}
if (-not (Test-Path -LiteralPath $configurationPath -PathType Leaf)) {
    throw 'The production ezBookkeeping configuration was not found.'
}
Assert-LedgerNoExistingReparsePath -Path $configurationPath
Assert-LedgerOwnerOnlyFile -Path $configurationPath

if (-not $PSCmdlet.ShouldProcess($configurationPath, 'Back up and remove the exact five legacy User environment overrides')) {
    return
}

$backupDirectory = $null
$backupConfigPath = $null
$backupEnvironmentPath = $null
$originalConfigHash = $null
$environmentPlaintextHash = $null
$updatedConfigHash = $null
$configWriteAttempted = $false
$environmentClearAttempted = $false
$snapshot = $null
$secret = $null
$payloadBytes = $null
$ciphertextBytes = $null
$operationMutex = $null
$operationMutexAcquired = $false

try {
    $operationMutex = New-Object Threading.Mutex($false, 'Local\Clawbot.Ledger.UserOverrides')
    try {
        $operationMutexAcquired = $operationMutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
        $operationMutexAcquired = $true
    }
    if (-not $operationMutexAcquired) {
        throw 'Another User environment remediation is already running.'
    }

    $snapshot = Get-LedgerEnvironmentSnapshot
    $secret = [string]$snapshot['EBK_SECURITY_SECRET_KEY']
    $originalConfigHash = Get-LedgerFileSha256 -Path $configurationPath
    $document = Get-LedgerIniDocument -Path $configurationPath
    if ((Get-LedgerFileSha256 -Path $configurationPath) -cne $originalConfigHash) {
        throw 'The production INI changed while the remediation snapshot was read.'
    }

    $updatedText = Set-LedgerIniValues -Document $document -Settings @{
        'server.http_addr' = '127.0.0.1'
        'server.domain' = 'ledger.66ccff-labs.com'
        'server.root_url' = 'https://ledger.66ccff-labs.com/'
        'security.secret_key' = $secret
        'security.enable_api_token' = 'true'
    }
    $updatedBytes = $script:Utf8Encoding.GetBytes($updatedText)
    try {
        $updatedConfigHash = Get-LedgerBytesSha256 -Bytes $updatedBytes
    } finally {
        if ($updatedBytes.Length -gt 0) { [Array]::Clear($updatedBytes, 0, $updatedBytes.Length) }
    }

    $backupDirectory = New-LedgerUniqueBackupDirectory -Root $backupBase
    $backupConfigPath = Join-Path $backupDirectory 'ezbookkeeping.ini'
    New-LedgerOwnerOnlyEmptyFile -Path $backupConfigPath
    if (Test-LedgerSameFile -Left $configurationPath -Right $backupConfigPath) {
        throw 'The production INI backup aliases the live configuration.'
    }
    Copy-LedgerFileBytesIntoExistingFile -SourcePath $configurationPath -DestinationPath $backupConfigPath
    Protect-LedgerOwnerOnlyFile -Path $backupConfigPath
    Assert-LedgerOwnerOnlyPathAcl -Path $backupConfigPath
    if ((Test-LedgerSameFile -Left $configurationPath -Right $backupConfigPath) -or
        (Get-LedgerFileSha256 -Path $configurationPath) -cne $originalConfigHash -or
        (Get-LedgerFileSha256 -Path $backupConfigPath) -cne $originalConfigHash) {
        throw 'The production INI backup did not pass hash verification.'
    }

    $payloadBytes = ConvertTo-LedgerEnvironmentPayloadBytes -Snapshot $snapshot
    $environmentPlaintextHash = Get-LedgerBytesSha256 -Bytes $payloadBytes
    $ciphertextBytes = [Security.Cryptography.ProtectedData]::Protect(
        $payloadBytes,
        $script:DpapiEntropy,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $backupEnvironmentPath = Join-Path $backupDirectory 'user-overrides.dpapi'
    Write-LedgerProtectedBytes -Path $backupEnvironmentPath -Bytes $ciphertextBytes
    $verifiedSnapshot = Read-LedgerVerifiedEnvironmentBackup -Path $backupEnvironmentPath -ExpectedPlaintextHash $environmentPlaintextHash
    if (-not (Test-LedgerEnvironmentSnapshotEqual -Left $snapshot -Right $verifiedSnapshot)) {
        throw 'The encrypted User environment backup did not match its source snapshot.'
    }

    $manifest = [ordered]@{
        schemaVersion = 1
        configurationSha256 = $originalConfigHash
        encryptedEnvironmentSha256 = Get-LedgerFileSha256 -Path $backupEnvironmentPath
        variableCount = 5
    }
    $manifestBytes = $script:Utf8Encoding.GetBytes(($manifest | ConvertTo-Json -Depth 3))
    try {
        Write-LedgerProtectedBytes -Path (Join-Path $backupDirectory 'backup-manifest.json') -Bytes $manifestBytes
    } finally {
        if ($manifestBytes.Length -gt 0) { [Array]::Clear($manifestBytes, 0, $manifestBytes.Length) }
    }

    $currentSnapshot = Get-LedgerEnvironmentSnapshot
    if (-not (Test-LedgerEnvironmentSnapshotEqual -Left $snapshot -Right $currentSnapshot) -or
        (Get-LedgerFileSha256 -Path $configurationPath) -cne $originalConfigHash) {
        throw 'The production INI or User environment changed before remediation.'
    }

    $configWriteAttempted = $true
    Write-LedgerTextAtomically -Path $configurationPath -Text $updatedText
    Assert-LedgerOwnerOnlyPathAcl -Path $configurationPath
    if ((Get-LedgerFileSha256 -Path $configurationPath) -cne $updatedConfigHash) {
        throw 'The remediated production INI hash did not match the intended content.'
    }
    $writtenDocument = Get-LedgerIniDocument -Path $configurationPath
    if ((Get-LedgerIniValue -Document $writtenDocument -Section 'security' -Name 'secret_key') -cne $secret -or
        (Get-LedgerIniValue -Document $writtenDocument -Section 'server' -Name 'http_addr') -cne '127.0.0.1' -or
        (Get-LedgerIniValue -Document $writtenDocument -Section 'server' -Name 'domain') -cne 'ledger.66ccff-labs.com' -or
        (Get-LedgerIniValue -Document $writtenDocument -Section 'server' -Name 'root_url') -cne 'https://ledger.66ccff-labs.com/' -or
        (Get-LedgerIniValue -Document $writtenDocument -Section 'security' -Name 'enable_api_token') -cne 'true') {
        throw 'The remediated production INI did not pass exact verification.'
    }

    $currentSnapshot = Get-LedgerEnvironmentSnapshot
    if (-not (Test-LedgerEnvironmentSnapshotEqual -Left $snapshot -Right $currentSnapshot)) {
        throw 'The User environment changed after the production INI was written.'
    }

    $environmentClearAttempted = $true
    foreach ($name in $script:ExpectedUserOverrideNames) {
        Remove-ItemProperty -LiteralPath $script:UserEnvironmentRegistryPath -Name $name -ErrorAction Stop
    }
    if (@(Get-LedgerProcessOverrideNames).Count -ne 0 -or
        (Get-LedgerRegistryOverrideMap -RegistryPath $script:MachineEnvironmentRegistryPath).Count -ne 0 -or
        (Get-LedgerRegistryOverrideMap -RegistryPath $script:UserEnvironmentRegistryPath).Count -ne 0) {
        throw 'An ezBookkeeping environment override remained after remediation.'
    }
    Assert-LedgerNoExistingReparsePath -Path $configurationPath
    Assert-LedgerOwnerOnlyPathAcl -Path $configurationPath
    if ((Get-LedgerFileSha256 -Path $configurationPath) -cne $updatedConfigHash) {
        throw 'The production INI changed while User overrides were being removed.'
    }

    Write-Output 'LEDGER_USER_OVERRIDES_MIGRATED'
} catch {
    $rollbackSucceeded = $true
    if ($environmentClearAttempted) {
        try {
            $rollbackSnapshot = Read-LedgerVerifiedEnvironmentBackup -Path $backupEnvironmentPath -ExpectedPlaintextHash $environmentPlaintextHash
            Restore-LedgerUserOverrides -Snapshot $rollbackSnapshot
        } catch {
            $rollbackSucceeded = $false
        }
    }
    if ($configWriteAttempted) {
        try {
            Assert-LedgerOwnerOnlyPathAcl -Path $backupConfigPath
            if ((Test-LedgerSameFile -Left $configurationPath -Right $backupConfigPath) -or
                (Get-LedgerFileSha256 -Path $backupConfigPath) -cne $originalConfigHash) {
                throw 'backup hash mismatch'
            }
            if (-not (Test-Path -LiteralPath $configurationPath -PathType Leaf)) {
                throw 'live INI missing during rollback'
            }
            $currentConfigHash = Get-LedgerFileSha256 -Path $configurationPath
            if ($currentConfigHash -ceq $updatedConfigHash) {
                $originalText = [IO.File]::ReadAllText($backupConfigPath, $script:StrictUtf8Encoding)
                Write-LedgerTextAtomically -Path $configurationPath -Text $originalText
                Assert-LedgerOwnerOnlyPathAcl -Path $configurationPath
            } elseif ($currentConfigHash -cne $originalConfigHash) {
                throw 'live INI changed independently during rollback'
            }
            Assert-LedgerOwnerOnlyPathAcl -Path $configurationPath
            if ((Get-LedgerFileSha256 -Path $configurationPath) -cne $originalConfigHash) {
                throw 'restored INI hash mismatch'
            }
        } catch {
            $rollbackSucceeded = $false
        }
    }
    if (-not $rollbackSucceeded) {
        throw 'Legacy ezBookkeeping User environment remediation failed and rollback was incomplete. Keep the verified backup for manual recovery.'
    }
    if ($configWriteAttempted -or $environmentClearAttempted) {
        throw 'Legacy ezBookkeeping User environment remediation failed; the verified INI and recognized User overrides were restored.'
    }
    throw 'Legacy ezBookkeeping User environment remediation failed before any production state was changed.'
} finally {
    if ($operationMutexAcquired -and $null -ne $operationMutex) {
        try { $operationMutex.ReleaseMutex() } catch { }
    }
    if ($null -ne $operationMutex) { $operationMutex.Dispose() }
    if ($null -ne $payloadBytes -and $payloadBytes.Length -gt 0) { [Array]::Clear($payloadBytes, 0, $payloadBytes.Length) }
    if ($null -ne $ciphertextBytes -and $ciphertextBytes.Length -gt 0) { [Array]::Clear($ciphertextBytes, 0, $ciphertextBytes.Length) }
    if ($null -ne $script:DpapiEntropy -and $script:DpapiEntropy.Length -gt 0) { [Array]::Clear($script:DpapiEntropy, 0, $script:DpapiEntropy.Length) }
    $secret = $null
    $snapshot = $null
}
