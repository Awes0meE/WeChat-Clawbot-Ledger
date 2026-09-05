import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const crudScriptPath = join(projectDirectory, 'scripts', 'test-ledger-crud.ps1');

function readRequired(path) {
  assert.equal(existsSync(path), true, `missing required artifact: ${path}`);
  return readFileSync(path, 'utf8');
}

function runPowerShell(arguments_, options = {}) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    ...arguments_,
  ], {
    cwd: projectDirectory,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

test('CRUD acceptance script is PowerShell 5.1 compatible', () => {
  readRequired(crudScriptPath);
  const escaped = crudScriptPath.replaceAll("'", "''");
  const result = runPowerShell([
    '-Command',
    `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { exit 1 }`,
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('CRUD acceptance is pinned to mutually exclusive loopback runtimes', () => {
  const source = readRequired(crudScriptPath);

  assert.match(source, /\[CmdletBinding\(SupportsShouldProcess/u);
  assert.match(source, /\$Mode\s+-ceq\s+'Test'/u);
  assert.match(source, /\$Mode\s+-cne\s+'Test'\s+-and\s+\$Mode\s+-cne\s+'Production'/u);
  assert.match(source, /http:\/\/127\.0\.0\.1:18888/u);
  assert.match(source, /http:\/\/127\.0\.0\.1:8888/u);
  assert.match(source, /ezbookkeeping-test-token\.txt/u);
  assert.match(source, /ezbookkeeping-token\.txt/u);
  assert.match(source, /\.clawbot-ledger-test-instance-ready/u);
  assert.match(source, /CLAWBOT_LEDGER_TEST_INSTANCE_READY_V1/u);
  assert.match(source, /Assert-LedgerTestConfiguration/u);
  assert.match(source, /Get-LedgerIniDocument/u);
  assert.match(source, /Get-LedgerListenerOwner/u);
  assert.match(source, /Assert-LedgerOwnerOnlyFile/u);
  assert.match(source, /Test-LedgerOrigin/u);
  assert.match(source, /Assert-LedgerNoConfigurationOverrides/u);
  assert.doesNotMatch(source, /Invoke-WebRequest[^\r\n]*(?:ledger\.66ccff-labs\.com|https?:\/\/(?!127\.0\.0\.1))/u);
  assert.doesNotMatch(source, /127\.0\.0\.1:8180|localhost|0\.0\.0\.0/u);
  assert.doesNotMatch(source, /Stop-Process|Remove-Item|Unregister-ScheduledTask|Stop-ScheduledTask/u);
});

test('WhatIf returns before token access, HTTP, or mutation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-crud-whatif-'));
  const blockedTokenPath = join(directory, '.openclaw', 'secrets', 'ezbookkeeping-test-token.txt');
  mkdirSync(blockedTokenPath, { recursive: true });

  try {
    const result = runPowerShell([
      '-File', crudScriptPath,
      '-Mode', 'Test',
      '-WhatIf',
    ], {
      env: { ...process.env, USERPROFILE: directory },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /LEDGER_CRUD_WHATIF/u);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Authorization|Bearer|Invoke-WebRequest|blockedTokenPath/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const source = readRequired(crudScriptPath);
  const mainEntryIndex = source.lastIndexOf('try {\n    Initialize-LedgerCrudArguments');
  const shouldProcessIndex = source.indexOf('$PSCmdlet.ShouldProcess', mainEntryIndex);
  const acceptanceCallIndex = source.indexOf('Invoke-LedgerCrudAcceptance', shouldProcessIndex);
  assert.notEqual(mainEntryIndex, -1);
  assert.notEqual(shouldProcessIndex, -1);
  assert.notEqual(acceptanceCallIndex, -1);
  assert.ok(mainEntryIndex < shouldProcessIndex);
  assert.ok(shouldProcessIndex < acceptanceCallIndex);
  assert.match(source, /function Invoke-LedgerCrudAcceptance[\s\S]*\[IO\.File\]::ReadAllBytes/u);
  assert.match(source, /function Invoke-LedgerApiRaw[\s\S]*Invoke-WebRequest/u);
});

test('invalid arguments fail with a fixed redacted code', () => {
  const secretSentinel = 'must-never-leak.invalid';
  const result = runPowerShell([
    '-File', crudScriptPath,
    '-Mode', 'Test',
    '-ServerBaseUrl', `https://${secretSentinel}/`,
    '-TokenPath', `C:\\${secretSentinel}\\token.txt`,
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.trim(), '');
  assert.equal(result.stderr.trim(), 'LEDGER_CRUD_ARGUMENTS_INVALID');
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secretSentinel.replace('.', '\\.'), 'u'));
});

test('CRUD flow follows the v1.6.1 transaction contract and verifies restoration', () => {
  const source = readRequired(crudScriptPath);

  for (const endpoint of [
    'accounts/list.json',
    'transaction/categories/list.json',
    'transactions/list/all.json',
    'transactions/add.json',
    'transactions/get.json',
    'transactions/modify.json',
    'transactions/delete.json',
  ]) assert.ok(source.includes(endpoint), endpoint);

  for (const field of [
    'categoryId',
    'sourceAccountId',
    'sourceAmount',
    'destinationAccountId',
    'destinationAmount',
    'clientSessionId',
  ]) assert.match(source, new RegExp(`\\b${field}\\b`, 'u'));

  assert.match(source, /type\s*=\s*3/u);
  assert.match(source, /sourceAmount\s*=\s*1/u);
  assert.match(source, /sourceAmount\s*=\s*2/u);
  assert.match(source, /MaximumRedirection\s*=\s*0/u);
  assert.match(source, /TimeoutSec\s*=\s*\$RequestTimeoutSec/u);
  assert.match(source, /Get-LedgerCanonicalSha256/u);
  assert.match(source, /AccountsHash/u);
  assert.match(source, /CategoriesHash/u);
  assert.match(source, /TransactionsHash/u);
  assert.match(source, /AccountsCount/u);
  assert.match(source, /TransactionsCount/u);
  assert.match(source, /LEDGER_CRUD_DELETE_VERIFY_FAILED/u);
  assert.match(source, /LEDGER_CRUD_BASELINE_RESTORE_FAILED/u);
  assert.doesNotMatch(source, /Write-(?:Host|Verbose|Debug|Information)|Start-Transcript|Out-File|Export-Clixml/u);
});

test('cleanup is exact, marker-scoped, and fails closed when it cannot be proven', () => {
  const source = readRequired(crudScriptPath);

  assert.match(source, /finally\s*\{/u);
  assert.match(source, /\$script:CleanupMayBeRequired\s*=\s*\$true/u);
  assert.match(source, /CLAWBOT_LEDGER_CRUD_/u);
  assert.match(source, /\[Guid\]::NewGuid\(\)\.ToString\('N'\)/u);
  assert.match(source, /\.comment\s+-ceq\s+\$marker/iu);
  assert.match(source, /transactions\/list\/all\.json/u);
  assert.match(source, /transactions\/delete\.json/u);
  assert.match(source, /\$script:CreatedTransactionId/u);
  assert.match(source, /LEDGER_CRUD_CLEANUP_UNVERIFIED/u);
  assert.match(source, /Assert-LedgerTransactionAbsent/u);
  assert.doesNotMatch(source, /transactions\/batch_delete|clear\/transactions|clear\/all/u);
});

test('mocked test-mode run completes add, get, modify, delete, and baseline restoration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-crud-mock-'));
  const runtimeDirectory = join(directory, 'ezbookkeeping-test');
  const configPath = join(runtimeDirectory, 'conf', 'ezbookkeeping-test.ini');
  const executablePath = join(runtimeDirectory, 'ezbookkeeping.exe');
  const markerPath = join(runtimeDirectory, '.clawbot-ledger-test-instance-ready');
  const tokenPath = join(directory, '.openclaw', 'secrets', 'ezbookkeeping-test-token.txt');
  const generatedScriptPath = join(directory, 'test-ledger-crud.ps1');
  const commonPath = join(directory, 'ledger-runtime-common.ps1');

  const psLiteral = (value) => value.replaceAll("'", "''");
  const source = readRequired(crudScriptPath);
  assert.ok(source.includes('    . $script:ResolvedCommon'));
  const transformed = source
    .replaceAll('D:\\Clawbot\\ezbookkeeping-test', runtimeDirectory)
    .replace(
      '$script:StrictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)',
      `$script:StrictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)

function Get-LedgerNormalizedPath { param([string]$Path) return [IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\\', '/')) }
function Test-LedgerSamePath { param([string]$Left, [string]$Right) return [string]::Equals((Get-LedgerNormalizedPath $Left), (Get-LedgerNormalizedPath $Right), [StringComparison]::OrdinalIgnoreCase) }
function Assert-LedgerNoConfigurationOverrides { param([string[]]$SettingNames) }
function Assert-LedgerOwnerOnlyFile { param([string]$Path) }
function Assert-LedgerTestConfiguration {
    param([string]$InstallDirectory, [string]$ConfigPath)
    return [pscustomobject]@{ Values = @{ 'database.db_path' = '${psLiteral(join(runtimeDirectory, 'data', 'ezbookkeeping-test.db'))}' } }
}
function Get-LedgerIniValue {
    param([object]$Document, [string]$Section, [string]$Name)
    return [string]$Document.Values[($Section.ToLowerInvariant() + '.' + $Name.ToLowerInvariant())]
}
function Resolve-LedgerDataPath { param([string]$InstallDirectory, [string]$ConfiguredPath) return Get-LedgerNormalizedPath $ConfiguredPath }
function Get-LedgerListenerOwner { param([int]$Port, [string]$ExpectedExecutable, [string]$ExpectedConfigPath) return [pscustomobject]@{ ProcessId = 42 } }
function Test-LedgerOrigin { param([int]$Port) return $true }

$script:MockBalance = [int64]1000
$script:MockTransaction = $null
function New-MockLedgerResponse {
    param([int]$StatusCode, [bool]$Success, [AllowNull()][object]$Result)
    return [pscustomobject]@{
        StatusCode = $StatusCode
        Content = ([ordered]@{ success = $Success; result = $Result } | ConvertTo-Json -Depth 12 -Compress)
    }
}
function Invoke-WebRequest {
    [CmdletBinding()]
    param(
        [string]$Uri,
        [string]$Method,
        [hashtable]$Headers,
        [int]$MaximumRedirection,
        [int]$TimeoutSec,
        [switch]$UseBasicParsing,
        [string]$ContentType,
        [string]$Body
    )
    if ($MaximumRedirection -ne 0 -or $TimeoutSec -lt 1 -or $Headers.Authorization -cne 'Bearer synthetic-test-token') { throw 'mock request rejected' }
    $requestUri = [Uri]$Uri
    switch ($requestUri.AbsolutePath) {
        '/api/v1/accounts/list.json' {
            return New-MockLedgerResponse 200 $true @([ordered]@{
                id = '100'; name = 'synthetic parent'; type = 2; currency = 'SGD'; balance = $script:MockBalance; hidden = $false
                subAccounts = @([ordered]@{
                    id = '101'; name = 'synthetic child'; type = 1; currency = 'SGD'; balance = $script:MockBalance; hidden = $false; subAccounts = @()
                })
            })
        }
        '/api/v1/transaction/categories/list.json' {
            return New-MockLedgerResponse 200 $true ([ordered]@{
                '2' = @([ordered]@{
                    id = '200'; name = 'synthetic primary'; parentId = '0'; hidden = $false
                    subCategories = @([ordered]@{ id = '201'; name = 'synthetic child'; parentId = '200'; hidden = $false; subCategories = @() })
                })
            })
        }
        '/api/v1/transactions/list/all.json' {
            $items = @()
            if ($null -ne $script:MockTransaction) { $items = @($script:MockTransaction) }
            return New-MockLedgerResponse 200 $true $items
        }
        '/api/v1/transactions/add.json' {
            $request = $Body | ConvertFrom-Json
            if ([string]$request.sourceAccountId -cne '101' -or [string]$request.categoryId -cne '201') {
                return New-MockLedgerResponse 400 $false $null
            }
            $script:MockTransaction = [pscustomobject][ordered]@{
                id = '301'; type = $request.type; categoryId = $request.categoryId; time = $request.time
                utcOffset = $request.utcOffset; sourceAccountId = $request.sourceAccountId
                sourceAmount = $request.sourceAmount; destinationAccountId = $request.destinationAccountId
                destinationAmount = $request.destinationAmount; hideAmount = $request.hideAmount
                tagIds = @(); pictureIds = @(); comment = $request.comment
            }
            $script:MockBalance -= [int64]$request.sourceAmount
            return New-MockLedgerResponse 200 $true $script:MockTransaction
        }
        '/api/v1/transactions/get.json' {
            if ($null -eq $script:MockTransaction) { return New-MockLedgerResponse 400 $false $null }
            return New-MockLedgerResponse 200 $true $script:MockTransaction
        }
        '/api/v1/transactions/modify.json' {
            $request = $Body | ConvertFrom-Json
            $script:MockBalance += [int64]$script:MockTransaction.sourceAmount
            $script:MockTransaction.sourceAmount = [int64]$request.sourceAmount
            $script:MockBalance -= [int64]$script:MockTransaction.sourceAmount
            return New-MockLedgerResponse 200 $true $script:MockTransaction
        }
        '/api/v1/transactions/delete.json' {
            $script:MockBalance += [int64]$script:MockTransaction.sourceAmount
            $script:MockTransaction = $null
            return New-MockLedgerResponse 200 $true $true
        }
        default { throw 'unexpected mock route' }
    }
}`,
    )
    .replace('    . $script:ResolvedCommon', '    # Common helper functions are supplied by this isolated mock.');

  try {
    mkdirSync(dirname(configPath), { recursive: true });
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(configPath, '; synthetic test config\n', 'utf8');
    writeFileSync(executablePath, 'synthetic executable', 'utf8');
    writeFileSync(markerPath, 'CLAWBOT_LEDGER_TEST_INSTANCE_READY_V1\n', 'utf8');
    writeFileSync(tokenPath, 'synthetic-test-token', 'utf8');
    writeFileSync(commonPath, '# mock common placeholder\n', 'utf8');
    writeFileSync(generatedScriptPath, transformed, 'utf8');

    const result = runPowerShell([
      '-File', generatedScriptPath,
      '-Mode', 'Test',
    ], {
      cwd: directory,
      env: { ...process.env, USERPROFILE: directory },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr.trim(), '');
    assert.equal(result.stdout.trim(), 'LEDGER_CRUD_ACCEPTANCE_OK');
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /synthetic-test-token|Authorization|Bearer|synthetic test config/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
