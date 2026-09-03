[CmdletBinding()]
param(
    [string]$ServerBaseUrl = 'http://127.0.0.1:8180',
    [string]$TokenPath = 'C:\Users\USER\.openclaw\secrets\ezbookkeeping-token.txt',
    [string]$CategoryConfigPath = (Join-Path $PSScriptRoot '..\config\expense-categories.json')
)

$ErrorActionPreference = 'Stop'

function Invoke-EbkApi {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('GET', 'POST')][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [hashtable]$Body
    )

    $headers = @{
        Authorization = "Bearer $script:ApiToken"
        'X-Timezone-Name' = 'Asia/Singapore'
    }
    $uri = "$($script:BaseUrl)/api/v1/$Path"
    $request = @{
        Uri = $uri
        Method = $Method
        Headers = $headers
        UseBasicParsing = $true
    }

    if ($null -ne $Body) {
        $request.ContentType = 'application/json; charset=utf-8'
        $request.Body = $Body | ConvertTo-Json -Depth 12 -Compress
    }

    $response = Invoke-RestMethod @request
    if (-not $response.success) {
        throw "ezBookkeeping API failed for $Method $Path"
    }

    return $response.result
}

if (-not (Test-Path -LiteralPath $TokenPath -PathType Leaf)) {
    throw "API token file not found: $TokenPath"
}

if (-not (Test-Path -LiteralPath $CategoryConfigPath -PathType Leaf)) {
    throw "Category config not found: $CategoryConfigPath"
}

$script:BaseUrl = $ServerBaseUrl.TrimEnd('/')
$script:ApiToken = [System.IO.File]::ReadAllText($TokenPath).Trim()
if ([string]::IsNullOrWhiteSpace($script:ApiToken)) {
    throw 'API token file is empty.'
}

$categoryConfig = Get-Content -LiteralPath $CategoryConfigPath -Encoding UTF8 -Raw | ConvertFrom-Json
if ($categoryConfig.currency -ne 'SGD' -or $categoryConfig.timezone -ne 'Asia/Singapore') {
    throw 'Category config must use SGD and Asia/Singapore.'
}

$styleByPrimaryCategory = @{
    '食品酒水' = @{ Icon = '1'; Color = 'ff6b22' }
    '行车交通' = @{ Icon = '300'; Color = '009688' }
    '居家物业' = @{ Icon = '200'; Color = '000000' }
    '交流通讯' = @{ Icon = '400'; Color = '2196f3' }
    '衣服饰品' = @{ Icon = '100'; Color = '673ab7' }
    '休闲娱乐' = @{ Icon = '500'; Color = 'ff2d55' }
    '医疗保健' = @{ Icon = '800'; Color = 'ff3b30' }
    '学习进修' = @{ Icon = '600'; Color = 'cddc39' }
    '人情往来' = @{ Icon = '700'; Color = '4cd964' }
    '金融保险' = @{ Icon = '900'; Color = 'ff9500' }
    '其他杂项' = @{ Icon = '1000'; Color = '8e8e93' }
}

$accounts = @(Invoke-EbkApi -Method GET -Path 'accounts/list.json')
$matchingAccounts = @($accounts | Where-Object { $_.name -eq '日常支出' })
if ($matchingAccounts.Count -gt 1) {
    throw 'More than one account named 日常支出 exists.'
}

if ($matchingAccounts.Count -eq 0) {
    $null = Invoke-EbkApi -Method POST -Path 'accounts/add.json' -Body @{
        name = '日常支出'
        category = 1
        type = 1
        icon = '1'
        color = '1e88e5'
        currency = 'SGD'
        balance = 0
        balanceTime = 0
        comment = '微信自动记账测试账户'
    }
}

$categoryResponse = Invoke-EbkApi -Method GET -Path 'transaction/categories/list.json'
$expenseCategories = @()
if ($null -ne $categoryResponse -and $null -ne $categoryResponse.'2') {
    $expenseCategories = @($categoryResponse.'2')
}

foreach ($configuredPrimary in $categoryConfig.categories) {
    $style = $styleByPrimaryCategory[$configuredPrimary.name]
    if ($null -eq $style) {
        throw "No visual style configured for primary category: $($configuredPrimary.name)"
    }

    $primaryMatches = @($expenseCategories | Where-Object {
        $_.parentId -eq '0' -and $_.name -eq $configuredPrimary.name
    })
    if ($primaryMatches.Count -gt 1) {
        throw "Duplicate primary category: $($configuredPrimary.name)"
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
    }
    else {
        $primary = $primaryMatches[0]
    }

    $existingSubcategories = @($primary.subCategories)
    foreach ($subcategoryName in $configuredPrimary.subcategories) {
        $subcategoryMatches = @($existingSubcategories | Where-Object { $_.name -eq $subcategoryName })
        if ($subcategoryMatches.Count -gt 1) {
            throw "Duplicate subcategory: $($configuredPrimary.name)/$subcategoryName"
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
$verifiedExpenseCategories = @($verifiedCategoryResponse.'2')
$primaryCount = $verifiedExpenseCategories.Count
$subcategoryCount = @($verifiedExpenseCategories | ForEach-Object { @($_.subCategories) }).Count

$expectedPrimaryCount = @($categoryConfig.categories).Count
$expectedSubcategoryCount = @($categoryConfig.categories | ForEach-Object { @($_.subcategories) }).Count

if (@($verifiedAccounts | Where-Object { $_.name -eq '日常支出' -and $_.currency -eq 'SGD' }).Count -ne 1) {
    throw 'Test account verification failed.'
}
if ($primaryCount -ne $expectedPrimaryCount -or $subcategoryCount -ne $expectedSubcategoryCount) {
    throw "Category verification failed: expected $expectedPrimaryCount/$expectedSubcategoryCount, got $primaryCount/$subcategoryCount."
}

[pscustomobject]@{
    Account = '日常支出'
    Currency = 'SGD'
    PrimaryCategories = $primaryCount
    Subcategories = $subcategoryCount
    Status = 'verified'
}
