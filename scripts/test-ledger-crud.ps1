[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [string]$Mode = 'Test',
    [string]$ServerBaseUrl,
    [string]$TokenPath,
    [string]$InstallDirectory,
    [string]$ConfigPath,
    [string]$ExpectedExecutablePath,
    [string]$ReadyMarkerPath,
    [string]$CommonScriptPath,
    [int]$RequestTimeoutSec = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:FailureCode = 'LEDGER_CRUD_ARGUMENTS_INVALID'
$script:BaseUrl = $null
$script:ApiToken = $null
$script:StrictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)

function Get-CrudNormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'invalid path'
    }
    $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim())
    $fullPath = [IO.Path]::GetFullPath($expanded)
    if ($fullPath.Length -gt 3) {
        $fullPath = $fullPath.TrimEnd([char[]]@('\', '/'))
    }
    return $fullPath
}

function Test-CrudSamePath {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )

    return [string]::Equals(
        (Get-CrudNormalizedPath -Path $Left),
        (Get-CrudNormalizedPath -Path $Right),
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Get-LedgerPropertyValue {
    param(
        [AllowNull()][object]$InputObject,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function ConvertTo-LedgerCanonicalJson {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) { return 'null' }
    if ($Value -is [string] -or $Value -is [char]) {
        return ($Value.ToString() | ConvertTo-Json -Compress)
    }
    if ($Value -is [bool]) {
        if ([bool]$Value) { return 'true' }
        return 'false'
    }
    if ($Value -is [byte] -or $Value -is [sbyte] -or
        $Value -is [int16] -or $Value -is [uint16] -or
        $Value -is [int32] -or $Value -is [uint32] -or
        $Value -is [int64] -or $Value -is [uint64] -or
        $Value -is [decimal]) {
        return [Convert]::ToString($Value, [Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [double]) {
        return ([double]$Value).ToString('R', [Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [single]) {
        return ([single]$Value).ToString('R', [Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [Collections.IDictionary]) {
        $parts = New-Object 'Collections.Generic.List[string]'
        foreach ($key in @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object)) {
            $encodedKey = $key | ConvertTo-Json -Compress
            $encodedValue = ConvertTo-LedgerCanonicalJson -Value $Value[$key]
            $parts.Add($encodedKey + ':' + $encodedValue) | Out-Null
        }
        return '{' + [string]::Join(',', $parts.ToArray()) + '}'
    }
    if ($Value -is [Collections.IEnumerable]) {
        $parts = New-Object 'Collections.Generic.List[string]'
        foreach ($item in $Value) {
            $parts.Add((ConvertTo-LedgerCanonicalJson -Value $item)) | Out-Null
        }
        return '[' + [string]::Join(',', $parts.ToArray()) + ']'
    }

    $propertyParts = New-Object 'Collections.Generic.List[string]'
    foreach ($property in @($Value.PSObject.Properties | Where-Object { $_.MemberType -match 'Property' } | Sort-Object Name)) {
        $encodedName = ([string]$property.Name) | ConvertTo-Json -Compress
        $encodedValue = ConvertTo-LedgerCanonicalJson -Value $property.Value
        $propertyParts.Add($encodedName + ':' + $encodedValue) | Out-Null
    }
    return '{' + [string]::Join(',', $propertyParts.ToArray()) + '}'
}

function Get-LedgerCanonicalSha256 {
    param([AllowNull()][object]$Value)

    $canonical = ConvertTo-LedgerCanonicalJson -Value $Value
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($canonical)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally {
        if ($bytes.Length -gt 0) { [Array]::Clear($bytes, 0, $bytes.Length) }
        $canonical = $null
        $algorithm.Dispose()
    }
}

function Get-LedgerApiUri {
    param(
        [Parameter(Mandatory = $true)][string]$Route,
        [hashtable]$Query
    )

    $allowedRoutes = @(
        'accounts/list.json',
        'transaction/categories/list.json',
        'transactions/list/all.json',
        'transactions/add.json',
        'transactions/get.json',
        'transactions/modify.json',
        'transactions/delete.json'
    )
    if ($allowedRoutes -cnotcontains $Route) {
        throw 'route rejected'
    }

    $uri = $script:BaseUrl + '/api/v1/' + $Route
    if ($null -ne $Query -and $Query.Count -gt 0) {
        $allowedQueryKeys = if ($Route -ceq 'transactions/get.json') {
            @('id', 'with_pictures', 'trim_account', 'trim_category', 'trim_tag')
        } elseif ($Route -ceq 'transactions/list/all.json') {
            @('keyword', 'match_mode', 'with_pictures', 'trim_account', 'trim_category', 'trim_tag')
        } else {
            @()
        }
        $pairs = New-Object 'Collections.Generic.List[string]'
        foreach ($key in @($Query.Keys | ForEach-Object { [string]$_ } | Sort-Object)) {
            if ($allowedQueryKeys -cnotcontains $key) { throw 'query rejected' }
            $pairs.Add(
                [Uri]::EscapeDataString($key) + '=' + [Uri]::EscapeDataString([string]$Query[$key])
            ) | Out-Null
        }
        $uri += '?' + [string]::Join('&', $pairs.ToArray())
    }
    return $uri
}

function Invoke-LedgerApiRaw {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Route,
        [hashtable]$Query,
        [Collections.IDictionary]$Body
    )

    if ($Method -cne 'GET' -and $Method -cne 'POST') { throw 'method rejected' }
    $postRoutes = @('transactions/add.json', 'transactions/modify.json', 'transactions/delete.json')
    if (($Method -ceq 'POST') -ne ($postRoutes -ccontains $Route)) { throw 'method and route mismatch' }
    if ($Method -ceq 'GET' -and $null -ne $Body) { throw 'GET body rejected' }
    if ($Method -ceq 'POST' -and $null -eq $Body) { throw 'POST body required' }

    $request = @{
        Uri = Get-LedgerApiUri -Route $Route -Query $Query
        Method = $Method
        Headers = @{
            Authorization = 'Bearer ' + $script:ApiToken
            'X-Timezone-Name' = 'Asia/Singapore'
        }
        MaximumRedirection = 0
        TimeoutSec = $RequestTimeoutSec
        UseBasicParsing = $true
        ErrorAction = 'Stop'
    }
    if ($Method -ceq 'POST') {
        $request.ContentType = 'application/json; charset=utf-8'
        $request.Body = $Body | ConvertTo-Json -Depth 8 -Compress
    }

    try {
        $response = Invoke-WebRequest @request
    } catch {
        $statusCode = 0
        try {
            if ($null -ne $_.Exception.Response) {
                $statusCode = [int]$_.Exception.Response.StatusCode
            }
        } catch {
            $statusCode = 0
        }
        return [pscustomobject]@{
            HttpStatus = $statusCode
            Success = $false
            Result = $null
        }
    }

    try {
        $payload = [string]$response.Content | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw 'response rejected'
    }
    return [pscustomobject]@{
        HttpStatus = [int]$response.StatusCode
        Success = (Get-LedgerPropertyValue -InputObject $payload -Name 'success') -eq $true
        Result = Get-LedgerPropertyValue -InputObject $payload -Name 'result'
    }
}

function Invoke-LedgerApiRequired {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Route,
        [hashtable]$Query,
        [Collections.IDictionary]$Body
    )

    $response = Invoke-LedgerApiRaw -Method $Method -Route $Route -Query $Query -Body $Body
    if ($response.HttpStatus -ne 200 -or $response.Success -ne $true) {
        throw 'required API operation failed'
    }
    return $response.Result
}

function Get-LedgerNestedItemCount {
    param(
        [object[]]$Items,
        [Parameter(Mandatory = $true)][string]$ChildProperty
    )

    $count = 0
    foreach ($item in @($Items)) {
        if ($null -eq $item) { continue }
        $count += 1
        $children = Get-LedgerPropertyValue -InputObject $item -Name $ChildProperty
        if ($null -ne $children) {
            $count += Get-LedgerNestedItemCount -Items @($children) -ChildProperty $ChildProperty
        }
    }
    return $count
}

function Get-LedgerSnapshot {
    $accounts = @(Invoke-LedgerApiRequired -Method GET -Route 'accounts/list.json')
    $categories = Invoke-LedgerApiRequired -Method GET -Route 'transaction/categories/list.json'
    $transactions = @(Invoke-LedgerApiRequired -Method GET -Route 'transactions/list/all.json' -Query @{
        with_pictures = 'false'
        trim_account = 'false'
        trim_category = 'false'
        trim_tag = 'false'
    })
    $categoryGroups = @()
    if ($null -ne $categories) {
        foreach ($property in @($categories.PSObject.Properties | Where-Object { $_.MemberType -match 'Property' })) {
            $categoryGroups += @($property.Value)
        }
    }
    return [pscustomobject]@{
        Accounts = $accounts
        Categories = $categories
        Transactions = $transactions
        AccountsHash = Get-LedgerCanonicalSha256 -Value $accounts
        CategoriesHash = Get-LedgerCanonicalSha256 -Value $categories
        TransactionsHash = Get-LedgerCanonicalSha256 -Value $transactions
        AccountsCount = Get-LedgerNestedItemCount -Items $accounts -ChildProperty 'subAccounts'
        CategoriesCount = Get-LedgerNestedItemCount -Items $categoryGroups -ChildProperty 'subCategories'
        TransactionsCount = $transactions.Count
    }
}

function Test-LedgerSnapshotRestored {
    param(
        [Parameter(Mandatory = $true)][object]$Before,
        [Parameter(Mandatory = $true)][object]$After
    )

    return $Before.AccountsCount -eq $After.AccountsCount -and
        $Before.CategoriesCount -eq $After.CategoriesCount -and
        $Before.TransactionsCount -eq $After.TransactionsCount -and
        [string]$Before.AccountsHash -ceq [string]$After.AccountsHash -and
        [string]$Before.CategoriesHash -ceq [string]$After.CategoriesHash -and
        [string]$Before.TransactionsHash -ceq [string]$After.TransactionsHash
}

function Add-LedgerVisibleAccounts {
    param(
        [object[]]$Items,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][Collections.Generic.List[object]]$Destination
    )

    foreach ($item in @($Items)) {
        if ($null -eq $item) { continue }
        $id = [string](Get-LedgerPropertyValue -InputObject $item -Name 'id')
        $type = [int](Get-LedgerPropertyValue -InputObject $item -Name 'type')
        $currency = [string](Get-LedgerPropertyValue -InputObject $item -Name 'currency')
        $hidden = Get-LedgerPropertyValue -InputObject $item -Name 'hidden'
        if ($id -match '^[1-9][0-9]*$' -and $type -eq 1 -and $currency -ceq 'SGD' -and $hidden -ne $true) {
            $Destination.Add($item) | Out-Null
        }
        $children = Get-LedgerPropertyValue -InputObject $item -Name 'subAccounts'
        if ($null -ne $children) {
            Add-LedgerVisibleAccounts -Items @($children) -Destination $Destination
        }
    }
}

function Get-LedgerTargetAccountId {
    param([Parameter(Mandatory = $true)][object[]]$Accounts)

    $eligible = New-Object 'Collections.Generic.List[object]'
    Add-LedgerVisibleAccounts -Items $Accounts -Destination $eligible
    if ($eligible.Count -lt 1) { throw 'no eligible account' }
    $selected = @($eligible.ToArray() | Sort-Object { [decimal]([string](Get-LedgerPropertyValue -InputObject $_ -Name 'id')) })[0]
    return [string](Get-LedgerPropertyValue -InputObject $selected -Name 'id')
}

function Get-LedgerTargetCategoryId {
    param([Parameter(Mandatory = $true)][object]$Categories)

    if ($null -eq $Categories) { throw 'no categories' }
    $expenseProperty = $Categories.PSObject.Properties['2']
    if ($null -eq $expenseProperty) { throw 'no expense categories' }
    $eligible = New-Object 'Collections.Generic.List[object]'
    foreach ($primary in @($expenseProperty.Value)) {
        if ($null -eq $primary -or (Get-LedgerPropertyValue -InputObject $primary -Name 'hidden') -eq $true) { continue }
        $primaryId = [string](Get-LedgerPropertyValue -InputObject $primary -Name 'id')
        if ($primaryId -notmatch '^[1-9][0-9]*$') { continue }
        $children = Get-LedgerPropertyValue -InputObject $primary -Name 'subCategories'
        foreach ($child in @($children)) {
            if ($null -eq $child -or (Get-LedgerPropertyValue -InputObject $child -Name 'hidden') -eq $true) { continue }
            $childId = [string](Get-LedgerPropertyValue -InputObject $child -Name 'id')
            $childParentId = [string](Get-LedgerPropertyValue -InputObject $child -Name 'parentId')
            if ($childId -match '^[1-9][0-9]*$' -and $childParentId -ceq $primaryId) {
                $eligible.Add($child) | Out-Null
            }
        }
    }
    if ($eligible.Count -lt 1) { throw 'no eligible category' }
    $selected = @($eligible.ToArray() | Sort-Object { [decimal]([string](Get-LedgerPropertyValue -InputObject $_ -Name 'id')) })[0]
    return [string](Get-LedgerPropertyValue -InputObject $selected -Name 'id')
}

function Test-LedgerTransactionMatches {
    param(
        [Parameter(Mandatory = $true)][object]$Transaction,
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$AccountId,
        [Parameter(Mandatory = $true)][string]$CategoryId,
        [Parameter(Mandatory = $true)][int64]$Amount,
        [Parameter(Mandatory = $true)][string]$Marker
    )

    return [string](Get-LedgerPropertyValue -InputObject $Transaction -Name 'id') -ceq $Id -and
        [int](Get-LedgerPropertyValue -InputObject $Transaction -Name 'type') -eq 3 -and
        [string](Get-LedgerPropertyValue -InputObject $Transaction -Name 'sourceAccountId') -ceq $AccountId -and
        [string](Get-LedgerPropertyValue -InputObject $Transaction -Name 'categoryId') -ceq $CategoryId -and
        [int64](Get-LedgerPropertyValue -InputObject $Transaction -Name 'sourceAmount') -eq $Amount -and
        [string](Get-LedgerPropertyValue -InputObject $Transaction -Name 'comment') -ceq $Marker
}

function Get-LedgerMarkerTransactions {
    param([Parameter(Mandatory = $true)][string]$Marker)

    $transactions = @(Invoke-LedgerApiRequired -Method GET -Route 'transactions/list/all.json' -Query @{
        keyword = $Marker
        match_mode = '0'
        with_pictures = 'false'
        trim_account = 'true'
        trim_category = 'true'
        trim_tag = 'true'
    })
    foreach ($transaction in $transactions) {
        if ($null -ne $transaction -and [string]$transaction.comment -ceq $marker) {
            Write-Output $transaction
        }
    }
}

function Assert-LedgerTransactionAbsent {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Marker
    )

    $getResponse = Invoke-LedgerApiRaw -Method GET -Route 'transactions/get.json' -Query @{
        id = $Id
        with_pictures = 'false'
        trim_account = 'true'
        trim_category = 'true'
        trim_tag = 'true'
    }
    if ($getResponse.HttpStatus -ne 400 -or $getResponse.Success -eq $true) {
        throw 'transaction still present or absence unverified'
    }
    $markerMatches = @(Get-LedgerMarkerTransactions -Marker $Marker)
    if ($markerMatches.Count -ne 0) {
        throw 'marker still present'
    }
}

function Invoke-LedgerExactCleanup {
    param(
        [AllowNull()][string]$CapturedId,
        [Parameter(Mandatory = $true)][string]$Marker,
        [Parameter(Mandatory = $true)][object]$Baseline
    )

    $matches = @(Get-LedgerMarkerTransactions -Marker $Marker)
    if ($matches.Count -gt 1) { throw 'ambiguous marker' }

    $cleanupId = $CapturedId
    if ($matches.Count -eq 1) {
        $matchedId = [string](Get-LedgerPropertyValue -InputObject $matches[0] -Name 'id')
        if ($matchedId -notmatch '^[1-9][0-9]*$') { throw 'invalid cleanup id' }
        if (-not [string]::IsNullOrWhiteSpace($cleanupId) -and $cleanupId -cne $matchedId) {
            throw 'captured id and marker disagree'
        }
        $cleanupId = $matchedId
    }

    if (-not [string]::IsNullOrWhiteSpace($cleanupId)) {
        $getResponse = Invoke-LedgerApiRaw -Method GET -Route 'transactions/get.json' -Query @{
            id = $cleanupId
            with_pictures = 'false'
            trim_account = 'true'
            trim_category = 'true'
            trim_tag = 'true'
        }
        if ($getResponse.HttpStatus -eq 200 -and $getResponse.Success -eq $true) {
            $actualId = [string](Get-LedgerPropertyValue -InputObject $getResponse.Result -Name 'id')
            $actualMarker = [string](Get-LedgerPropertyValue -InputObject $getResponse.Result -Name 'comment')
            if ($actualId -cne $cleanupId -or $actualMarker -cne $Marker) { throw 'cleanup identity mismatch' }
            $null = Invoke-LedgerApiRequired -Method POST -Route 'transactions/delete.json' -Body ([ordered]@{
                id = $cleanupId
            })
        } elseif ($getResponse.HttpStatus -ne 400 -or $matches.Count -ne 0) {
            throw 'cleanup lookup failed'
        }
        Assert-LedgerTransactionAbsent -Id $cleanupId -Marker $Marker
    } elseif ($matches.Count -ne 0) {
        throw 'cleanup id unresolved'
    } else {
        $remaining = @(Get-LedgerMarkerTransactions -Marker $Marker)
        if ($remaining.Count -ne 0) { throw 'marker absence unverified' }
    }

    $afterCleanup = Get-LedgerSnapshot
    if (-not (Test-LedgerSnapshotRestored -Before $Baseline -After $afterCleanup)) {
        throw 'cleanup baseline mismatch'
    }
}

function Assert-LedgerProductionConfiguration {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$ProductionConfigPath
    )

    $document = Get-LedgerIniDocument -Path $ProductionConfigPath
    $required = @{
        'global.mode' = 'production'
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
        if ($actual -cne $required[$key]) { throw 'production configuration mismatch' }
    }
    if ($document.Text -notmatch '(?m)^; CLAWBOT_LEDGER_PROFILE=production\s*$') {
        throw 'production profile marker missing'
    }
    $enableMcp = Get-LedgerIniValue -Document $document -Section 'mcp' -Name 'enable_mcp'
    if ($enableMcp -cne 'true' -and $enableMcp -cne 'false') { throw 'invalid MCP setting' }
    $secretKey = Get-LedgerIniValue -Document $document -Section 'security' -Name 'secret_key'
    if ([string]::IsNullOrWhiteSpace($secretKey) -or $secretKey.StartsWith('__')) { throw 'invalid signing secret' }

    $expectedDatabase = Get-LedgerNormalizedPath -Path (Join-Path $InstallRoot 'data\ezbookkeeping.db')
    $actualDatabase = Resolve-LedgerDataPath -InstallDirectory $InstallRoot -ConfiguredPath (
        Get-LedgerIniValue -Document $document -Section 'database' -Name 'db_path'
    )
    if (-not (Test-LedgerSamePath -Left $expectedDatabase -Right $actualDatabase)) {
        throw 'production database path mismatch'
    }
}

function Assert-LedgerModeConfiguration {
    param(
        [Parameter(Mandatory = $true)][string]$SelectedMode,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$SelectedConfigPath,
        [Parameter(Mandatory = $true)][string]$ExecutablePath,
        [AllowEmptyString()][string]$MarkerPath
    )

    Assert-LedgerNoConfigurationOverrides -SettingNames @(
        'GLOBAL_MODE',
        'UUID_GENERATOR_TYPE', 'UUID_SERVER_ID',
        'DUPLICATE_CHECKER_CHECKER_TYPE', 'DUPLICATE_CHECKER_CLEANUP_INTERVAL', 'DUPLICATE_CHECKER_DUPLICATE_SUBMISSIONS_INTERVAL',
        'SERVER_PROTOCOL', 'SERVER_HTTP_ADDR', 'SERVER_HTTP_PORT', 'SERVER_DOMAIN', 'SERVER_ROOT_URL',
        'MCP_ENABLE_MCP', 'MCP_MCP_ALLOWED_REMOTE_IPS',
        'DATABASE_TYPE', 'DATABASE_DB_PATH',
        'SECURITY_TRUSTED_PROXY_IPS', 'SECURITY_TOKEN_EXPIRED_TIME', 'SECURITY_TOKEN_MIN_REFRESH_INTERVAL',
        'SECURITY_ENABLE_API_TOKEN', 'SECURITY_API_TOKEN_ALLOWED_REMOTE_IPS',
        'SECURITY_MAX_FAILURES_PER_IP_PER_MINUTE', 'SECURITY_MAX_FAILURES_PER_USER_PER_MINUTE',
        'AUTH_ENABLE_INTERNAL_AUTH', 'AUTH_ENABLE_OAUTH2_AUTH', 'AUTH_ENABLE_TWO_FACTOR', 'AUTH_ENABLE_FORGET_PASSWORD',
        'AUTH_OAUTH2_USER_IDENTIFIER', 'USER_ENABLE_REGISTER', 'MAP_AMAP_SECURITY_VERIFICATION_METHOD',
        'EXCHANGE_RATES_DATA_SOURCE'
    )
    if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) { throw 'missing executable' }
    Assert-LedgerOwnerOnlyFile -Path $SelectedConfigPath

    if ($SelectedMode -ceq 'Test') {
        Assert-LedgerOwnerOnlyFile -Path $MarkerPath
        $markerText = [IO.File]::ReadAllText($MarkerPath, $script:StrictUtf8).Trim()
        if ($markerText -cne 'CLAWBOT_LEDGER_TEST_INSTANCE_READY_V1') { throw 'invalid ready marker' }
        $document = Assert-LedgerTestConfiguration -InstallDirectory $InstallRoot -ConfigPath $SelectedConfigPath
        $expectedDatabase = Get-LedgerNormalizedPath -Path (Join-Path $InstallRoot 'data\ezbookkeeping-test.db')
        $actualDatabase = Resolve-LedgerDataPath -InstallDirectory $InstallRoot -ConfiguredPath (
            Get-LedgerIniValue -Document $document -Section 'database' -Name 'db_path'
        )
        if (-not (Test-LedgerSamePath -Left $expectedDatabase -Right $actualDatabase)) {
            throw 'test database path mismatch'
        }
        $null = Get-LedgerListenerOwner -Port 18888 -ExpectedExecutable $ExecutablePath -ExpectedConfigPath $SelectedConfigPath
        if (-not (Test-LedgerOrigin -Port 18888)) { throw 'test origin unhealthy' }
    } else {
        Assert-LedgerProductionConfiguration -InstallRoot $InstallRoot -ProductionConfigPath $SelectedConfigPath
        $null = Get-LedgerListenerOwner -Port 8888 -ExpectedExecutable $ExecutablePath -ExpectedConfigPath $SelectedConfigPath
        if (-not (Test-LedgerOrigin -Port 8888)) { throw 'production origin unhealthy' }
    }
}

function Initialize-LedgerCrudArguments {
    if ($Mode -cne 'Test' -and $Mode -cne 'Production') { throw 'invalid mode' }
    if ($RequestTimeoutSec -lt 1 -or $RequestTimeoutSec -gt 60) { throw 'invalid timeout' }
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable('USERPROFILE'))) { throw 'missing profile' }

    $expectedCommon = Get-CrudNormalizedPath -Path (Join-Path $PSScriptRoot 'ledger-runtime-common.ps1')
    if ([string]::IsNullOrWhiteSpace($CommonScriptPath)) { $script:ResolvedCommon = $expectedCommon }
    else { $script:ResolvedCommon = Get-CrudNormalizedPath -Path $CommonScriptPath }
    if (-not (Test-CrudSamePath -Left $script:ResolvedCommon -Right $expectedCommon)) { throw 'helper mismatch' }

    if ($Mode -ceq 'Test') {
        $expectedBaseUrl = 'http://127.0.0.1:18888'
        $expectedInstall = 'D:\Clawbot\ezbookkeeping-test'
        $expectedConfig = 'D:\Clawbot\ezbookkeeping-test\conf\ezbookkeeping-test.ini'
        $expectedExecutable = 'D:\Clawbot\ezbookkeeping-test\ezbookkeeping.exe'
        $expectedMarker = 'D:\Clawbot\ezbookkeeping-test\.clawbot-ledger-test-instance-ready'
        $expectedToken = Join-Path ([Environment]::GetEnvironmentVariable('USERPROFILE')) '.openclaw\secrets\ezbookkeeping-test-token.txt'
    } else {
        $expectedBaseUrl = 'http://127.0.0.1:8888'
        $expectedInstall = 'D:\Clawbot\ezbookkeeping'
        $expectedConfig = 'D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini'
        $expectedExecutable = 'D:\Clawbot\ezbookkeeping\ezbookkeeping.exe'
        $expectedMarker = ''
        $expectedToken = Join-Path ([Environment]::GetEnvironmentVariable('USERPROFILE')) '.openclaw\secrets\ezbookkeeping-token.txt'
    }

    if ([string]::IsNullOrWhiteSpace($ServerBaseUrl)) { $script:ResolvedBaseUrl = $expectedBaseUrl }
    else { $script:ResolvedBaseUrl = $ServerBaseUrl }
    if ([string]::IsNullOrWhiteSpace($InstallDirectory)) { $script:ResolvedInstall = Get-CrudNormalizedPath -Path $expectedInstall }
    else { $script:ResolvedInstall = Get-CrudNormalizedPath -Path $InstallDirectory }
    if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $script:ResolvedConfig = Get-CrudNormalizedPath -Path $expectedConfig }
    else { $script:ResolvedConfig = Get-CrudNormalizedPath -Path $ConfigPath }
    if ([string]::IsNullOrWhiteSpace($ExpectedExecutablePath)) { $script:ResolvedExecutable = Get-CrudNormalizedPath -Path $expectedExecutable }
    else { $script:ResolvedExecutable = Get-CrudNormalizedPath -Path $ExpectedExecutablePath }
    if ([string]::IsNullOrWhiteSpace($TokenPath)) { $script:ResolvedToken = Get-CrudNormalizedPath -Path $expectedToken }
    else { $script:ResolvedToken = Get-CrudNormalizedPath -Path $TokenPath }
    if ($Mode -ceq 'Test') {
        if ([string]::IsNullOrWhiteSpace($ReadyMarkerPath)) { $script:ResolvedMarker = Get-CrudNormalizedPath -Path $expectedMarker }
        else { $script:ResolvedMarker = Get-CrudNormalizedPath -Path $ReadyMarkerPath }
    } else {
        if (-not [string]::IsNullOrWhiteSpace($ReadyMarkerPath)) { throw 'production marker rejected' }
        $script:ResolvedMarker = ''
    }

    if ($script:ResolvedBaseUrl -cne $expectedBaseUrl -or
        -not (Test-CrudSamePath -Left $script:ResolvedInstall -Right $expectedInstall) -or
        -not (Test-CrudSamePath -Left $script:ResolvedConfig -Right $expectedConfig) -or
        -not (Test-CrudSamePath -Left $script:ResolvedExecutable -Right $expectedExecutable) -or
        -not (Test-CrudSamePath -Left $script:ResolvedToken -Right $expectedToken) -or
        ($Mode -ceq 'Test' -and -not (Test-CrudSamePath -Left $script:ResolvedMarker -Right $expectedMarker))) {
        throw 'runtime boundary mismatch'
    }
}

