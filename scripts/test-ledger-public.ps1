[CmdletBinding()]
param(
    [ValidateRange(1, 30)]
    [int]$TimeoutSec = 10,

    [string]$PortfolioBaselinePath,

    [switch]$CapturePortfolioBaseline,

    [switch]$ComparePortfolioBaseline,

    [string]$ApiTokenPath,

    [string]$McpTokenPath,

    [switch]$VerifyRateLimit,

    [switch]$ValidateFreePlanRateLimitGate,

    [string]$FreeRateLimitEvidencePath,

    [switch]$ExpectLedgerUnavailable,

    [string]$NodeExecutable = 'node.exe',

    [string]$HelperPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($HelperPath)) {
    $HelperPath = Join-Path $PSScriptRoot 'test-ledger-public.mjs'
}

function Get-PublicNormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A required public-acceptance path was empty.' }
    try {
        return [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path.Trim()))
    } catch {
        throw 'A required public-acceptance path was invalid.'
    }
}

if ($CapturePortfolioBaseline -and $ComparePortfolioBaseline) {
    throw 'CapturePortfolioBaseline and ComparePortfolioBaseline are mutually exclusive.'
}
if (($CapturePortfolioBaseline -or $ComparePortfolioBaseline) -and [string]::IsNullOrWhiteSpace($PortfolioBaselinePath)) {
    throw 'PortfolioBaselinePath is required for portfolio capture or comparison.'
}
if ($ValidateFreePlanRateLimitGate -and [string]::IsNullOrWhiteSpace($FreeRateLimitEvidencePath)) {
    throw 'FreeRateLimitEvidencePath is required for free-plan activation validation.'
}
if (-not $ValidateFreePlanRateLimitGate -and -not [string]::IsNullOrWhiteSpace($FreeRateLimitEvidencePath)) {
    throw 'FreeRateLimitEvidencePath is only valid with ValidateFreePlanRateLimitGate.'
}

$helper = Get-PublicNormalizedPath -Path $HelperPath
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw 'The fixed public-acceptance helper is missing.'
}

$arguments = @(
    $helper,
    '--timeout-ms',
    [string]($TimeoutSec * 1000)
)
if ($CapturePortfolioBaseline) {
    $arguments += @('--capture', '--baseline', (Get-PublicNormalizedPath -Path $PortfolioBaselinePath))
}
elseif ($ComparePortfolioBaseline) {
    $arguments += @('--compare', '--baseline', (Get-PublicNormalizedPath -Path $PortfolioBaselinePath))
}
if (-not [string]::IsNullOrWhiteSpace($ApiTokenPath)) {
    $arguments += @('--api-token-path', (Get-PublicNormalizedPath -Path $ApiTokenPath))
}
if (-not [string]::IsNullOrWhiteSpace($McpTokenPath)) {
    $arguments += @('--mcp-token-path', (Get-PublicNormalizedPath -Path $McpTokenPath))
}
if ($VerifyRateLimit) {
    $arguments += '--verify-rate-limit'
}
if ($ValidateFreePlanRateLimitGate) {
    $arguments += @(
        '--validate-free-rate-limit-gate',
        '--free-rate-limit-evidence',
        (Get-PublicNormalizedPath -Path $FreeRateLimitEvidencePath)
    )
}
if ($ExpectLedgerUnavailable) {
    $arguments += '--expect-ledger-unavailable'
}

$global:LASTEXITCODE = 0
$previousErrorActionPreference = $ErrorActionPreference
try {
    # Windows PowerShell 5.1 promotes native stderr to an ErrorRecord when the
    # caller uses Stop. Capture it so only the helper's allowlisted safe code
    # can cross this wrapper boundary.
    $ErrorActionPreference = 'Continue'
    $captured = @(& $NodeExecutable @arguments 2>&1)
    $exitCode = $LASTEXITCODE
} catch {
    throw 'Public Ledger acceptance could not start its fixed TLS verifier.'
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
$safeOutput = ($captured | ForEach-Object { [string]$_ }) -join "`n"
$captured = $null

if ($exitCode -ne 0) {
    $safeCode = @($safeOutput -split "`r?`n" | Where-Object { $_ -cmatch '^LEDGER_PUBLIC_[A-Z0-9_]+$' } | Select-Object -First 1)
    if ($safeCode.Count -eq 1) {
        throw ('Public Ledger acceptance failed with safe code: ' + $safeCode[0])
    }
    throw 'Public Ledger acceptance failed without a valid redacted status.'
}
if ($safeOutput.Trim() -cne 'LEDGER_PUBLIC_ACCEPTANCE_OK') {
    throw 'Public Ledger acceptance returned an unexpected status.'
}

Write-Output 'LEDGER_PUBLIC_ACCEPTANCE_OK'
