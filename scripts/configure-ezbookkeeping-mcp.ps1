[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ConfigPath = 'D:\Clawbot\ezbookkeeping\ezbookkeeping.ini',
    [string]$ApiTokenPath = "$env:USERPROFILE\.openclaw\secrets\ezbookkeeping-token.txt",
    [string]$McpTokenPath = "$env:USERPROFILE\.openclaw\secrets\ezbookkeeping-mcp-token.txt",
    [string]$TaskName = 'Clawbot ezBookkeeping',
    [ValidateRange(60, 315360000)]
    [int]$ExpiresInSeconds = 31536000
)

Set-StrictMode -Version Latest

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

function Get-BackupPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $candidate = "$Path.before-mcp-$stamp"
    $suffix = 0
    while (Test-Path -LiteralPath $candidate) {
        $suffix++
        $candidate = "$Path.before-mcp-$stamp-$suffix"
    }
    return $candidate
}

function Set-OwnerOnlyTokenFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Token,
        [Parameter(Mandatory = $true)][System.Text.Encoding]$Encoding
    )

    $directory = Split-Path -Parent $Path
    if ([string]::IsNullOrWhiteSpace($directory)) {
        throw 'The MCP token path must include a directory.'
    }
    New-Item -ItemType Directory -Path $directory -Force -ErrorAction Stop | Out-Null
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        New-Item -ItemType File -Path $Path -ErrorAction Stop | Out-Null
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl -ErrorAction Stop
    [IO.File]::WriteAllText($Path, $Token, $Encoding)
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw 'The ezBookkeeping configuration file was not found.'
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$configText = [IO.File]::ReadAllText($ConfigPath, $utf8NoBom)
$updatedConfig = Get-UpdatedMcpConfiguration -Text $configText

if (-not $PSCmdlet.ShouldProcess($ConfigPath, 'Enable MCP, restart ezBookkeeping, and create a protected token')) {
    return
}

$passwordPointer = [IntPtr]::Zero
$securePassword = $null
$plainPassword = $null
$apiToken = $null
$mcpToken = $null
$headers = $null
$body = $null

try {
    $backupPath = Get-BackupPath -Path $ConfigPath
    Copy-Item -LiteralPath $ConfigPath -Destination $backupPath -ErrorAction Stop
    [IO.File]::WriteAllText($ConfigPath, $updatedConfig, $utf8NoBom)

    $installDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($ConfigPath))
    $expectedExecutable = [IO.Path]::GetFullPath((Join-Path $installDirectory 'ezbookkeeping.exe'))
    if (-not (Test-Path -LiteralPath $expectedExecutable -PathType Leaf)) {
        throw 'The expected ezBookkeeping executable was not found.'
    }
    Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop

    $ownedProcesses = Get-CimInstance Win32_Process -Filter "Name='ezbookkeeping.exe'" -ErrorAction Stop | Where-Object {
        $_.ExecutablePath -and ([string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $expectedExecutable, [StringComparison]::OrdinalIgnoreCase))
    }
    foreach ($process in $ownedProcesses) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    }
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop

    $healthy = $false
    $healthDeadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $healthDeadline) {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8180/healthz.json' -TimeoutSec 1 -ErrorAction Stop
            if ($health.success -eq $true) {
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
    $apiToken = [IO.File]::ReadAllText($ApiTokenPath, $utf8NoBom).Trim()
    if ([string]::IsNullOrWhiteSpace($apiToken)) {
        throw 'The local ezBookkeeping API token is empty.'
    }
    $headers = @{ Authorization = "Bearer $apiToken" }
    $body = @{ expiresInSeconds = $ExpiresInSeconds; password = $plainPassword } | ConvertTo-Json -Compress
    $response = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8180/api/v1/tokens/generate/mcp.json' -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body -ErrorAction Stop
    if ($response.success -ne $true -or [string]::IsNullOrWhiteSpace([string]$response.result.token)) {
        throw 'ezBookkeeping did not return an MCP token.'
    }
    $mcpToken = [string]$response.result.token
    Set-OwnerOnlyTokenFile -Path $McpTokenPath -Token $mcpToken -Encoding $utf8NoBom
    Write-Host 'MCP enabled and token stored securely.'
} catch {
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