function Invoke-LedgerCrudAcceptance {
    $script:FailureCode = 'LEDGER_CRUD_PREFLIGHT_FAILED'
    if (-not (Test-Path -LiteralPath $script:ResolvedCommon -PathType Leaf)) { throw 'missing helper' }
    . $script:ResolvedCommon

    Assert-LedgerModeConfiguration `
        -SelectedMode $Mode `
        -InstallRoot $script:ResolvedInstall `
        -SelectedConfigPath $script:ResolvedConfig `
        -ExecutablePath $script:ResolvedExecutable `
        -MarkerPath $script:ResolvedMarker

    Assert-LedgerOwnerOnlyFile -Path $script:ResolvedToken
    $script:FailureCode = 'LEDGER_CRUD_TOKEN_INVALID'
    $tokenBytes = [IO.File]::ReadAllBytes($script:ResolvedToken)
    try {
        $script:ApiToken = $script:StrictUtf8.GetString($tokenBytes).Trim()
    } finally {
        if ($tokenBytes.Length -gt 0) { [Array]::Clear($tokenBytes, 0, $tokenBytes.Length) }
    }
    if ([string]::IsNullOrWhiteSpace($script:ApiToken) -or $script:ApiToken -match '[\r\n]') {
        throw 'invalid token'
    }
    $script:BaseUrl = $script:ResolvedBaseUrl

    $script:FailureCode = 'LEDGER_CRUD_BASELINE_FAILED'
    $script:Baseline = Get-LedgerSnapshot
    $accountId = Get-LedgerTargetAccountId -Accounts $script:Baseline.Accounts
    $categoryId = Get-LedgerTargetCategoryId -Categories $script:Baseline.Categories
    $guid = [Guid]::NewGuid().ToString('N')
    $marker = 'CLAWBOT_LEDGER_CRUD_' + $guid
    $transactionTime = [int64][Math]::Floor(([DateTime]::UtcNow - [DateTime]'1970-01-01T00:00:00Z').TotalSeconds)
    $script:CleanupMarker = $marker

    $createBody = [ordered]@{
        type = 3
        categoryId = $categoryId
        time = $transactionTime
        utcOffset = 480
        sourceAccountId = $accountId
        sourceAmount = 1
        destinationAccountId = '0'
        destinationAmount = 0
        hideAmount = $false
        tagIds = @()
        pictureIds = @()
        comment = $marker
        clientSessionId = $guid
    }
    $script:FailureCode = 'LEDGER_CRUD_CREATE_FAILED'
    $script:CleanupMayBeRequired = $true
    $created = Invoke-LedgerApiRequired -Method POST -Route 'transactions/add.json' -Body $createBody
    $script:CreatedTransactionId = [string](Get-LedgerPropertyValue -InputObject $created -Name 'id')
    if ($script:CreatedTransactionId -notmatch '^[1-9][0-9]*$') { throw 'invalid created id' }

    $script:FailureCode = 'LEDGER_CRUD_CREATE_VERIFY_FAILED'
    $createdGet = Invoke-LedgerApiRequired -Method GET -Route 'transactions/get.json' -Query @{
        id = $script:CreatedTransactionId
        with_pictures = 'false'
        trim_account = 'true'
        trim_category = 'true'
        trim_tag = 'true'
    }
    if (-not (Test-LedgerTransactionMatches -Transaction $createdGet -Id $script:CreatedTransactionId `
        -AccountId $accountId -CategoryId $categoryId -Amount 1 -Marker $marker)) {
        throw 'created transaction mismatch'
    }

    $modifyBody = [ordered]@{
        id = $script:CreatedTransactionId
        type = 3
        categoryId = $categoryId
        time = $transactionTime
        utcOffset = 480
        sourceAccountId = $accountId
        sourceAmount = 2
        destinationAccountId = '0'
        destinationAmount = 0
        hideAmount = $false
        tagIds = @()
        pictureIds = @()
        comment = $marker
    }
    $script:FailureCode = 'LEDGER_CRUD_MODIFY_FAILED'
    $modified = Invoke-LedgerApiRequired -Method POST -Route 'transactions/modify.json' -Body $modifyBody
    if (-not (Test-LedgerTransactionMatches -Transaction $modified -Id $script:CreatedTransactionId `
        -AccountId $accountId -CategoryId $categoryId -Amount 2 -Marker $marker)) {
        throw 'modified response mismatch'
    }

    $script:FailureCode = 'LEDGER_CRUD_MODIFY_VERIFY_FAILED'
    $modifiedGet = Invoke-LedgerApiRequired -Method GET -Route 'transactions/get.json' -Query @{
        id = $script:CreatedTransactionId
        with_pictures = 'false'
        trim_account = 'true'
        trim_category = 'true'
        trim_tag = 'true'
    }
    if (-not (Test-LedgerTransactionMatches -Transaction $modifiedGet -Id $script:CreatedTransactionId `
        -AccountId $accountId -CategoryId $categoryId -Amount 2 -Marker $marker)) {
        throw 'modified transaction mismatch'
    }

    $script:FailureCode = 'LEDGER_CRUD_DELETE_FAILED'
    $deleteResult = Invoke-LedgerApiRequired -Method POST -Route 'transactions/delete.json' -Body ([ordered]@{
        id = $script:CreatedTransactionId
    })
    if ($deleteResult -ne $true) { throw 'delete response mismatch' }

    $script:FailureCode = 'LEDGER_CRUD_DELETE_VERIFY_FAILED'
    Assert-LedgerTransactionAbsent -Id $script:CreatedTransactionId -Marker $marker

    $script:FailureCode = 'LEDGER_CRUD_BASELINE_RESTORE_FAILED'
    $after = Get-LedgerSnapshot
    if (-not (Test-LedgerSnapshotRestored -Before $script:Baseline -After $after)) {
        throw 'baseline not restored'
    }
    $script:CleanupMayBeRequired = $false
}

