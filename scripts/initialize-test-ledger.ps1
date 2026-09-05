[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ServerBaseUrl = 'http://127.0.0.1:18888',
    [string]$TokenPath = "$env:USERPROFILE\.openclaw\secrets\ezbookkeeping-test-token.txt",
    [string]$TestInstanceMarkerPath = 'D:\Clawbot\ezbookkeeping-test\.clawbot-ledger-test-instance-ready',
    [string]$TestInstallDirectory = 'D:\Clawbot\ezbookkeeping-test',
    [string]$TestConfigPath = 'D:\Clawbot\ezbookkeeping-test\conf\ezbookkeeping-test.ini',
    [string]$ExpectedExecutablePath = 'D:\Clawbot\ezbookkeeping-test\ezbookkeeping.exe',
    [string]$CategoryConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'ledger-runtime-common.ps1')
if ([string]::IsNullOrWhiteSpace($CategoryConfigPath)) {
    $CategoryConfigPath = Join-Path $PSScriptRoot '..\config\expense-categories.json'
}
$strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)

function Invoke-EbkApi {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('GET', 'POST')][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [hashtable]$Body
    )

    $request = @{
        Uri = "$($script:BaseUrl)/api/v1/$Path"
        Method = $Method
        Headers = @{
            Authorization = "Bearer $script:ApiToken"
            'X-Timezone-Name' = 'Asia/Singapore'
        }
        MaximumRedirection = 0
        TimeoutSec = 15
        ErrorAction = 'Stop'
    }
    if ($null -ne $Body) {
        $request.ContentType = 'application/json; charset=utf-8'
        $request.Body = $Body | ConvertTo-Json -Depth 12 -Compress
    }

    try {
        $response = Invoke-RestMethod @request
    } catch {
        throw 'The isolated ezBookkeeping test API request failed.'
    }
    if ($response.success -ne $true) {
        throw 'The isolated ezBookkeeping test API rejected the request.'
    }
    return $response.result
}

function Get-EbkCollectionProperty {
    param(
        [AllowNull()][object]$InputObject,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $InputObject) {
        return @()
    }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return @()
    }
    return @($property.Value)
}

if ($ServerBaseUrl -cne 'http://127.0.0.1:18888') {
    throw 'ServerBaseUrl must be the exact isolated test endpoint http://127.0.0.1:18888.'
}

