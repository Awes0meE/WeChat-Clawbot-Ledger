import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const remediationScript = join(projectDirectory, 'scripts', 'migrate-ledger-user-overrides.ps1');
const expectedNames = [
  'EBK_SECURITY_ENABLE_API_TOKEN',
  'EBK_SECURITY_SECRET_KEY',
  'EBK_SERVER_DOMAIN',
  'EBK_SERVER_HTTP_ADDR',
  'EBK_SERVER_ROOT_URL',
];

function runPowerShell(arguments_, env = {}) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...arguments_],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } },
  );
}

function createFixture(extraUser = {}, extraMachine = {}) {
  const root = mkdtempSync(join(tmpdir(), 'clawbot-ledger-env-migration-'));
  const installDirectory = join(root, 'ezbookkeeping');
  const configPath = join(installDirectory, 'conf', 'ezbookkeeping.ini');
  const backupRoot = join(root, 'backups');
  const environmentPath = join(root, 'environment.json');
  const tracePath = join(root, 'registry-trace.txt');
  const wrapperPath = join(root, 'wrapper.ps1');
  mkdirSync(dirname(configPath), { recursive: true });
  const originalConfig = [
    '[server]',
    'http_addr = 0.0.0.0',
    'domain = 127.0.0.1',
    'root_url = http://127.0.0.1:8180/',
    '',
    '[security]',
    'secret_key = ini-secret-before',
    'enable_api_token = false',
    '',
  ].join('\r\n');
  writeFileSync(configPath, originalConfig, 'utf8');
  const user = {
    EBK_SECURITY_SECRET_KEY: 'effective-secret-from-user',
    EBK_SERVER_ROOT_URL: 'http://legacy.invalid/',
    EBK_SECURITY_ENABLE_API_TOKEN: 'true',
    EBK_SERVER_HTTP_ADDR: '127.0.0.1',
    EBK_SERVER_DOMAIN: 'legacy.invalid',
    ...extraUser,
  };
  const state = { user, machine: { ...extraMachine } };
  writeFileSync(environmentPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  writeFileSync(wrapperPath, String.raw`
$global:scriptPath = $args[0]
$global:mode = $args[1]
$global:installDirectory = $args[2]
$global:configPath = $args[3]
$global:backupRoot = $args[4]
$global:environmentPath = $args[5]
$global:tracePath = $args[6]
$global:userReads = 0
$global:removeCount = 0
$global:setCount = 0
function Read-FixtureEnvironment {
    return [IO.File]::ReadAllText($global:environmentPath, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
}
function Write-FixtureEnvironment {
    param([object]$State)
    [IO.File]::WriteAllText($global:environmentPath, (($State | ConvertTo-Json -Depth 8) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
}
function Get-ItemProperty {
    [CmdletBinding()] param([string]$LiteralPath)
    $state = Read-FixtureEnvironment
    if ($LiteralPath -like '*HKEY_CURRENT_USER*') {
        $global:userReads++
        if ($global:mode -eq 'concurrent-change' -and $global:userReads -eq 2) {
            $state.user.EBK_SECURITY_SECRET_KEY = 'concurrently-changed-secret'
            Write-FixtureEnvironment -State $state
        }
        return (Read-FixtureEnvironment).user
    }
    if ($LiteralPath -like '*HKEY_LOCAL_MACHINE*') { return $state.machine }
    throw 'Unexpected registry path.'
}
function Remove-ItemProperty {
    [CmdletBinding()] param([string]$LiteralPath, [string]$Name)
    if ($LiteralPath -notlike '*HKEY_CURRENT_USER*') { throw 'Unexpected registry removal.' }
    $global:removeCount++
    $state = Read-FixtureEnvironment
    $state.user.PSObject.Properties.Remove($Name)
    Write-FixtureEnvironment -State $state
    Add-Content -LiteralPath $global:tracePath -Value ('remove:' + $Name) -Encoding UTF8
    if ($global:mode -eq 'config-conflict' -and $global:removeCount -eq 1) {
        [IO.File]::WriteAllText($global:configPath, ('; concurrent configuration must survive' + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
        throw 'Simulated failure after a concurrent configuration change.'
    }
    if ($global:mode -eq 'environment-conflict' -and $global:removeCount -eq 1) {
        $state = Read-FixtureEnvironment
        $state.user | Add-Member -MemberType NoteProperty -Name $Name -Value 'concurrent-value-must-survive' -Force
        Write-FixtureEnvironment -State $state
        throw 'Simulated failure after a concurrent environment change.'
    }
    if ($global:mode -eq 'config-change-after-clear' -and $global:removeCount -eq 5) {
        [IO.File]::WriteAllText($global:configPath, ('; late concurrent configuration must survive' + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
    }
    if ($global:mode -in @('remove-fail', 'rollback-incomplete') -and $global:removeCount -eq 3) {
        throw 'Simulated registry removal failure.'
    }
}
function Set-ItemProperty {
    [CmdletBinding()] param([string]$LiteralPath, [string]$Name, [object]$Value)
    if ($LiteralPath -notlike '*HKEY_CURRENT_USER*') { throw 'Unexpected registry restore.' }
    $global:setCount++
    if ($global:mode -eq 'rollback-incomplete' -and $global:setCount -eq 1) {
        throw 'Simulated registry restore failure.'
    }
    $state = Read-FixtureEnvironment
    $property = $state.user.PSObject.Properties[$Name]
    if ($null -eq $property) { $state.user | Add-Member -MemberType NoteProperty -Name $Name -Value ([string]$Value) }
    else { $property.Value = [string]$Value }
    Write-FixtureEnvironment -State $state
    Add-Content -LiteralPath $global:tracePath -Value ('set:' + $Name) -Encoding UTF8
}
function Set-Acl { [CmdletBinding()] param([string]$LiteralPath, [object]$AclObject) if (-not (Test-Path -LiteralPath $LiteralPath)) { throw 'ACL target missing.' } }
function Get-Acl {
    [CmdletBinding()] param([string]$LiteralPath)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    return [pscustomobject]@{
        Owner = $identity
        AreAccessRulesProtected = $true
        Access = @([pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = $identity }; AccessControlType = 'Allow'; FileSystemRights = 'FullControl' })
    }
}
$parameters = @{
    InstallDirectory = $global:installDirectory
    ConfigPath = $global:configPath
    BackupRoot = $global:backupRoot
    Confirm = $false
}
if ($global:mode -eq 'whatif') { $parameters.WhatIf = $true }
try {
    & $global:scriptPath @parameters
    if ($global:mode -in @('remove-fail', 'rollback-incomplete', 'config-conflict', 'environment-conflict', 'config-change-after-clear', 'mutex-held', 'unsafe', 'concurrent-change')) {
        throw 'Expected remediation rejection.'
    }
} catch {
    if ($global:mode -notin @('remove-fail', 'rollback-incomplete', 'config-conflict', 'environment-conflict', 'config-change-after-clear', 'mutex-held', 'unsafe', 'concurrent-change')) { throw }
    if ($_.Exception.Message -eq 'Expected remediation rejection.') { throw }
    if ($global:mode -eq 'rollback-incomplete' -and $_.Exception.Message -notmatch 'rollback.*incomplete') { throw }
    if ($global:mode -in @('config-conflict', 'environment-conflict', 'config-change-after-clear') -and $_.Exception.Message -notmatch 'rollback.*incomplete') { throw }
    if ($global:mode -eq 'remove-fail' -and $_.Exception.Message -match 'rollback.*incomplete') { throw }
    Write-Output 'EXPECTED_REMEDIATION_FAILURE'
}
`, 'utf8');
  return { root, installDirectory, configPath, backupRoot, environmentPath, tracePath, wrapperPath, originalConfig, state };
}

function runFixture(fixture, mode) {
  return runPowerShell([
    '-File', fixture.wrapperPath, remediationScript, mode,
    fixture.installDirectory, fixture.configPath, fixture.backupRoot,
    fixture.environmentPath, fixture.tracePath,
  ]);
}

test('legacy override remediation is dry-run safe before reading environment values', () => {
  const fixture = createFixture();
  try {
    const before = readFileSync(fixture.environmentPath);
    const result = runFixture(fixture, 'whatif');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(readFileSync(fixture.configPath, 'utf8'), fixture.originalConfig);
    assert.deepEqual(readFileSync(fixture.environmentPath), before);
    assert.equal(existsSync(fixture.backupRoot), false);
    assert.equal(existsSync(fixture.tracePath), false);
    assert.equal(result.stdout.includes('effective-secret'), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('migrates only the exact five User overrides through verified DPAPI and INI backups', () => {
  const fixture = createFixture();
  try {
    const result = runFixture(fixture, 'success');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /LEDGER_USER_OVERRIDES_MIGRATED/u);
    assert.equal(result.stdout.includes('effective-secret'), false);
    assert.match(readFileSync(fixture.configPath, 'utf8'), /secret_key = effective-secret-from-user/u);
    assert.match(readFileSync(fixture.configPath, 'utf8'), /http_addr = 127\.0\.0\.1/u);
    assert.match(readFileSync(fixture.configPath, 'utf8'), /domain = ledger\.66ccff-labs\.com/u);
    assert.match(readFileSync(fixture.configPath, 'utf8'), /root_url = https:\/\/ledger\.66ccff-labs\.com\//u);
    assert.match(readFileSync(fixture.configPath, 'utf8'), /enable_api_token = true/u);
    assert.deepEqual(JSON.parse(readFileSync(fixture.environmentPath, 'utf8')).user, {});
    assert.deepEqual(readFileSync(fixture.tracePath, 'utf8').trim().split(/\r?\n/u).sort(), expectedNames.map((name) => `remove:${name}`).sort());

    const backupDirectories = readdirSync(fixture.backupRoot);
    assert.equal(backupDirectories.length, 1);
    const files = readdirSync(join(fixture.backupRoot, backupDirectories[0])).sort();
    assert.deepEqual(files, ['backup-manifest.json', 'ezbookkeeping.ini', 'user-overrides.dpapi']);
    assert.deepEqual(readFileSync(join(fixture.backupRoot, backupDirectories[0], 'ezbookkeeping.ini'), 'utf8'), fixture.originalConfig);
    const encrypted = readFileSync(join(fixture.backupRoot, backupDirectories[0], 'user-overrides.dpapi'));
    assert.equal(encrypted.includes(Buffer.from('effective-secret-from-user')), false);
    assert.equal(encrypted.includes(Buffer.from('EBK_SECURITY_SECRET_KEY')), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a partial User override clear restores both the INI and all five variables', () => {
  const fixture = createFixture();
  try {
    const result = runFixture(fixture, 'remove-fail');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /EXPECTED_REMEDIATION_FAILURE/u);
    assert.equal(result.stdout.includes('effective-secret'), false);
    assert.deepEqual(readFileSync(fixture.configPath, 'utf8'), fixture.originalConfig);
    assert.deepEqual(JSON.parse(readFileSync(fixture.environmentPath, 'utf8')), fixture.state);
    const trace = readFileSync(fixture.tracePath, 'utf8').trim().split(/\r?\n/u);
    assert.equal(trace.filter((line) => line.startsWith('remove:')).length, 3);
    assert.equal(trace.filter((line) => line.startsWith('set:')).length, 3);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a failed variable restore reports rollback incomplete without disclosing values', () => {
  const fixture = createFixture();
  try {
    const result = runFixture(fixture, 'rollback-incomplete');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /EXPECTED_REMEDIATION_FAILURE/u);
    assert.equal(`${result.stdout}\n${result.stderr}`.includes('effective-secret'), false);
    assert.deepEqual(readFileSync(fixture.configPath, 'utf8'), fixture.originalConfig);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rollback never overwrites a concurrently changed INI or User override', () => {
  for (const scenario of ['config-conflict', 'environment-conflict', 'config-change-after-clear']) {
    const fixture = createFixture();
    try {
      const result = runFixture(fixture, scenario);
      assert.equal(result.status, 0, `${scenario}: ${result.stderr || result.stdout}`);
      assert.match(result.stdout, /EXPECTED_REMEDIATION_FAILURE/u);
      assert.equal(`${result.stdout}\n${result.stderr}`.includes('effective-secret'), false);
      if (scenario === 'config-conflict' || scenario === 'config-change-after-clear') {
        assert.match(readFileSync(fixture.configPath, 'utf8'), /concurrent configuration must survive/u);
      } else {
        const state = JSON.parse(readFileSync(fixture.environmentPath, 'utf8'));
        assert.ok(Object.values(state.user).includes('concurrent-value-must-survive'));
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('a concurrent remediation invocation is rejected before backup or mutation', async () => {
  const fixture = createFixture();
  const readyPath = join(fixture.root, 'mutex-ready');
  const holderPath = join(fixture.root, 'mutex-holder.ps1');
  writeFileSync(holderPath, String.raw`
$mutex = New-Object Threading.Mutex($false, 'Local\Clawbot.Ledger.UserOverrides')
$acquired = $false
try {
    $acquired = $mutex.WaitOne(0)
    if (-not $acquired) { throw 'Could not acquire fixture mutex.' }
    [IO.File]::WriteAllText($args[0], 'ready', (New-Object Text.UTF8Encoding($false)))
    $null = [Console]::In.ReadLine()
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
`, 'utf8');
  const holder = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', holderPath, readyPath], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    for (let attempt = 0; attempt < 100 && !existsSync(readyPath); attempt += 1) {
      if (holder.exitCode !== null) break;
      await delay(25);
    }
    assert.equal(existsSync(readyPath), true, 'fixture mutex holder did not become ready');
    const before = readFileSync(fixture.environmentPath);
    const result = runFixture(fixture, 'mutex-held');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /EXPECTED_REMEDIATION_FAILURE/u);
    assert.deepEqual(readFileSync(fixture.configPath, 'utf8'), fixture.originalConfig);
    assert.deepEqual(readFileSync(fixture.environmentPath), before);
    assert.equal(existsSync(fixture.backupRoot), false);
    assert.equal(existsSync(fixture.tracePath), false);
  } finally {
    if (holder.exitCode === null) {
      holder.stdin.write('done\n');
      await once(holder, 'close');
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects extra User or any Machine override before backup or mutation', () => {
  for (const fixture of [
    createFixture({ EBK_UNEXPECTED: 'synthetic' }),
    createFixture({}, { EBK_MACHINE_UNEXPECTED: 'synthetic' }),
  ]) {
    try {
      const before = readFileSync(fixture.environmentPath);
      const result = runFixture(fixture, 'unsafe');
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(readFileSync(fixture.configPath, 'utf8'), fixture.originalConfig);
      assert.deepEqual(readFileSync(fixture.environmentPath), before);
      assert.equal(existsSync(fixture.backupRoot), false);
      assert.equal(existsSync(fixture.tracePath), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('rejects a concurrent User override change before writing the INI', () => {
  const fixture = createFixture();
  try {
    const result = runFixture(fixture, 'concurrent-change');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(readFileSync(fixture.configPath, 'utf8'), fixture.originalConfig);
    assert.equal(existsSync(fixture.tracePath), false);
    assert.equal(`${result.stdout}\n${result.stderr}`.includes('concurrently-changed-secret'), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('remediation source keeps exact scope and contains no process or task control', () => {
  const source = readFileSync(remediationScript, 'utf8');
  for (const name of expectedNames) assert.match(source, new RegExp(`'${name}'`, 'u'));
  assert.match(source, /ProtectedData\]::Protect/u);
  assert.match(source, /ProtectedData\]::Unprotect/u);
  assert.match(source, /Threading\.Mutex/u);
  assert.match(source, /ReleaseMutex/u);
  assert.match(source, /Test-LedgerSameFile/u);
  assert.match(source, /\$updatedConfigHash/u);
  assert.doesNotMatch(source, /Stop-Process|Stop-ScheduledTask|Start-ScheduledTask|Register-ScheduledTask/u);
  const guard = source.indexOf('if (-not $PSCmdlet.ShouldProcess(');
  assert.ok(guard >= 0);
  assert.ok(guard < source.indexOf('$snapshot = Get-LedgerEnvironmentSnapshot'));
  assert.ok(guard < source.indexOf('$document = Get-LedgerIniDocument'));
});