$script:CleanupMayBeRequired = $false
$script:CreatedTransactionId = $null
$script:CleanupMarker = $null
$script:Baseline = $null
$primaryFailure = $null
$cleanupFailure = $false

try {
    Initialize-LedgerCrudArguments
    if (-not $PSCmdlet.ShouldProcess('selected loopback ledger instance', 'Run reversible API CRUD acceptance')) {
        Write-Output 'LEDGER_CRUD_WHATIF'
        return
    }
    Invoke-LedgerCrudAcceptance
} catch {
    $primaryFailure = $script:FailureCode
} finally {
    if ($script:CleanupMayBeRequired) {
        try {
            Invoke-LedgerExactCleanup `
                -CapturedId $script:CreatedTransactionId `
                -Marker $script:CleanupMarker `
                -Baseline $script:Baseline
            $script:CleanupMayBeRequired = $false
        } catch {
            $cleanupFailure = $true
        }
    }
    $script:ApiToken = $null
    $script:BaseUrl = $null
}

if ($cleanupFailure) {
    [Console]::Error.WriteLine('LEDGER_CRUD_CLEANUP_UNVERIFIED')
    exit 1
}
if ($null -ne $primaryFailure) {
    [Console]::Error.WriteLine([string]$primaryFailure)
    exit 1
}
Write-Output 'LEDGER_CRUD_ACCEPTANCE_OK'