$TokenPath = Get-LedgerNormalizedPath -Path $TokenPath
$normalizedTestInstall = Get-LedgerNormalizedPath -Path $TestInstallDirectory
$normalizedProductionInstall = Get-LedgerNormalizedPath -Path 'D:\Clawbot\ezbookkeeping'
$productionTokenPath = Get-LedgerNormalizedPath -Path "$env:USERPROFILE\.openclaw\secrets\ezbookkeeping-token.txt"
if (Test-LedgerSamePath -Left $TokenPath -Right $productionTokenPath) {
    throw 'The isolated test initializer refuses the production token path.'
}
foreach ($runtimeRoot in @($normalizedProductionInstall, $normalizedTestInstall)) {
    if ([string]::Equals($TokenPath, $runtimeRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $TokenPath.StartsWith($runtimeRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The isolated test token path overlaps a ledger installation.'
    }
}
if ((Split-Path -Leaf $TokenPath) -cne 'ezbookkeeping-test-token.txt') {
    throw 'The isolated test token file name is invalid.'
}

if (-not (Test-Path -LiteralPath $TestInstanceMarkerPath -PathType Leaf)) {
    throw 'The isolated test instance marker was not found.'
}
Assert-LedgerOwnerOnlyFile -Path $TestInstanceMarkerPath
$marker = [IO.File]::ReadAllText($TestInstanceMarkerPath, $strictUtf8).Trim()
if ($marker -cne 'CLAWBOT_LEDGER_TEST_INSTANCE_READY_V1') {
    throw 'The isolated test instance marker is not ready.'
}
if ((Split-Path -Leaf $TestInstanceMarkerPath) -cne '.clawbot-ledger-test-instance-ready') {
    throw 'The isolated test instance marker name is invalid.'
}
if (-not (Test-LedgerSamePath -Left (Split-Path -Parent $TestInstanceMarkerPath) -Right $normalizedTestInstall)) {
    throw 'The isolated test instance marker is outside the test install directory.'
}
if (-not (Test-Path -LiteralPath $ExpectedExecutablePath -PathType Leaf)) {
    throw 'The isolated test executable was not found.'
}
if (Test-LedgerSamePath -Left $TestInstallDirectory -Right 'D:\Clawbot\ezbookkeeping') {
    throw 'The isolated test install directory overlaps production.'
}
foreach ($runtimePath in @($TestConfigPath, $ExpectedExecutablePath)) {
    $normalizedRuntimePath = Get-LedgerNormalizedPath -Path $runtimePath
    if (-not $normalizedRuntimePath.StartsWith($normalizedTestInstall + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'An isolated test runtime path is outside the test install directory.'
    }
}

Assert-LedgerOwnerOnlyFile -Path $TestConfigPath
$null = Assert-LedgerTestConfiguration -InstallDirectory $TestInstallDirectory -ConfigPath $TestConfigPath
$null = Get-LedgerListenerOwner -Port 18888 -ExpectedExecutable $ExpectedExecutablePath -ExpectedConfigPath $TestConfigPath

if (-not $PSCmdlet.ShouldProcess('isolated ezBookkeeping test instance', 'Initialize test-only account and categories')) {
    return
}

try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:18888/healthz.json' -MaximumRedirection 0 -TimeoutSec 5 -ErrorAction Stop
    if ($health.success -ne $true) {
        throw 'unhealthy'
    }
    $page = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:18888/' -MaximumRedirection 0 -TimeoutSec 5 -ErrorAction Stop
    if ([string]$page.Content -notmatch '(?i)ezBookkeeping') {
        throw 'fingerprint mismatch'
    }
} catch {
    throw 'The isolated test instance did not pass local health and page checks.'
}

if (-not (Test-Path -LiteralPath $TokenPath -PathType Leaf)) {
    throw 'The isolated test API token file was not found.'
}
Assert-LedgerOwnerOnlyFile -Path $TokenPath
if (-not (Test-Path -LiteralPath $CategoryConfigPath -PathType Leaf)) {
    throw 'The category configuration was not found.'
}

$script:BaseUrl = $ServerBaseUrl
$script:ApiToken = [IO.File]::ReadAllText($TokenPath, $strictUtf8).Trim()
if ([string]::IsNullOrWhiteSpace($script:ApiToken) -or $script:ApiToken -match '[\r\n]') {
    throw 'The isolated test API token is invalid.'
}

try {
    $categoryConfig = [IO.File]::ReadAllText($CategoryConfigPath, $strictUtf8) | ConvertFrom-Json -ErrorAction Stop
} catch {
    throw 'The isolated category configuration is not valid UTF-8 JSON.'
}
if ($categoryConfig.currency -cne 'SGD' -or $categoryConfig.timezone -cne 'Asia/Singapore') {
    throw 'Category configuration must use SGD and Asia/Singapore.'
}
$accountName = [string]$categoryConfig.account
if ([string]::IsNullOrWhiteSpace($accountName)) {
    throw 'Category configuration does not define the test account.'
}

$styles = @(
    @{ Icon = '1'; Color = 'ff6b22' },
    @{ Icon = '300'; Color = '009688' },
    @{ Icon = '200'; Color = '000000' },
    @{ Icon = '400'; Color = '2196f3' },
    @{ Icon = '100'; Color = '673ab7' },
    @{ Icon = '500'; Color = 'ff2d55' },
    @{ Icon = '800'; Color = 'ff3b30' },
    @{ Icon = '600'; Color = 'cddc39' },
    @{ Icon = '700'; Color = '4cd964' },
    @{ Icon = '900'; Color = 'ff9500' },
    @{ Icon = '1000'; Color = '8e8e93' }
)
$configuredCategories = @($categoryConfig.categories)
if ($configuredCategories.Count -ne $styles.Count) {
    throw 'Category configuration does not match the expected primary category count.'
}

$accounts = @(Invoke-EbkApi -Method GET -Path 'accounts/list.json')
$matchingAccounts = @($accounts | Where-Object { $_.name -eq $accountName })
if ($matchingAccounts.Count -gt 1) {
    throw 'The isolated test ledger has a duplicate target account.'
}
if ($matchingAccounts.Count -eq 0) {
    $null = Invoke-EbkApi -Method POST -Path 'accounts/add.json' -Body @{
        name = $accountName
        category = 1
        type = 1
        icon = '1'
        color = '1e88e5'
        currency = 'SGD'
        balance = 0
        balanceTime = 0
        comment = 'Clawbot isolated acceptance account'
    }
}

$categoryResponse = Invoke-EbkApi -Method GET -Path 'transaction/categories/list.json'
$expenseCategories = @(Get-EbkCollectionProperty -InputObject $categoryResponse -Name '2')

for ($categoryIndex = 0; $categoryIndex -lt $configuredCategories.Count; $categoryIndex++) {
    $configuredPrimary = $configuredCategories[$categoryIndex]
    $style = $styles[$categoryIndex]
    $primaryMatches = @($expenseCategories | Where-Object { $_.parentId -eq '0' -and $_.name -eq $configuredPrimary.name })
    if ($primaryMatches.Count -gt 1) {
        throw 'The isolated test ledger has a duplicate primary category.'
    }
    if ($primaryMatches.Count -eq 0) {
        $primary = Invoke-EbkApi -Method POST -Path 'transaction/categories/add.json' -Body @{
            name = $configuredPrimary.name
            type = 2
            parentId = '0'
            icon = $style.Icon
            color = $style.Color
            comment = ''
        }
        $expenseCategories += $primary
    } else {
        $primary = $primaryMatches[0]
    }

    $existingSubcategories = @(Get-EbkCollectionProperty -InputObject $primary -Name 'subCategories')
    foreach ($subcategoryName in $configuredPrimary.subcategories) {
        $subcategoryMatches = @($existingSubcategories | Where-Object { $_.name -eq $subcategoryName })
        if ($subcategoryMatches.Count -gt 1) {
            throw 'The isolated test ledger has a duplicate subcategory.'
        }
        if ($subcategoryMatches.Count -eq 0) {
            $createdSubcategory = Invoke-EbkApi -Method POST -Path 'transaction/categories/add.json' -Body @{
                name = $subcategoryName
                type = 2
                parentId = $primary.id
                icon = $style.Icon
                color = $style.Color
                comment = ''
            }
            $existingSubcategories += $createdSubcategory
        }
    }
}

$verifiedAccounts = @(Invoke-EbkApi -Method GET -Path 'accounts/list.json')
$verifiedCategoryResponse = Invoke-EbkApi -Method GET -Path 'transaction/categories/list.json'
$verifiedExpenseCategories = @(Get-EbkCollectionProperty -InputObject $verifiedCategoryResponse -Name '2')
$primaryCount = $verifiedExpenseCategories.Count
$subcategoryCount = @($verifiedExpenseCategories | ForEach-Object {
    @(Get-EbkCollectionProperty -InputObject $_ -Name 'subCategories')
}).Count
$expectedPrimaryCount = $configuredCategories.Count
$expectedSubcategoryCount = @($configuredCategories | ForEach-Object { @($_.subcategories) }).Count

if (@($verifiedAccounts | Where-Object { $_.name -eq $accountName -and $_.currency -eq 'SGD' }).Count -ne 1) {
    throw 'The isolated test account verification failed.'
}
if ($primaryCount -ne $expectedPrimaryCount -or $subcategoryCount -ne $expectedSubcategoryCount) {
    throw 'The isolated test category verification failed.'
}

[pscustomobject]@{
    Status = 'verified'
    Currency = 'SGD'
    PrimaryCategories = $primaryCount
    Subcategories = $subcategoryCount
}
