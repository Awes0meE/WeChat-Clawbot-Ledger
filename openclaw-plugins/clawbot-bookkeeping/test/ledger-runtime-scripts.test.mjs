import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pluginDirectory = join(projectDirectory, 'openclaw-plugins', 'clawbot-bookkeeping');
const scriptsDirectory = join(projectDirectory, 'scripts');
const configDirectory = join(projectDirectory, 'config');
const sqliteVerifier = join(scriptsDirectory, 'verify-ledger-sqlite.mjs');

function writeEnvironmentIsolatedCommon(sourcePath, destinationPath) {
  const source = readFileSync(sourcePath, 'utf8');
  const strictModeMarker = 'Set-StrictMode -Version Latest';
  const productionProvider = '        $variables = [Environment]::GetEnvironmentVariables($scope)';
  assert.equal(source.split(strictModeMarker).length - 1, 1, 'expected one common strict-mode marker');
  assert.equal(source.split(productionProvider).length - 1, 1, 'expected one production environment provider');
  const fixtureProvider = `function Get-LedgerFixtureEnvironmentVariables {
    param([Parameter(Mandatory = $true)][EnvironmentVariableTarget]$Target)

    $fixtureVariable = Get-Variable -Name LedgerTestEnvironmentOverrides -Scope Global -ErrorAction SilentlyContinue
    if ($null -eq $fixtureVariable) { return @{} }
    $fixtureOverrides = $fixtureVariable.Value
    $scopeName = [string]$Target
    if ($fixtureOverrides -isnot [System.Collections.IDictionary] -or -not $fixtureOverrides.Contains($scopeName)) {
        return @{}
    }
    $scopeVariables = $fixtureOverrides[$scopeName]
    if ($scopeVariables -isnot [System.Collections.IDictionary]) {
        throw 'Test environment scope must be a dictionary.'
    }
    return $scopeVariables
}`;
  const isolated = source
    .replace(strictModeMarker, `${strictModeMarker}\n\n${fixtureProvider}`)
    .replace(productionProvider, '        $variables = Get-LedgerFixtureEnvironmentVariables -Target $scope');
  writeFileSync(destinationPath, isolated, 'utf8');
}

const isolatedRoot = mkdtempSync(join(tmpdir(), 'clawbot-ledger-runtime-isolated-'));
const isolatedScriptsDirectory = join(isolatedRoot, 'scripts');
const isolatedConfigDirectory = join(isolatedRoot, 'config');
mkdirSync(isolatedScriptsDirectory, { recursive: true });
mkdirSync(isolatedConfigDirectory, { recursive: true });
writeEnvironmentIsolatedCommon(
  join(scriptsDirectory, 'ledger-runtime-common.ps1'),
  join(isolatedScriptsDirectory, 'ledger-runtime-common.ps1'),
);
for (const scriptName of [
  'initialize-test-ledger.ps1',
  'migrate-ledger-production.ps1',
  'install-ledger-test-instance.ps1',
  'install-ezbookkeeping-task.ps1',
  'verify-ledger-sqlite.mjs',
]) {
  writeFileSync(
    join(isolatedScriptsDirectory, scriptName),
    readFileSync(join(scriptsDirectory, scriptName), 'utf8'),
    'utf8',
  );
}
writeFileSync(
  join(isolatedConfigDirectory, 'ezbookkeeping-test.example.ini'),
  readFileSync(join(configDirectory, 'ezbookkeeping-test.example.ini'), 'utf8'),
  'utf8',
);
const initializeTestLedgerScript = join(isolatedScriptsDirectory, 'initialize-test-ledger.ps1');
const migrationScript = join(isolatedScriptsDirectory, 'migrate-ledger-production.ps1');
const installTestInstanceScript = join(isolatedScriptsDirectory, 'install-ledger-test-instance.ps1');
const installProductionTaskScript = join(isolatedScriptsDirectory, 'install-ezbookkeeping-task.ps1');
after(() => rmSync(isolatedRoot, { recursive: true, force: true }));

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function runPowerShell(arguments_) {
  return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...arguments_]);
}

test('listener queries treat the Windows no-match CIM error as an empty result only', () => {
  const commonPath = join(scriptsDirectory, 'ledger-runtime-common.ps1').replaceAll("'", "''");
  const noMatch = runPowerShell([
    '-Command',
    `function Get-NetTCPConnection { [CmdletBinding()] param([string]$State, [int]$LocalPort) $record = New-Object System.Management.Automation.ErrorRecord((New-Object InvalidOperationException('no rows')), 'CmdletizationQuery_NotFound', ([Management.Automation.ErrorCategory]::ObjectNotFound), $null); $PSCmdlet.ThrowTerminatingError($record) }; . '${commonPath}'; $ErrorActionPreference = 'Stop'; if (-not (Get-Command Get-LedgerListeningTcpConnections -ErrorAction SilentlyContinue)) { exit 4 }; $listeners = @(Get-LedgerListeningTcpConnections -Port 18888); if ($listeners.Count -ne 0) { exit 2 }; 'NO_LISTENER_OK'`,
  ]);
  assert.equal(noMatch.status, 0, noMatch.stderr || noMatch.stdout);
  assert.match(noMatch.stdout, /NO_LISTENER_OK/u);

  const transportFailure = runPowerShell([
    '-Command',
    `function Get-NetTCPConnection { [CmdletBinding()] param([string]$State, [int]$LocalPort) throw 'transport failure' }; . '${commonPath}'; $ErrorActionPreference = 'Stop'; if (-not (Get-Command Get-LedgerListeningTcpConnections -ErrorAction SilentlyContinue)) { exit 4 }; try { $null = @(Get-LedgerListeningTcpConnections -Port 18888); exit 3 } catch { 'OTHER_ERROR_PROPAGATED' }`,
  ]);
  assert.equal(transportFailure.status, 0, transportFailure.stderr || transportFailure.stdout);
  assert.match(transportFailure.stdout, /OTHER_ERROR_PROPAGATED/u);
});

test('static MCP credential scan terminates on PowerShell JSON timestamp values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-ledger-openclaw-config-'));
  try {
    const configPath = join(directory, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      meta: { lastTouchedAt: '2026-09-04T02:33:33.542Z' },
      tools: { mcp: { enabled: false } },
    }), 'utf8');
    const commonPath = join(scriptsDirectory, 'ledger-runtime-common.ps1').replaceAll("'", "''");
    const escapedConfigPath = configPath.replaceAll("'", "''");
    const result = run('pwsh.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `. '${commonPath}'; Assert-LedgerNoStaticMcpCredential -OpenClawConfigPath '${escapedConfigPath}'; 'STATIC_MCP_SCAN_OK'`,
    ], { timeout: 5_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /STATIC_MCP_SCAN_OK/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('static MCP credential scan rejects an ezbookkeeping server without disclosing its fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-ledger-static-mcp-'));
  const secretSentinel = 'static-secret-must-never-be-printed';
  try {
    const configPath = join(directory, 'openclaw.json');
    writeFileSync(configPath, JSON.stringify({
      mcp: {
        servers: {
          EzBookkeeping: {
            url: 'http://127.0.0.1:8888/mcp',
            headers: { 'X-Api-Key': secretSentinel },
            env: { CUSTOM_TOKEN: secretSentinel },
          },
        },
      },
    }), 'utf8');
    const commonPath = join(scriptsDirectory, 'ledger-runtime-common.ps1').replaceAll("'", "''");
    const escapedConfigPath = configPath.replaceAll("'", "''");
    const result = runPowerShell([
      '-Command',
      `. '${commonPath}'; Assert-LedgerNoStaticMcpCredential -OpenClawConfigPath '${escapedConfigPath}'`,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /static MCP credential fallback/u);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secretSentinel, 'u'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeLedgerFixture(databasePath, activeUsers) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE "user" (
        uid INTEGER PRIMARY KEY,
        disabled INTEGER NOT NULL,
        deleted INTEGER NOT NULL
      );
    `);
    const insert = database.prepare('INSERT INTO "user" (uid, disabled, deleted) VALUES (?, ?, ?)');
    for (let index = 0; index < activeUsers; index += 1) {
      insert.run(index + 1, 0, 0);
    }
    insert.run(10_001, 1, 0);
    insert.run(10_002, 0, 1);
  } finally {
    database.close();
  }
}

function productionIni(port = '8180', address = '127.0.0.1', databaseEntry = 'data/ezbookkeeping.db') {
  return `[global]
mode = production
[uuid]
generator_type = internal
server_id = 0
[duplicate_checker]
checker_type = in_memory
cleanup_interval = 60
duplicate_submissions_interval = 300
[server]
protocol = http
http_addr = ${address}
http_port = ${port}
domain = localhost
root_url = http://127.0.0.1:${port}/
[mcp]
enable_mcp = false
mcp_allowed_remote_ips =
[database]
type = sqlite3
db_path = ${databaseEntry}
[security]
secret_key = retained-production-secret
trusted_proxy_ips = 10.0.0.0/8,127.0.0.0/8
token_expired_time = 2592000
token_min_refresh_interval = 86400
enable_api_token = true
api_token_allowed_remote_ips =
max_failures_per_ip_per_minute = 5
max_failures_per_user_per_minute = 5
[auth]
enable_internal_auth = true
enable_oauth2_auth = false
enable_two_factor = true
enable_forget_password = true
oauth2_user_identifier = email
[user]
enable_register = true
[map]
amap_security_verification_method = internal_proxy
[exchange_rates]
data_source = euro_central_bank
`;
}

function makeMigrationFixture({ activeUsers = 1, address = '127.0.0.1', staticMcp = false, alternateDatabase = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-ledger-migration-'));
  const installDirectory = join(directory, 'ezbookkeeping');
  const configDirectoryPath = join(installDirectory, 'conf');
  const dataDirectory = join(installDirectory, 'data');
  const configPath = join(configDirectoryPath, 'ezbookkeeping.ini');
  const executablePath = join(installDirectory, 'ezbookkeeping.exe');
  const databasePath = alternateDatabase
    ? join(installDirectory, 'alternate', 'ledger.db')
    : join(dataDirectory, 'ezbookkeeping.db');
  const openClawConfigPath = join(directory, 'openclaw.json');
  const backupRoot = join(directory, 'backups');
  mkdirSync(configDirectoryPath, { recursive: true });
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(executablePath, '', 'utf8');
  writeFileSync(configPath, productionIni('8180', address, alternateDatabase ? 'alternate/ledger.db' : 'data/ezbookkeeping.db'), 'utf8');
  mkdirSync(dirname(databasePath), { recursive: true });
  writeLedgerFixture(databasePath, activeUsers);
  writeFileSync(openClawConfigPath, JSON.stringify(staticMcp
    ? { plugins: { entries: { bookkeeping: { config: { mcpToken: 'must-never-be-printed' } } } } }
    : { plugins: { entries: { bookkeeping: { config: { mcpTokenPath: 'local-file-only' } } } } }), 'utf8');
  return {
    directory,
    installDirectory,
    configPath,
    executablePath,
    databasePath,
    openClawConfigPath,
    backupRoot,
  };
}

function writeMigrationWrapper(path) {
  writeFileSync(path, `
$global:scenario = $args[1]
$global:installDirectory = $args[2]
$global:configPath = Join-Path $global:installDirectory 'conf\\ezbookkeeping.ini'
$global:executable = Join-Path $global:installDirectory 'ezbookkeeping.exe'
$global:phase = 'old'
$global:preflightExported = $false
$global:exportCount = 0
$global:targetPortChecks = 0
$global:rollbackReplacementDone = $false
$global:trace = @()
$global:LedgerTestEnvironmentOverrides = @{}
if ($args.Count -gt 6 -and -not [string]::IsNullOrWhiteSpace($args[6])) {
    $scopeOverrides = @{}
    $scopeOverrides[[string]$args[6]] = 'override-must-not-be-printed'
    $global:LedgerTestEnvironmentOverrides['Process'] = $scopeOverrides
}

$global:task = [pscustomobject]@{
    TaskName = 'Clawbot migration fixture'
    TaskPath = '\\'
    State = if ($global:scenario -eq 'task-not-running') { 'Ready' } else { 'Running' }
    Actions = @([pscustomobject]@{ Execute = $global:executable; Arguments = 'server run'; WorkingDirectory = $global:installDirectory })
}
function Get-ScheduledTask {
    [CmdletBinding()] param([string]$TaskName, [string]$TaskPath)
    if ($global:scenario -eq 'rollback-task-replaced' -and
        -not $global:rollbackReplacementDone -and
        $global:phase -eq 'stopped' -and
        $global:trace -contains 'start-task' -and
        $global:task.Actions[0].Arguments -ne 'server run') {
        $knownTask = $global:task
        $global:task = [pscustomobject]@{ TaskName = 'Clawbot migration fixture'; TaskPath = '\\'; State = 'Ready'; Actions = @([pscustomobject]@{ Execute = 'C:\\Other\\unknown.exe'; Arguments = 'unknown'; WorkingDirectory = 'C:\\Other' }) }
        $global:rollbackReplacementDone = $true
        return $knownTask
    }
    return $global:task
}
function Export-ScheduledTask {
    [CmdletBinding()] param([string]$TaskName, [string]$TaskPath)
    $global:preflightExported = $true
    $global:exportCount++
    if ($global:scenario -eq 'override-after-preflight' -and $global:exportCount -eq 1) {
        $global:LedgerTestEnvironmentOverrides['Process'] = @{ 'EBK_RUNTIME_RACE' = 'override-must-not-be-printed' }
    }
    if ($global:scenario -eq 'config-changed-before-stop' -and $global:exportCount -eq 2) {
        [IO.File]::AppendAllText($global:configPath, ('; concurrent-setting-must-survive' + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
    }
    return '<Task version="1.4"><Actions /></Task>'
}
function New-ScheduledTaskAction { [CmdletBinding()] param([string]$Execute, [string]$Argument, [string]$WorkingDirectory) return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory } }
function Set-ScheduledTask {
    [CmdletBinding()] param([object]$InputObject)
    if ($InputObject -ne $global:task) { throw 'Wrong task object.' }
    $Action = $InputObject.Actions[0]
    $global:task.Actions = @($Action)
    $global:trace += if ($Action.Arguments -eq 'server run') { 'task-legacy' } else { 'task-explicit' }
    if ($global:scenario -eq 'task-update-throws-after-change' -and $Action.Arguments -ne 'server run') { throw 'Simulated task update interruption.' }
    return $global:task
}
function Register-ScheduledTask {
    [CmdletBinding()] param([string]$TaskName, [string]$TaskPath, [string]$Xml, [switch]$Force)
    if ($TaskName -ne $global:task.TaskName -or $Xml -notmatch '<Task') { throw 'Wrong task restore.' }
    $global:task.Actions = @([pscustomobject]@{ Execute = $global:executable; Arguments = 'server run'; WorkingDirectory = $global:installDirectory })
    $global:trace += 'task-legacy'
    return $global:task
}
function Stop-ScheduledTask {
    [CmdletBinding()] param([object]$InputObject)
    if ($InputObject -ne $global:task) { throw 'Wrong task object.' }
    $global:trace += 'stop-task'
    if ($global:scenario -ne 'external-listener-after-stop') { $global:phase = 'stopped' }
}
function Start-ScheduledTask {
    [CmdletBinding()] param([object]$InputObject)
    if ($InputObject -ne $global:task) { throw 'Wrong task object.' }
    $global:trace += 'start-task'
    $global:phase = if ($global:task.Actions[0].Arguments -eq 'server run') { 'old' } else { 'new' }
    if ($global:phase -eq 'new' -and $global:scenario.StartsWith('startup-')) {
        $global:phase = 'exited'
        $global:task.State = 'Ready'
        if ($global:scenario -eq 'startup-foreign-task') { $global:task.Actions[0].Execute = 'C:\\Other\\unknown.exe' }
    } else {
        $global:task.State = 'Running'
    }
}
function Get-NetTCPConnection {
    [CmdletBinding()] param([string]$State, [int]$LocalPort)
    if ($LocalPort -eq 8888) {
        $global:targetPortChecks++
        if ($global:scenario -eq 'override-before-write' -and $global:targetPortChecks -eq 2) {
            $global:LedgerTestEnvironmentOverrides['Process'] = @{ 'EBK_RUNTIME_RACE' = 'override-must-not-be-printed' }
        }
    }
    if ($global:scenario -eq 'target-port-occupied' -and $LocalPort -eq 8888) { return [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8888; OwningProcess = 9001 } }
    if ($global:phase -eq 'exited' -and $LocalPort -eq 8888) {
        if ($global:scenario -eq 'startup-foreign-listener') { return [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8888; OwningProcess = 9001 } }
        if ($global:scenario -eq 'startup-detached-listener') { return [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8888; OwningProcess = 4200 } }
    }
    if ($global:scenario -eq 'wrong-owner' -and $LocalPort -eq 8180) { return [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8180; OwningProcess = 9001 } }
    if ($global:scenario -eq 'owner-changed-before-stop' -and $global:preflightExported -and $LocalPort -eq 8180) { return [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8180; OwningProcess = 9001 } }
    if ($global:phase -eq 'old' -and $LocalPort -eq 8180) { return [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8180; OwningProcess = 4100 } }
    if ($global:phase -eq 'new' -and $LocalPort -eq 8888) { return [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8888; OwningProcess = 4200 } }
    return @()
}
function Get-CimInstance {
    [CmdletBinding()] param([string]$ClassName, [string]$Filter)
    if ($Filter -match '9001') { return [pscustomobject]@{ ProcessId = 9001; CreationDate = 'wrong'; ExecutablePath = 'C:\\Other\\other.exe'; CommandLine = 'other.exe' } }
    if ($Filter -match '4100') { return [pscustomobject]@{ ProcessId = 4100; CreationDate = 'old'; ExecutablePath = $global:executable; CommandLine = ('"' + $global:executable + '" server run') } }
    if ($Filter -match '4200') { return [pscustomobject]@{ ProcessId = 4200; CreationDate = 'new'; ExecutablePath = $global:executable; CommandLine = ('"' + $global:executable + '" --conf-path "' + $global:configPath + '" server run') } }
    return @()
}
function Stop-Process { [CmdletBinding()] param([int]$Id, [switch]$Force) if ($Id -ne 4100 -and $Id -ne 4200) { throw 'Unknown PID stop attempted.' }; $global:trace += ('stop-process-' + $Id); $global:phase = 'stopped' }
function Invoke-RestMethod {
    [CmdletBinding()] param([string]$Uri, [int]$MaximumRedirection, [int]$TimeoutSec)
    if ($global:scenario -eq 'old-unhealthy' -and $Uri -like '*:8180/*') { return [pscustomobject]@{ success = $false } }
    if (($global:scenario -in @('post-edit-unhealthy', 'rollback-task-replaced') -or $global:phase -eq 'exited') -and $Uri -like '*:8888/*') { return [pscustomobject]@{ success = $false } }
    return [pscustomobject]@{ success = $true }
}
function Invoke-WebRequest {
    [CmdletBinding()] param([string]$Uri, [switch]$UseBasicParsing, [int]$MaximumRedirection, [int]$TimeoutSec)
    return [pscustomobject]@{ Content = '<title>ezBookkeeping</title>' }
}
function Start-Sleep { [CmdletBinding()] param([int]$Milliseconds, [int]$Seconds) }
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
if (-not (Test-Path -LiteralPath $args[0] -PathType Leaf)) { throw 'Migration script is missing.' }
try {
    & $args[0] -InstallDirectory $args[2] -TaskName 'Clawbot migration fixture' -BackupRoot $args[3] -OpenClawConfigPath $args[4] -NodeExecutablePath $args[5] -StartupCheckAttempts 2 -StartupCheckIntervalMilliseconds 1 -Confirm:$false
    if ($global:scenario -ne 'success') { throw 'Expected migration rejection.' }
} catch {
    if ($global:scenario -eq 'success') { throw }
    if ($_.Exception.Message -match 'must-never-be-printed') { throw 'A secret was disclosed.' }
}
$global:trace -join ','
`, 'utf8');
}

function writeTestInstallerWrapper(path) {
  writeFileSync(path, `
$global:installerScript = $args[0]
$global:mode = $args[1]
$global:source = [IO.Path]::GetFullPath($args[2])
$global:install = [IO.Path]::GetFullPath($args[3])
$global:template = [IO.Path]::GetFullPath($args[4])
$global:node = [IO.Path]::GetFullPath($args[5])
$global:seedScript = [IO.Path]::GetFullPath($args[6])
$global:tokenPath = [IO.Path]::GetFullPath($args[7])
$global:config = Join-Path $global:install 'conf\\ezbookkeeping-test.ini'
$global:executable = Join-Path $global:install 'ezbookkeeping.exe'
$global:trace = @()
$global:phase = if ($global:mode -in @('retry-running', 'retry-detached', 'retry-survives', 'ready-healthy', 'ready-detached', 'ready-unhealthy', 'ready-missing-database')) { 'running' } else { 'stopped' }
$global:healthCount = 0
$global:ownerChanged = $false
$global:task = if ($global:mode -eq 'conflict') {
    [pscustomobject]@{ TaskName = 'Clawbot test fixture'; TaskPath = '\\'; State = 'Running'; Actions = @([pscustomobject]@{ Execute = 'C:\\Other\\other.exe'; Arguments = 'server run'; WorkingDirectory = 'C:\\Other' }) }
} elseif ($global:mode -in @('retry-running', 'retry-detached', 'retry-survives', 'ready-healthy', 'ready-stopped', 'ready-detached', 'ready-unhealthy', 'ready-missing-database')) {
    $state = if ($global:mode -in @('retry-detached', 'ready-stopped', 'ready-detached')) { 'Ready' } else { 'Running' }
    [pscustomobject]@{ TaskName = 'Clawbot test fixture'; TaskPath = '\\'; State = $state; Actions = @([pscustomobject]@{ Execute = $global:executable; Arguments = ('--conf-path "' + $global:config + '" server run'); WorkingDirectory = $global:install }) }
} else { $null }
function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName, [string]$TaskPath) return $global:task }
function New-ScheduledTaskAction { [CmdletBinding()] param([string]$Execute, [string]$Argument, [string]$WorkingDirectory) return [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory } }
function New-ScheduledTaskTrigger { [CmdletBinding()] param([switch]$AtLogOn, [string]$User) return [pscustomobject]@{} }
function New-ScheduledTaskSettingsSet { [CmdletBinding()] param([int]$RestartCount, [TimeSpan]$RestartInterval, [TimeSpan]$ExecutionTimeLimit, [string]$MultipleInstances, [switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries) return [pscustomobject]@{} }
function New-ScheduledTaskPrincipal { [CmdletBinding()] param([string]$UserId, [string]$LogonType, [string]$RunLevel) if ($LogonType -cne 'S4U' -or $RunLevel -cne 'Limited') { throw 'Test instance must run in a password-free background session.' }; return [pscustomobject]@{} }
function Register-ScheduledTask {
    [CmdletBinding()] param([string]$TaskName, [object]$Action, [object]$Trigger, [object]$Settings, [object]$Principal, [string]$Description, [switch]$Force)
    if ($Force) { throw 'Installer used Force.' }
    if ($null -ne $global:task) { throw 'Installer overwrote a task.' }
    $expectedArguments = '--conf-path "' + $global:config + '" server run'
    if ($TaskName -cne 'Clawbot test fixture' -or
        -not [string]::Equals([string]$Action.Execute, $global:executable, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$Action.WorkingDirectory, $global:install, [StringComparison]::OrdinalIgnoreCase) -or
        [string]$Action.Arguments -cne $expectedArguments) {
        throw 'Installer registered an unexpected task action.'
    }
    $global:task = [pscustomobject]@{ TaskName = $TaskName; TaskPath = '\\'; State = 'Ready'; Actions = @($Action) }
    $global:trace += 'register'
    if ($global:mode -eq 'registered-task-became-unverifiable') {
        $global:task.Actions = @([pscustomobject]@{ Execute = 'C:\\Other\\other.exe'; Arguments = 'server run'; WorkingDirectory = 'C:\\Other' })
    }
    return $global:task
}
function Stop-ScheduledTask { [CmdletBinding()] param([object]$InputObject) $global:trace += 'stop'; if ($global:mode -ne 'retry-survives') { $global:phase = 'stopped' }; if ($global:task) { $global:task.State = 'Ready' } }
function Start-ScheduledTask { [CmdletBinding()] param([object]$InputObject) $global:trace += 'start'; $global:phase = 'running'; $global:task.State = 'Running' }
function Get-NetTCPConnection { [CmdletBinding()] param([string]$State, [int]$LocalPort) if ($global:phase -eq 'running' -and $LocalPort -eq 18888) { $owner = if ($global:mode -eq 'owner-changed-before-lockdown' -and $global:ownerChanged) { 6262 } else { 6161 }; return [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 18888; OwningProcess = $owner } }; return @() }
function Get-CimInstance { [CmdletBinding()] param([string]$ClassName, [string]$Filter) if ($Filter -match '6262') { return [pscustomobject]@{ ProcessId = 6262; CreationDate = 'unknown'; ExecutablePath = 'C:\\Other\\other.exe'; CommandLine = 'other.exe' } }; return [pscustomobject]@{ ProcessId = 6161; CreationDate = 'test'; ExecutablePath = $global:executable; CommandLine = ('"' + $global:executable + '" --conf-path "' + $global:config + '" server run') } }
function Stop-Process { [CmdletBinding()] param([int]$Id, [switch]$Force) $global:trace += 'stop-process'; throw 'Installer attempted to stop a lingering process in the fixture.' }
function Invoke-RestMethod {
    [CmdletBinding()] param([string]$Uri, [string]$Method, [object]$Headers, [string]$ContentType, [string]$Body, [int]$MaximumRedirection, [int]$TimeoutSec)
    if ($MaximumRedirection -ne 0 -or $TimeoutSec -gt 5) { throw 'Request was not bounded or redirects were enabled.' }
    if ($Uri -like '*healthz.json') {
        $global:healthCount++
        if ($global:mode -eq 'ready-unhealthy') { return [pscustomobject]@{ success = $false } }
        if ($global:mode -eq 'lockdown-fail' -and $global:healthCount -gt 1) { return [pscustomobject]@{ success = $false } }
        return [pscustomobject]@{ success = $true }
    }
    if ($Uri -like '*/api/register.json') {
        $global:trace += 'register-api'
        if ($global:mode -eq 'registration-fail') { return [pscustomobject]@{ success = $false } }
        & $global:node $global:seedScript (Join-Path $global:install 'data\\ezbookkeeping-test.db')
        if ($LASTEXITCODE -ne 0) { throw 'Could not seed test database fixture.' }
        return [pscustomobject]@{ success = $true; result = [pscustomobject]@{ token = 'temporary-session-token' } }
    }
    if ($Uri -like '*/api/v1/tokens/generate/api.json') {
        $global:trace += 'api-token'
        if (-not $Headers.Authorization.StartsWith('Bearer ') -or [string]::IsNullOrWhiteSpace($Body)) { throw 'Token request was incomplete.' }
        $global:ownerChanged = $true
        return [pscustomobject]@{ success = $true; result = [pscustomobject]@{ token = 'isolated-test-api-token' } }
    }
    throw 'Unexpected local request.'
}
function Invoke-WebRequest { [CmdletBinding()] param([string]$Uri, [switch]$UseBasicParsing, [int]$MaximumRedirection, [int]$TimeoutSec) return [pscustomobject]@{ Content = '<title>ezBookkeeping</title>' } }
function Read-Host {
    [CmdletBinding()] param([string]$Prompt, [switch]$AsSecureString)
    if ($Prompt -match 'password') {
        if (-not $AsSecureString) { throw 'Password prompt was not secure.' }
        $global:trace += 'password'
        $secure = New-Object System.Security.SecureString
        'temporary-password'.ToCharArray() | ForEach-Object { $secure.AppendChar($_) }
        $secure.MakeReadOnly()
        Write-Output -NoEnumerate $secure
        return
    }
    $global:trace += 'identity'
    if ($Prompt -match 'email') { return 'test-only@example.invalid' }
    if ($Prompt -match 'nickname') { return 'Isolated test user' }
    return 'isolated_test_user'
}
function Start-Sleep { [CmdletBinding()] param([int]$Milliseconds) }
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
if (-not (Test-Path -LiteralPath $global:installerScript -PathType Leaf)) { throw 'Test installer script is missing.' }
$parameters = @{
    SourceInstallDirectory = $global:source
    InstallDirectory = $global:install
    TaskName = 'Clawbot test fixture'
    NodeExecutablePath = $global:node
    TestTokenPath = $global:tokenPath
    StartupCheckAttempts = 2
    StartupCheckIntervalMilliseconds = 1
    Confirm = $false
}
if ($global:mode -ne 'default-paths') { $parameters.TemplatePath = $global:template }
if ($global:mode -eq 'whatif') { $parameters.WhatIf = $true }
$global:installerCompleted = $false
try {
    & $global:installerScript @parameters
    $global:installerCompleted = $true
} catch {
    if ($global:mode -notin @('conflict', 'missing-node', 'overlap-token', 'registration-fail', 'lockdown-fail', 'owner-changed-before-lockdown', 'registered-task-became-unverifiable', 'retry-detached', 'retry-survives', 'ready-stopped', 'ready-detached', 'ready-unhealthy', 'ready-missing-database')) { throw }
    if ($global:mode -in @('owner-changed-before-lockdown', 'registered-task-became-unverifiable')) {
        if ($_.Exception.Message -notmatch 'could not be fully verified|rollback.*incomplete') { throw }
        $global:trace += 'rollback-incomplete'
    }
}
$expectedRejection = $global:mode -in @('conflict', 'missing-node', 'overlap-token', 'registration-fail', 'lockdown-fail', 'owner-changed-before-lockdown', 'registered-task-became-unverifiable', 'retry-detached', 'retry-survives', 'ready-stopped', 'ready-detached', 'ready-unhealthy', 'ready-missing-database')
if ($expectedRejection -and $global:installerCompleted) { throw 'Expected installer rejection.' }
$global:trace -join ','
`, 'utf8');
}

function makeTestInstallFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-ledger-test-install-'));
  const sourceDirectory = join(directory, 'source');
  const installDirectory = join(directory, 'test-instance');
  const tokenPath = join(directory, 'secrets', 'ezbookkeeping-test-token.txt');
  const wrapperPath = join(directory, 'test-installer-wrapper.ps1');
  const seedScript = join(directory, 'seed-test-user.mjs');
  mkdirSync(join(sourceDirectory, 'public', 'assets'), { recursive: true });
  mkdirSync(join(sourceDirectory, 'conf'), { recursive: true });
  mkdirSync(join(sourceDirectory, 'data'), { recursive: true });
  mkdirSync(join(sourceDirectory, 'log'), { recursive: true });
  writeFileSync(join(sourceDirectory, 'ezbookkeeping.exe'), 'immutable-test-program', 'utf8');
  writeFileSync(join(sourceDirectory, 'public', 'index.html'), '<title>ezBookkeeping</title>', 'utf8');
  writeFileSync(join(sourceDirectory, 'public', 'assets', 'app.js'), 'void 0;', 'utf8');
  writeFileSync(join(sourceDirectory, 'conf', 'ezbookkeeping.ini'), 'secret_key = production-secret-must-not-copy', 'utf8');
  writeFileSync(join(sourceDirectory, 'data', 'ezbookkeeping.db'), 'production-data-must-not-copy', 'utf8');
  writeFileSync(join(sourceDirectory, 'log', 'ezbookkeeping.log'), 'production-log-must-not-copy', 'utf8');
  writeFileSync(seedScript, `
import { DatabaseSync } from 'node:sqlite';
const database = new DatabaseSync(process.argv[2]);
database.exec('CREATE TABLE "user" (uid INTEGER PRIMARY KEY, disabled INTEGER NOT NULL, deleted INTEGER NOT NULL); INSERT INTO "user" (uid, disabled, deleted) VALUES (1, 0, 0);');
database.close();
`, 'utf8');
  writeTestInstallerWrapper(wrapperPath);
  return {
    directory,
    sourceDirectory,
    installDirectory,
    tokenPath,
    wrapperPath,
    seedScript,
    templatePath: join(configDirectory, 'ezbookkeeping-test.example.ini'),
  };
}

test('production code and active configuration use only the exact loopback 8888 origin', () => {
  const files = [
    join(pluginDirectory, 'adapter.mjs'),
    join(pluginDirectory, 'index.ts'),
    join(pluginDirectory, 'mcp-connection.mjs'),
    join(pluginDirectory, 'openclaw.plugin.json'),
    join(configDirectory, 'expense-categories.json'),
    join(scriptsDirectory, 'configure-ezbookkeeping-mcp.ps1'),
  ];
  for (const path of files) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /127\.0\.0\.1:8180/u, path);
    assert.doesNotMatch(source, /localhost:8888|0\.0\.0\.0:8888/u, path);
  }

  const adapterSource = readFileSync(join(pluginDirectory, 'adapter.mjs'), 'utf8');
  const indexSource = readFileSync(join(pluginDirectory, 'index.ts'), 'utf8');
  const mcpSource = readFileSync(join(pluginDirectory, 'mcp-connection.mjs'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(pluginDirectory, 'openclaw.plugin.json'), 'utf8'));
  const categoryCatalog = JSON.parse(readFileSync(join(configDirectory, 'expense-categories.json'), 'utf8'));
  assert.match(adapterSource, /http:\/\/127\.0\.0\.1:8888/u);
  assert.match(indexSource, /http:\/\/127\.0\.0\.1:8888/u);
  assert.match(mcpSource, /const EZBOOKKEEPING_ORIGIN = 'http:\/\/127\.0\.0\.1:8888'/u);
  assert.equal(manifest.configSchema.properties.serverBaseUrl.const, 'http://127.0.0.1:8888');
  assert.equal(manifest.mcpServers.ezbookkeeping.url, 'http://127.0.0.1:8888/mcp');
  assert.equal(Object.hasOwn(categoryCatalog, 'target'), false);
  assert.equal(categoryCatalog.status, 'imported_verified');
});

test('shared secret-path guard rejects repository, OneDrive, and reparse ancestry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-ledger-secret-paths-'));
  try {
    const wrapperPath = join(directory, 'secret-path-wrapper.ps1');
    const safePath = join(directory, 'safe', 'token.txt');
    const oneDrivePath = join(directory, 'OneDrive - fixture', 'token.txt');
    const junctionTarget = join(directory, 'junction-target');
    const junctionPath = join(directory, 'junction');
    mkdirSync(junctionTarget);
    symlinkSync(junctionTarget, junctionPath, 'junction');
    writeFileSync(wrapperPath, `
. $args[0]
foreach ($candidate in @($args[1], $args[2], $args[3], $args[4])) {
    try {
        $null = Assert-LedgerExternalSecretPath -Path $candidate -Description 'fixture secret'
        'accepted'
    } catch {
        'rejected'
    }
}
`, 'utf8');
    const result = runPowerShell([
      '-File', wrapperPath, join(scriptsDirectory, 'ledger-runtime-common.ps1'),
      safePath,
      join(projectDirectory, 'must-not-write-token.txt'),
      oneDrivePath,
      join(junctionPath, 'token.txt'),
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/u), [
      'accepted',
      'rejected',
      'rejected',
      'rejected',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('test-ledger initialization is dry-run safe and exact to the isolated 18888 instance', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-test-ledger-'));
  try {
    const installDirectory = join(directory, 'ezbookkeeping-test');
    const tokenPath = join(directory, 'secrets', 'ezbookkeeping-test-token.txt');
    const markerPath = join(installDirectory, '.clawbot-ledger-test-instance-ready');
    const categoriesPath = join(directory, 'categories.json');
    const configPath = join(installDirectory, 'conf', 'ezbookkeeping-test.ini');
    const executablePath = join(installDirectory, 'ezbookkeeping.exe');
    const wrapperPath = join(directory, 'invoke-initialize.ps1');
    mkdirSync(dirname(tokenPath), { recursive: true });
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(tokenPath, 'token-must-not-be-read-or-printed', 'utf8');
    writeFileSync(markerPath, 'CLAWBOT_LEDGER_TEST_INSTANCE_READY_V1\n', 'utf8');
    writeFileSync(categoriesPath, '{"currency":"SGD","timezone":"Asia/Singapore","categories":[]}', 'utf8');
    writeFileSync(executablePath, '', 'utf8');
    writeFileSync(configPath, `; CLAWBOT_LEDGER_PROFILE=test
[global]
mode = production
[uuid]
generator_type = internal
server_id = 1
[duplicate_checker]
checker_type = in_memory
cleanup_interval = 60
duplicate_submissions_interval = 300
[server]
protocol = http
http_addr = 127.0.0.1
http_port = 18888
domain = 127.0.0.1
root_url = http://127.0.0.1:18888/
[mcp]
enable_mcp = false
mcp_allowed_remote_ips = 127.0.0.1
[database]
type = sqlite3
db_path = ${join(installDirectory, 'data', 'ezbookkeeping-test.db')}
[log]
log_path = ${join(installDirectory, 'log', 'ezbookkeeping-test.log')}
[storage]
type = local_filesystem
local_filesystem_path = ${join(installDirectory, 'storage')}
[security]
secret_key = local-test-secret-value
trusted_proxy_ips = 127.0.0.1/32
token_expired_time = 604800
token_min_refresh_interval = 86400
enable_api_token = true
api_token_allowed_remote_ips = 127.0.0.1
max_failures_per_ip_per_minute = 5
max_failures_per_user_per_minute = 5
[auth]
enable_internal_auth = true
enable_oauth2_auth = false
enable_two_factor = true
enable_forget_password = false
oauth2_user_identifier = email
[user]
enable_register = false
[map]
amap_security_verification_method = internal_proxy
[exchange_rates]
data_source = euro_central_bank
`, 'utf8');
    writeFileSync(wrapperPath, `
$global:httpCalled = $false
$global:expectedExecutable = $args[4]
$global:expectedConfig = $args[5]
function Get-NetTCPConnection { [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 18888; OwningProcess = 4242 } }
function Get-CimInstance { [pscustomobject]@{ ProcessId = 4242; CreationDate = '20260905120000.000000+480'; ExecutablePath = $global:expectedExecutable; CommandLine = ('"' + $global:expectedExecutable + '" --conf-path "' + $global:expectedConfig + '" server run') } }
function Get-Acl {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    [pscustomobject]@{
        Owner = $identity
        AreAccessRulesProtected = $true
        Access = @([pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = $identity }; AccessControlType = 'Allow'; FileSystemRights = 'FullControl' })
    }
}
function Invoke-RestMethod {
    $global:httpCalled = $true
    throw 'HTTP must not be called under WhatIf.'
}
& $args[0] -ServerBaseUrl 'http://127.0.0.1:18888' -TokenPath $args[1] -TestInstanceMarkerPath $args[2] -CategoryConfigPath $args[3] -ExpectedExecutablePath $args[4] -TestConfigPath $args[5] -TestInstallDirectory $args[6] -WhatIf
if ($global:httpCalled) { throw 'HTTP was called under WhatIf.' }
`, 'utf8');

    const result = runPowerShell(['-File', wrapperPath, initializeTestLedgerScript, tokenPath, markerPath, categoriesPath, executablePath, configPath, installDirectory]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.includes('token-must-not-be-read-or-printed'), false);
    assert.equal(result.stderr.includes('token-must-not-be-read-or-printed'), false);

    const source = readFileSync(initializeTestLedgerScript, 'utf8');
    assert.match(source, /CmdletBinding\s*\(\s*SupportsShouldProcess/u);
    assert.match(source, /UTF8Encoding\(\$false,\s*\$true\)/u);
    assert.match(source, /Split-Path -Leaf \$TokenPath[^\r\n]*ezbookkeeping-test-token\.txt/u);
    const guard = source.indexOf('if (-not $PSCmdlet.ShouldProcess(');
    assert.ok(guard >= 0);
    assert.ok(guard < source.indexOf('[IO.File]::ReadAllText($TokenPath'));
    assert.ok(guard < source.indexOf('Invoke-EbkApi -Method'));

    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('enable_mcp = false', 'enable_mcp = true'), 'utf8');
    const unsafeMcp = runPowerShell(['-File', wrapperPath, initializeTestLedgerScript, tokenPath, markerPath, categoriesPath, executablePath, configPath, installDirectory]);
    assert.notEqual(unsafeMcp.status, 0);
    assert.match(unsafeMcp.stderr, /configuration is not ready/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('test-ledger initialization rejects non-test origins, missing markers, and the production token path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-test-ledger-reject-'));
  try {
    const tokenPath = join(directory, 'ezbookkeeping-test-token.txt');
    const markerPath = join(directory, '.clawbot-ledger-test-instance-ready');
    const categoriesPath = join(directory, 'categories.json');
    writeFileSync(tokenPath, 'unused-test-token', 'utf8');
    writeFileSync(markerPath, 'CLAWBOT_LEDGER_TEST_INSTANCE_READY_V1\n', 'utf8');
    writeFileSync(categoriesPath, '{"currency":"SGD","timezone":"Asia/Singapore","categories":[]}', 'utf8');

    for (const invalidOrigin of [
      'http://127.0.0.1:8888',
      'http://localhost:18888',
      'https://127.0.0.1:18888',
      'http://127.0.0.1:18888/',
      'http://127.0.0.1:18888/path',
    ]) {
      const result = runPowerShell([
        '-File', initializeTestLedgerScript,
        '-ServerBaseUrl', invalidOrigin,
        '-TokenPath', tokenPath,
        '-TestInstanceMarkerPath', markerPath,
        '-CategoryConfigPath', categoriesPath,
        '-WhatIf',
      ]);
      assert.notEqual(result.status, 0, invalidOrigin);
      assert.match(result.stderr, /exact isolated test endpoint/i);
    }

    const missingMarker = runPowerShell([
      '-File', initializeTestLedgerScript,
      '-TokenPath', tokenPath,
      '-TestInstanceMarkerPath', join(directory, 'missing-marker'),
      '-CategoryConfigPath', categoriesPath,
      '-WhatIf',
    ]);
    assert.notEqual(missingMarker.status, 0);
    assert.match(missingMarker.stderr, /test instance marker/i);

    const productionTokenPath = join(process.env.USERPROFILE, '.openclaw', 'secrets', 'ezbookkeeping-token.txt');
    const productionToken = runPowerShell([
      '-File', initializeTestLedgerScript,
      '-TokenPath', productionTokenPath,
      '-TestInstanceMarkerPath', markerPath,
      '-CategoryConfigPath', categoriesPath,
      '-WhatIf',
    ]);
    assert.notEqual(productionToken.status, 0);
    assert.match(productionToken.stderr, /production token path/i);

    for (const overlappingTokenPath of [
      'D:\\Clawbot\\ezbookkeeping\\secrets\\ezbookkeeping-test-token.txt',
      'D:\\Clawbot\\ezbookkeeping-test\\secrets\\ezbookkeeping-test-token.txt',
    ]) {
      const overlappingToken = runPowerShell([
        '-File', initializeTestLedgerScript,
        '-TokenPath', overlappingTokenPath,
        '-TestInstanceMarkerPath', markerPath,
        '-CategoryConfigPath', categoriesPath,
        '-WhatIf',
      ]);
      assert.notEqual(overlappingToken.status, 0);
      assert.match(overlappingToken.stderr, /token path.*overlaps/i);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('test-ledger initialization treats a fresh missing expense-category property as an empty list', () => {
  const source = readFileSync(initializeTestLedgerScript, 'utf8');

  assert.match(source, /\.PSObject\.Properties\[\$Name\]/u);
  assert.doesNotMatch(source, /\$categoryResponse\.'2'/u);
  assert.doesNotMatch(source, /\$verifiedCategoryResponse\.'2'/u);

  const helperStart = source.indexOf('function Get-EbkCollectionProperty');
  const helperEnd = source.indexOf('\nif ($ServerBaseUrl', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);
  const result = runPowerShell([
    '-Command',
    `Set-StrictMode -Version Latest\n${helper}\n$values = @(Get-EbkCollectionProperty -InputObject ([pscustomobject]@{}) -Name '2'); if ($values.Count -ne 0) { exit 2 }; 'EMPTY_PROPERTY_OK'`,
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /EMPTY_PROPERTY_OK/u);
});

test('sanitized production and test templates encode the complete runtime boundary', () => {
  const production = readFileSync(join(configDirectory, 'ezbookkeeping-production.example.ini'), 'utf8');
  const isolatedTest = readFileSync(join(configDirectory, 'ezbookkeeping-test.example.ini'), 'utf8');
  assert.match(production, /^; CLAWBOT_LEDGER_PROFILE=production$/mu);
  assert.match(isolatedTest, /^; CLAWBOT_LEDGER_PROFILE=test$/mu);
  assert.match(production, /^mode\s*=\s*production$/mu);
  assert.match(isolatedTest, /^mode\s*=\s*production$/mu);
  assert.match(production, /^\[uuid\]$/mu);
  assert.match(production, /^generator_type\s*=\s*internal$/mu);
  assert.match(production, /^server_id\s*=\s*0$/mu);
  assert.match(isolatedTest, /^\[uuid\]$/mu);
  assert.match(isolatedTest, /^generator_type\s*=\s*internal$/mu);
  assert.match(isolatedTest, /^server_id\s*=\s*1$/mu);

  for (const [source, port, domain, rootUrl] of [
    [production, '8888', 'ledger.66ccff-labs.com', 'https://ledger.66ccff-labs.com/'],
    [isolatedTest, '18888', '127.0.0.1', 'http://127.0.0.1:18888/'],
  ]) {
    assert.match(source, new RegExp(`http_addr\\s*=\\s*127\\.0\\.0\\.1`));
    assert.match(source, new RegExp(`http_port\\s*=\\s*${port}`));
    assert.match(source, new RegExp(`domain\\s*=\\s*${domain.replaceAll('.', '\\.')}`));
    assert.ok(source.includes(`root_url = ${rootUrl}`));
    assert.match(source, /mcp_allowed_remote_ips\s*=\s*127\.0\.0\.1/u);
    assert.match(source, /^trusted_proxy_ips\s*=\s*127\.0\.0\.1\/32$/mu);
    assert.match(source, /enable_api_token\s*=\s*true/u);
    assert.match(source, /api_token_allowed_remote_ips\s*=\s*127\.0\.0\.1/u);
    assert.match(source, /token_expired_time\s*=\s*604800/u);
    assert.match(source, /token_min_refresh_interval\s*=\s*86400/u);
    assert.match(source, /max_failures_per_ip_per_minute\s*=\s*5/u);
    assert.match(source, /max_failures_per_user_per_minute\s*=\s*5/u);
    assert.match(source, /enable_internal_auth\s*=\s*true/u);
    assert.match(source, /enable_oauth2_auth\s*=\s*false/u);
    assert.match(source, /enable_two_factor\s*=\s*true/u);
    assert.match(source, /enable_forget_password\s*=\s*false/u);
    assert.match(source, /enable_register\s*=\s*false/u);
    assert.match(source, /checker_type\s*=\s*in_memory/u);
    assert.match(source, /oauth2_user_identifier\s*=\s*email/u);
    assert.match(source, /amap_security_verification_method\s*=\s*internal_proxy/u);
    assert.match(source, /data_source\s*=\s*euro_central_bank/u);
    assert.doesNotMatch(source, /^(?:password|passwd|api_token|mcp_token|secret_key)\s*=\s*(?!__)[^\s;]/imu);
  }
  assert.match(production, /db_path\s*=\s*D:\\Clawbot\\ezbookkeeping\\data\\ezbookkeeping\.db/u);
  assert.match(isolatedTest, /db_path\s*=\s*D:\\Clawbot\\ezbookkeeping-test\\data\\ezbookkeeping-test\.db/u);
  assert.match(isolatedTest, /log_path\s*=\s*D:\\Clawbot\\ezbookkeeping-test\\log\\ezbookkeeping-test\.log/u);
  assert.match(isolatedTest, /local_filesystem_path\s*=\s*D:\\Clawbot\\ezbookkeeping-test\\storage/u);
  assert.doesNotMatch(isolatedTest, /ledger\.66ccff-labs\.com|ezbookkeeping\\data\\ezbookkeeping\.db/u);
});

test('isolated test runtime validation requires its unique UUID generator identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-ledger-test-uuid-'));
  try {
    const installDirectory = join(directory, 'ezbookkeeping-test');
    const configPath = join(installDirectory, 'conf', 'ezbookkeeping-test.ini');
    const wrapperPath = join(directory, 'validate-test-config.ps1');
    mkdirSync(join(installDirectory, 'conf'), { recursive: true });
    writeFileSync(wrapperPath, `
. $args[0]
try {
    $null = Assert-LedgerTestConfiguration -InstallDirectory $args[1] -ConfigPath $args[2]
    'accepted'
} catch {
    'rejected'
}
`, 'utf8');

    const base = `; CLAWBOT_LEDGER_PROFILE=test
[global]
mode = production
[server]
protocol = http
http_addr = 127.0.0.1
http_port = 18888
domain = 127.0.0.1
root_url = http://127.0.0.1:18888/
[mcp]
enable_mcp = false
mcp_allowed_remote_ips = 127.0.0.1
[duplicate_checker]
checker_type = in_memory
cleanup_interval = 60
duplicate_submissions_interval = 300
[database]
type = sqlite3
db_path = ${join(installDirectory, 'data', 'ezbookkeeping-test.db')}
[log]
log_path = ${join(installDirectory, 'log', 'ezbookkeeping-test.log')}
[storage]
local_filesystem_path = ${join(installDirectory, 'storage')}
[security]
secret_key = generated-test-secret
trusted_proxy_ips = 127.0.0.1/32
token_expired_time = 604800
token_min_refresh_interval = 86400
enable_api_token = true
api_token_allowed_remote_ips = 127.0.0.1
max_failures_per_ip_per_minute = 5
max_failures_per_user_per_minute = 5
[auth]
enable_internal_auth = true
enable_oauth2_auth = false
enable_two_factor = true
enable_forget_password = false
oauth2_user_identifier = email
[user]
enable_register = false
[map]
amap_security_verification_method = internal_proxy
[exchange_rates]
data_source = euro_central_bank
`;

    for (const [uuidBlock, expected] of [
      ['', 'rejected'],
      ['[uuid]\ngenerator_type = external\nserver_id = 1\n', 'rejected'],
      ['[uuid]\ngenerator_type = internal\nserver_id = 0\n', 'rejected'],
      ['[uuid]\ngenerator_type = internal\nserver_id = 1\n', 'accepted'],
    ]) {
      writeFileSync(configPath, `${base}${uuidBlock}`, 'utf8');
      const result = runPowerShell([
        '-File', wrapperPath, join(scriptsDirectory, 'ledger-runtime-common.ps1'), installDirectory, configPath,
      ]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stdout.trim(), expected, uuidBlock || 'missing UUID block');
    }

    const valid = `${base}[uuid]\ngenerator_type = internal\nserver_id = 1\n`;
    for (const [setting, invalid] of [
      ['trusted_proxy_ips = 127.0.0.1/32', 'trusted_proxy_ips = 127.0.0.1'],
      ['checker_type = in_memory', 'checker_type = unsupported'],
      ['cleanup_interval = 60', 'cleanup_interval = 61'],
      ['duplicate_submissions_interval = 300', 'duplicate_submissions_interval = 0'],
      ['oauth2_user_identifier = email', 'oauth2_user_identifier = unsupported'],
      ['amap_security_verification_method = internal_proxy', 'amap_security_verification_method = unsupported'],
      ['data_source = euro_central_bank', 'data_source = unsupported'],
    ]) {
      writeFileSync(configPath, valid.replace(setting, invalid), 'utf8');
      const result = runPowerShell([
        '-File', wrapperPath, join(scriptsDirectory, 'ledger-runtime-common.ps1'), installDirectory, configPath,
      ]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stdout.trim(), 'rejected', setting);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite verifier reports only integrity state and active-user count', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-ledger-sqlite-'));
  try {
    for (const activeUsers of [0, 1, 2]) {
      const databasePath = join(directory, `ledger-${activeUsers}.db`);
      writeLedgerFixture(databasePath, activeUsers);
      const result = run(process.execPath, [sqliteVerifier, '--database', databasePath]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(JSON.parse(result.stdout), {
        status: 'verified',
        headerValid: true,
        quickCheck: 'ok',
        activeUserCount: activeUsers,
      });
      assert.equal(result.stdout.includes(databasePath), false);
      assert.doesNotMatch(result.stdout, /username|password|token|transaction/iu);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite verifier rejects corrupt and non-SQLite input without disclosing paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-ledger-sqlite-invalid-'));
  try {
    for (const [name, contents] of [
      ['not-sqlite.db', 'not a SQLite database'],
      ['header-only.db', Buffer.from('SQLite format 3\0', 'binary')],
    ]) {
      const databasePath = join(directory, name);
      writeFileSync(databasePath, contents);
      const result = run(process.execPath, [sqliteVerifier, '--database', databasePath]);
      assert.notEqual(result.status, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        status: 'rejected',
        headerValid: name === 'header-only.db',
        quickCheck: 'failed',
        activeUserCount: null,
      });
      assert.equal(result.stdout.includes(databasePath), false);
      assert.equal(result.stderr.includes(databasePath), false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite verifier is defensive, rejects a missing user table, and never overwrites a backup', () => {
  const source = readFileSync(sqliteVerifier, 'utf8');
  assert.match(source, /new DatabaseSync\([^\n]+\{\s*readOnly:\s*true,\s*allowExtension:\s*false,\s*timeout:\s*5_000,\s*defensive:\s*true\s*\}/u);
  assert.match(source, /PRAGMA query_only = ON/u);

  const directory = mkdtempSync(join(tmpdir(), 'clawbot-ledger-sqlite-backup-'));
  try {
    const missingTablePath = join(directory, 'missing-table.db');
    const missingTable = new DatabaseSync(missingTablePath);
    missingTable.exec('CREATE TABLE harmless (id INTEGER PRIMARY KEY);');
    missingTable.close();
    const missingResult = run(process.execPath, [sqliteVerifier, '--database', missingTablePath]);
    assert.notEqual(missingResult.status, 0);
    assert.equal(JSON.parse(missingResult.stdout).headerValid, true);

    const sourcePath = join(directory, 'source.db');
    const backupPath = join(directory, 'backup.db');
    writeLedgerFixture(sourcePath, 1);
    const backupResult = run(process.execPath, [sqliteVerifier, '--database', sourcePath, '--backup-to', backupPath]);
    assert.equal(backupResult.status, 0, backupResult.stderr || backupResult.stdout);
    assert.equal(JSON.parse(backupResult.stdout).activeUserCount, 1);
    const firstBackup = readFileSync(backupPath);

    const overwriteResult = run(process.execPath, [sqliteVerifier, '--database', sourcePath, '--backup-to', backupPath]);
    assert.notEqual(overwriteResult.status, 0);
    assert.deepEqual(readFileSync(backupPath), firstBackup);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite verifier rejects a locked database within its fixed wait bound', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-ledger-sqlite-lock-'));
  let holder;
  try {
    const databasePath = join(directory, 'locked.db');
    const holderPath = join(directory, 'hold-lock.mjs');
    writeLedgerFixture(databasePath, 1);
    writeFileSync(holderPath, `
import { DatabaseSync } from 'node:sqlite';
const database = new DatabaseSync(process.argv[2]);
database.exec('BEGIN EXCLUSIVE; UPDATE "user" SET disabled = disabled WHERE uid = 1;');
process.stdout.write('locked\\n');
setInterval(() => {}, 1_000);
`, 'utf8');
    holder = spawn(process.execPath, [holderPath, databasePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const ready = await Promise.race([
      once(holder.stdout, 'data'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('lock holder did not start')), 3_000)),
    ]);
    assert.match(String(ready[0]), /locked/u);

    const startedAt = Date.now();
    const result = run(process.execPath, [sqliteVerifier, '--database', databasePath]);
    const elapsedMilliseconds = Date.now() - startedAt;
    assert.notEqual(result.status, 0);
    assert.ok(elapsedMilliseconds >= 4_000, `lock wait was unexpectedly short: ${elapsedMilliseconds}ms`);
    assert.ok(elapsedMilliseconds < 8_000, `lock wait exceeded its bound: ${elapsedMilliseconds}ms`);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 'rejected',
      headerValid: true,
      quickCheck: 'failed',
      activeUserCount: null,
    });
    assert.equal(`${result.stdout}\n${result.stderr}`.includes(databasePath), false);
  } finally {
    if (holder && holder.exitCode === null) {
      holder.kill();
      await once(holder, 'close');
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('listener ownership accepts only canonical quoted or unquoted explicit config command lines', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-ledger-owner-'));
  try {
    const wrapperPath = join(directory, 'listener-owner.ps1');
    const executablePath = join(directory, 'ezbookkeeping.exe');
    const configPath = join(directory, 'ezbookkeeping.ini');
    writeFileSync(wrapperPath, `
$global:commandLine = $args[3]
$global:expectedExecutable = $args[1]
$global:expectedConfig = $args[2]
function Get-NetTCPConnection { [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8888; OwningProcess = 5151 } }
function Get-CimInstance { [pscustomobject]@{ ProcessId = 5151; CreationDate = 'stable'; ExecutablePath = $global:expectedExecutable; CommandLine = $global:commandLine } }
. $args[0]
try {
    $null = Get-LedgerListenerOwner -Port 8888 -ExpectedExecutable $global:expectedExecutable -ExpectedConfigPath $global:expectedConfig
    'accepted'
} catch {
    'rejected:' + $_.Exception.Message
}
`, 'utf8');
    const serviceArguments = `--conf-path "${configPath}" server run`;
    for (const commandLine of [
      `"${executablePath}" ${serviceArguments}`,
      `"${executablePath}" --conf-path ${configPath} server run`,
    ]) {
      const result = runPowerShell(['-File', wrapperPath, join(scriptsDirectory, 'ledger-runtime-common.ps1'), executablePath, configPath, commandLine]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stdout.trim(), 'accepted');
    }
    for (const commandLine of [
      `"${executablePath}" ${serviceArguments} --extra`,
      `${executablePath} ${serviceArguments}`,
      `"${executablePath}" --conf-path ${configPath} server run --extra`,
      `"${executablePath}" server run`,
    ]) {
      const result = runPowerShell(['-File', wrapperPath, join(scriptsDirectory, 'ledger-runtime-common.ps1'), executablePath, configPath, commandLine]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout.trim(), /^rejected:/u);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production migration uses a supported Windows task action parameter set', () => {
  const source = readFileSync(migrationScript, 'utf8');

  assert.doesNotMatch(source, /Set-ScheduledTask\s+-InputObject[^\r\n]*-Action/u);
  assert.equal(
    source.match(/Set-ScheduledTask\s+-InputObject\s+\$task\s+-ErrorAction\s+Stop/g)?.length,
    2,
  );
  assert.match(source, /\$task\.Actions\s*=\s*@\(\$newAction\)/u);
  assert.match(source, /\$task\.Actions\s*=\s*@\(\$legacyAction\)/u);
});

test('production migration rejects unsafe preflight states before task or process control', () => {
  for (const fixtureCase of [
    { name: 'non-loopback', options: { address: '0.0.0.0' }, scenario: 'config-nonloopback' },
    { name: 'wrong owner', options: {}, scenario: 'wrong-owner' },
    { name: 'occupied target port', options: {}, scenario: 'target-port-occupied' },
    { name: 'owner changed before stop', options: {}, scenario: 'owner-changed-before-stop' },
    { name: 'unhealthy origin', options: {}, scenario: 'old-unhealthy' },
    { name: 'zero users', options: { activeUsers: 0 }, scenario: 'zero-users' },
    { name: 'two users', options: { activeUsers: 2 }, scenario: 'two-users' },
    { name: 'alternate database path', options: { alternateDatabase: true }, scenario: 'alternate-database' },
    { name: 'static MCP token', options: { staticMcp: true }, scenario: 'static-mcp' },
  ]) {
    const fixture = makeMigrationFixture(fixtureCase.options);
    try {
      const wrapperPath = join(fixture.directory, 'migration-wrapper.ps1');
      writeMigrationWrapper(wrapperPath);
      const originalConfig = readFileSync(fixture.configPath);
      const result = runPowerShell([
        '-File', wrapperPath, migrationScript, fixtureCase.scenario,
        fixture.installDirectory, fixture.backupRoot, fixture.openClawConfigPath, process.execPath,
      ]);
      assert.equal(result.status, 0, `${fixtureCase.name}: ${result.stderr || result.stdout}`);
      assert.equal(result.stdout.trim(), '', fixtureCase.name);
      assert.deepEqual(readFileSync(fixture.configPath), originalConfig, fixtureCase.name);
      assert.equal(existsSync(fixture.backupRoot), false, fixtureCase.name);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /must-never-be-printed|override-must-not-be-printed/u);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

test('production migration never controls a detached or surviving same-command listener', () => {
  for (const scenario of ['task-not-running', 'external-listener-after-stop']) {
    const fixture = makeMigrationFixture();
    try {
      const wrapperPath = join(fixture.directory, 'migration-wrapper.ps1');
      writeMigrationWrapper(wrapperPath);
      const originalConfig = readFileSync(fixture.configPath);
      const result = runPowerShell([
        '-File', wrapperPath, migrationScript, scenario,
        fixture.installDirectory, fixture.backupRoot, fixture.openClawConfigPath, process.execPath,
      ]);
      assert.equal(result.status, 0, `${scenario}: ${result.stderr || result.stdout}`);
      assert.deepEqual(readFileSync(fixture.configPath), originalConfig, scenario);
      assert.equal(result.stdout.includes('stop-process-4100'), false, scenario);
      if (scenario === 'task-not-running') {
        assert.equal(result.stdout.includes('stop-task'), false, scenario);
        assert.equal(existsSync(fixture.backupRoot), false, scenario);
      }
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

test('production migration fails closed on every supported environment override without revealing values', () => {
  for (const variableName of [
    'EBK_CONF_PATH',
    'EBKCFP_CONF_PATH',
    'EBK_SERVER_HTTP_PORT',
    'EBKCFP_SERVER_HTTP_PORT',
    'EBK_SECURITY_TRUSTED_PROXY_IPS',
    'EBK_SECURITY_SECRET_KEY',
    'EBK_UNEXPECTED',
    'EBKCFP_UNEXPECTED',
    'EBKCFP_USER_ENABLE_REGISTER',
  ]) {
    const fixture = makeMigrationFixture();
    try {
      const wrapperPath = join(fixture.directory, 'migration-wrapper.ps1');
      writeMigrationWrapper(wrapperPath);
      const result = runPowerShell([
        '-File', wrapperPath, migrationScript, 'environment-override',
        fixture.installDirectory, fixture.backupRoot, fixture.openClawConfigPath, process.execPath,
        variableName,
      ]);
      assert.equal(result.status, 0, `${variableName}: ${result.stderr || result.stdout}`);
      assert.equal(result.stdout.trim(), '', variableName);
      assert.equal(existsSync(fixture.backupRoot), false, variableName);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /override-must-not-be-printed/u);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }

  const source = `${readFileSync(migrationScript, 'utf8')}\n${readFileSync(join(scriptsDirectory, 'ledger-runtime-common.ps1'), 'utf8')}`;
  for (const scope of ['Process', 'User', 'Machine']) {
    assert.match(source, new RegExp(`EnvironmentVariableTarget\\]::${scope}`));
  }
});

test('production migration rechecks generic overrides after approval and immediately before writing', () => {
  for (const scenario of ['override-after-preflight', 'override-before-write']) {
    const fixture = makeMigrationFixture();
    try {
      const wrapperPath = join(fixture.directory, 'migration-wrapper.ps1');
      writeMigrationWrapper(wrapperPath);
      const originalConfig = readFileSync(fixture.configPath);
      const result = runPowerShell([
        '-File', wrapperPath, migrationScript, scenario,
        fixture.installDirectory, fixture.backupRoot, fixture.openClawConfigPath, process.execPath,
      ]);
      assert.equal(result.status, 0, `${scenario}: ${result.stderr || result.stdout}`);
      assert.deepEqual(readFileSync(fixture.configPath), originalConfig, scenario);
      assert.doesNotMatch(result.stdout, /migrated\s+8888/u, scenario);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /override-must-not-be-printed/u);
      if (scenario === 'override-after-preflight') {
        assert.equal(result.stdout.includes('stop-task'), false);
        assert.equal(existsSync(fixture.backupRoot), false);
      } else {
        assert.match(result.stdout, /stop-task/u);
        assert.match(result.stdout, /start-task/u);
      }
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

test('production migration makes a verified SQLite backup and installs the exact explicit task action', () => {
  const fixture = makeMigrationFixture();
  try {
    const wrapperPath = join(fixture.directory, 'migration-wrapper.ps1');
    writeMigrationWrapper(wrapperPath);
    const result = runPowerShell([
      '-File', wrapperPath, migrationScript, 'success',
      fixture.installDirectory, fixture.backupRoot, fixture.openClawConfigPath, process.execPath,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /stop-task,task-explicit,start-task/u);

    const migrated = readFileSync(fixture.configPath, 'utf8');
    for (const expected of [
      'generator_type = internal',
      'server_id = 0',
      'checker_type = in_memory',
      'oauth2_user_identifier = email',
      'amap_security_verification_method = internal_proxy',
      'data_source = euro_central_bank',
      'http_addr = 127.0.0.1',
      'http_port = 8888',
      'domain = ledger.66ccff-labs.com',
      'root_url = https://ledger.66ccff-labs.com/',
      'mcp_allowed_remote_ips = 127.0.0.1',
      'trusted_proxy_ips = 127.0.0.1/32',
      'token_expired_time = 604800',
      'api_token_allowed_remote_ips = 127.0.0.1',
      'enable_forget_password = false',
      'enable_register = false',
      '; CLAWBOT_LEDGER_PROFILE=production',
      'secret_key = retained-production-secret',
      'enable_mcp = false',
    ]) assert.ok(migrated.includes(expected), expected);

    const backupDirectories = readdirSync(fixture.backupRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    assert.equal(backupDirectories.length, 1);
    const backupDirectory = join(fixture.backupRoot, backupDirectories[0].name);
    assert.equal(existsSync(join(backupDirectory, 'ezbookkeeping.ini')), true);
    const taskDefinitionPath = join(backupDirectory, 'task-definition.xml');
    assert.equal(readFileSync(taskDefinitionPath, 'utf8'), '<Task version="1.4"><Actions /></Task>');
    const backupDatabasePath = join(backupDirectory, 'ezbookkeeping.db');
    const verification = run(process.execPath, [sqliteVerifier, '--database', backupDatabasePath]);
    assert.equal(verification.status, 0, verification.stderr || verification.stdout);
    assert.equal(JSON.parse(verification.stdout).activeUserCount, 1);
    const manifest = JSON.parse(readFileSync(join(backupDirectory, 'backup-manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.activeUserCount, 1);
    assert.deepEqual(manifest.files.map(({ name }) => name).sort(), [
      'ezbookkeeping.db',
      'ezbookkeeping.ini',
      'task-definition.xml',
    ]);
    for (const entry of manifest.files) {
      assert.equal(entry.sha256, sha256(join(backupDirectory, entry.name)), entry.name);
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('production migration rejects a changed INI snapshot before stopping or overwriting it', () => {
  const fixture = makeMigrationFixture();
  try {
    const wrapperPath = join(fixture.directory, 'migration-wrapper.ps1');
    writeMigrationWrapper(wrapperPath);
    const result = runPowerShell([
      '-File', wrapperPath, migrationScript, 'config-changed-before-stop',
      fixture.installDirectory, fixture.backupRoot, fixture.openClawConfigPath, process.execPath,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), '');
    assert.match(readFileSync(fixture.configPath, 'utf8'), /concurrent-setting-must-survive/u);
    assert.equal(existsSync(fixture.backupRoot), false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('production migration rejects a backup-root junction before stopping production', () => {
  const fixture = makeMigrationFixture();
  try {
    const backupTarget = join(fixture.directory, 'backup-junction-target');
    mkdirSync(backupTarget);
    symlinkSync(backupTarget, fixture.backupRoot, 'junction');
    const wrapperPath = join(fixture.directory, 'migration-wrapper.ps1');
    writeMigrationWrapper(wrapperPath);
    const result = runPowerShell([
      '-File', wrapperPath, migrationScript, 'backup-reparse',
      fixture.installDirectory, fixture.backupRoot, fixture.openClawConfigPath, process.execPath,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), '');
    assert.deepEqual(readdirSync(backupTarget), []);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('post-edit migration failure restores the INI, legacy task action, and running state', () => {
  const fixture = makeMigrationFixture();
  try {
    const wrapperPath = join(fixture.directory, 'migration-wrapper.ps1');
    writeMigrationWrapper(wrapperPath);
    const originalConfig = readFileSync(fixture.configPath);
    const result = runPowerShell([
      '-File', wrapperPath, migrationScript, 'post-edit-unhealthy',
      fixture.installDirectory, fixture.backupRoot, fixture.openClawConfigPath, process.execPath,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /task-explicit,start-task,stop-task,task-legacy,start-task/u);
    assert.equal(result.stdout.includes('stop-process-'), false);
    assert.deepEqual(readFileSync(fixture.configPath), originalConfig);
    const leftovers = readdirSync(dirname(fixture.configPath)).filter((name) => name.includes('.ledger-'));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('migration rollback never force-overwrites a task replaced after exact revalidation', () => {
  const fixture = makeMigrationFixture();
  try {
    const wrapperPath = join(fixture.directory, 'migration-wrapper.ps1');
    writeMigrationWrapper(wrapperPath);
    const result = runPowerShell([
      '-File', wrapperPath, migrationScript, 'rollback-task-replaced',
      fixture.installDirectory, fixture.backupRoot, fixture.openClawConfigPath, process.execPath,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.includes('task-legacy'), false, result.stdout);
    assert.equal(result.stdout.includes('start-task,stop-task'), true, result.stdout);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('migration rollback restores the INI and legacy task after the new service exits during startup', () => {
  const fixture = makeMigrationFixture();
  try {
    const wrapperPath = join(fixture.directory, 'migration-wrapper.ps1');
    writeMigrationWrapper(wrapperPath);
    const originalConfig = readFileSync(fixture.configPath);
    const result = runPowerShell([
      '-File', wrapperPath, migrationScript, 'startup-exited',
      fixture.installDirectory, fixture.backupRoot, fixture.openClawConfigPath, process.execPath,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /stop-task,task-explicit,start-task,task-legacy,start-task/u);
    assert.equal(result.stdout.includes('stop-process-'), false);
    assert.deepEqual(readFileSync(fixture.configPath), originalConfig);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

for (const scenario of ['startup-foreign-listener', 'startup-foreign-task', 'startup-detached-listener']) {
  test(`migration rollback rejects ${scenario} without controlling another task or listener`, () => {
    const fixture = makeMigrationFixture();
    try {
      const wrapperPath = join(fixture.directory, 'migration-wrapper.ps1');
      writeMigrationWrapper(wrapperPath);
      const result = runPowerShell([
        '-File', wrapperPath, migrationScript, scenario,
        fixture.installDirectory, fixture.backupRoot, fixture.openClawConfigPath, process.execPath,
      ]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /stop-task,task-explicit,start-task\s*$/u);
      assert.equal(result.stdout.includes('stop-process-'), false);
      assert.equal(result.stdout.includes('task-legacy'), false);
      assert.match(readFileSync(fixture.configPath, 'utf8'), /http_port = 8888/u);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
}

test('migration restores its persisted task definition when task update throws after mutation', () => {
  const fixture = makeMigrationFixture();
  try {
    const wrapperPath = join(fixture.directory, 'migration-wrapper.ps1');
    writeMigrationWrapper(wrapperPath);
    const originalConfig = readFileSync(fixture.configPath);
    const result = runPowerShell([
      '-File', wrapperPath, migrationScript, 'task-update-throws-after-change',
      fixture.installDirectory, fixture.backupRoot, fixture.openClawConfigPath, process.execPath,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /task-explicit,task-legacy,start-task/u);
    assert.deepEqual(readFileSync(fixture.configPath), originalConfig);
    const backupDirectories = readdirSync(fixture.backupRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    assert.equal(backupDirectories.length, 1);
    assert.equal(existsSync(join(fixture.backupRoot, backupDirectories[0].name, 'task-definition.xml')), true);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('test-instance installer is dry-run safe and rejects unknown directories or tasks', () => {
  const whatIfFixture = makeTestInstallFixture();
  try {
    const result = runPowerShell([
      '-File', whatIfFixture.wrapperPath, installTestInstanceScript, 'whatif',
      whatIfFixture.sourceDirectory, whatIfFixture.installDirectory, whatIfFixture.templatePath,
      process.execPath, whatIfFixture.seedScript, whatIfFixture.tokenPath,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(whatIfFixture.installDirectory), false);
    assert.equal(existsSync(whatIfFixture.tokenPath), false);
    assert.doesNotMatch(result.stdout, /register,start,identity,password|register-api|api-token/u);
  } finally {
    rmSync(whatIfFixture.directory, { recursive: true, force: true });
  }

  const conflictFixture = makeTestInstallFixture();
  try {
    const conflict = runPowerShell([
      '-File', conflictFixture.wrapperPath, installTestInstanceScript, 'conflict',
      conflictFixture.sourceDirectory, conflictFixture.installDirectory, conflictFixture.templatePath,
      process.execPath, conflictFixture.seedScript, conflictFixture.tokenPath,
    ]);
    assert.equal(conflict.status, 0, conflict.stderr || conflict.stdout);
    assert.equal(existsSync(conflictFixture.installDirectory), false);
    assert.equal(existsSync(conflictFixture.tokenPath), false);
    assert.equal(conflict.stdout.trim(), '');
  } finally {
    rmSync(conflictFixture.directory, { recursive: true, force: true });
  }

  const nonemptyFixture = makeTestInstallFixture();
  try {
    mkdirSync(nonemptyFixture.installDirectory);
    const unknownPath = join(nonemptyFixture.installDirectory, 'unknown.txt');
    writeFileSync(unknownPath, 'preserve me', 'utf8');
    const nonempty = runPowerShell([
      '-File', nonemptyFixture.wrapperPath, installTestInstanceScript, 'success',
      nonemptyFixture.sourceDirectory, nonemptyFixture.installDirectory, nonemptyFixture.templatePath,
      process.execPath, nonemptyFixture.seedScript, nonemptyFixture.tokenPath,
    ]);
    assert.notEqual(nonempty.status, 0);
    assert.equal(readFileSync(unknownPath, 'utf8'), 'preserve me');
    assert.equal(existsSync(nonemptyFixture.tokenPath), false);
    assert.doesNotMatch(`${nonempty.stdout}\n${nonempty.stderr}`, /production-secret-must-not-copy/u);
  } finally {
    rmSync(nonemptyFixture.directory, { recursive: true, force: true });
  }

  const nestedFixture = makeTestInstallFixture();
  try {
    const nestedInstall = join(nestedFixture.sourceDirectory, 'nested-test-instance');
    const nested = runPowerShell([
      '-File', nestedFixture.wrapperPath, installTestInstanceScript, 'success',
      nestedFixture.sourceDirectory, nestedInstall, nestedFixture.templatePath,
      process.execPath, nestedFixture.seedScript, nestedFixture.tokenPath,
    ]);
    assert.notEqual(nested.status, 0);
    assert.equal(existsSync(nestedInstall), false);
    assert.equal(existsSync(nestedFixture.tokenPath), false);
  } finally {
    rmSync(nestedFixture.directory, { recursive: true, force: true });
  }

  const junctionFixture = makeTestInstallFixture();
  try {
    const junctionTarget = join(junctionFixture.directory, 'empty-junction-target');
    mkdirSync(junctionTarget);
    symlinkSync(junctionTarget, junctionFixture.installDirectory, 'junction');
    const junction = runPowerShell([
      '-File', junctionFixture.wrapperPath, installTestInstanceScript, 'success',
      junctionFixture.sourceDirectory, junctionFixture.installDirectory, junctionFixture.templatePath,
      process.execPath, junctionFixture.seedScript, junctionFixture.tokenPath,
    ]);
    assert.notEqual(junction.status, 0);
    assert.deepEqual(readdirSync(junctionTarget), []);
    assert.equal(existsSync(junctionFixture.tokenPath), false);
  } finally {
    rmSync(junctionFixture.directory, { recursive: true, force: true });
  }

  const missingNodeFixture = makeTestInstallFixture();
  try {
    const result = runPowerShell([
      '-File', missingNodeFixture.wrapperPath, installTestInstanceScript, 'missing-node',
      missingNodeFixture.sourceDirectory, missingNodeFixture.installDirectory, missingNodeFixture.templatePath,
      join(missingNodeFixture.directory, 'missing-node.exe'), missingNodeFixture.seedScript, missingNodeFixture.tokenPath,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), '');
    assert.equal(existsSync(missingNodeFixture.installDirectory), false);
    assert.equal(existsSync(missingNodeFixture.tokenPath), false);
  } finally {
    rmSync(missingNodeFixture.directory, { recursive: true, force: true });
  }

  const overlappingTokenFixture = makeTestInstallFixture();
  try {
    const overlappingTokenPath = join(overlappingTokenFixture.sourceDirectory, 'secrets', 'ezbookkeeping-test-token.txt');
    const result = runPowerShell([
      '-File', overlappingTokenFixture.wrapperPath, installTestInstanceScript, 'overlap-token',
      overlappingTokenFixture.sourceDirectory, overlappingTokenFixture.installDirectory, overlappingTokenFixture.templatePath,
      process.execPath, overlappingTokenFixture.seedScript, overlappingTokenPath,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), '');
    assert.equal(existsSync(overlappingTokenFixture.installDirectory), false);
    assert.equal(existsSync(overlappingTokenPath), false);
  } finally {
    rmSync(overlappingTokenFixture.directory, { recursive: true, force: true });
  }
});

test('test-instance installer allowlist-copies assets, bootstraps locally, and locks registration', () => {
  const fixture = makeTestInstallFixture();
  try {
    const result = runPowerShell([
      '-File', fixture.wrapperPath, installTestInstanceScript, 'success',
      fixture.sourceDirectory, fixture.installDirectory, fixture.templatePath,
      process.execPath, fixture.seedScript, fixture.tokenPath,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /register,start,identity,identity,identity,password,register-api,api-token,stop,start/u);

    const configPath = join(fixture.installDirectory, 'conf', 'ezbookkeeping-test.ini');
    const config = readFileSync(configPath, 'utf8');
    assert.match(config, /^; CLAWBOT_LEDGER_PROFILE=test$/mu);
    assert.match(config, /^generator_type = internal$/mu);
    assert.match(config, /^server_id = 1$/mu);
    assert.match(config, /http_port = 18888/u);
    assert.match(config, /enable_register = false/u);
    assert.match(config, /secret_key = [0-9a-f]{128}/u);
    assert.ok(config.includes(`db_path = ${join(fixture.installDirectory, 'data', 'ezbookkeeping-test.db')}`));
    assert.ok(config.includes(`log_path = ${join(fixture.installDirectory, 'log', 'ezbookkeeping-test.log')}`));
    assert.ok(config.includes(`local_filesystem_path = ${join(fixture.installDirectory, 'storage')}`));
    assert.doesNotMatch(config, /__GENERATE_LOCAL_TEST_SECRET__|production-secret-must-not-copy/u);

    assert.equal(readFileSync(join(fixture.installDirectory, 'ezbookkeeping.exe'), 'utf8'), 'immutable-test-program');
    assert.equal(readFileSync(join(fixture.installDirectory, 'public', 'index.html'), 'utf8'), '<title>ezBookkeeping</title>');
    assert.equal(existsSync(join(fixture.installDirectory, 'data', 'ezbookkeeping.db')), false);
    assert.equal(existsSync(join(fixture.installDirectory, 'log', 'ezbookkeeping.log')), false);
    assert.equal(existsSync(join(fixture.installDirectory, 'conf', 'ezbookkeeping.ini')), false);
    assert.equal(readFileSync(fixture.tokenPath, 'utf8'), 'isolated-test-api-token');
    assert.equal(readFileSync(join(fixture.installDirectory, '.clawbot-ledger-test-instance-ready'), 'utf8'), 'CLAWBOT_LEDGER_TEST_INSTANCE_READY_V1\n');
    assert.equal(existsSync(join(fixture.installDirectory, '.clawbot-ledger-test-instance-installing')), false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('test-instance retry stops the exact running instance before temporarily enabling registration', () => {
  const fixture = makeTestInstallFixture();
  try {
    const configPath = join(fixture.installDirectory, 'conf', 'ezbookkeeping-test.ini');
    const template = readFileSync(fixture.templatePath, 'utf8')
      .replace('__GENERATE_LOCAL_TEST_SECRET__', 'a'.repeat(128))
      .replaceAll('D:\\Clawbot\\ezbookkeeping-test\\data\\ezbookkeeping-test.db', join(fixture.installDirectory, 'data', 'ezbookkeeping-test.db'))
      .replaceAll('D:\\Clawbot\\ezbookkeeping-test\\log\\ezbookkeeping-test.log', join(fixture.installDirectory, 'log', 'ezbookkeeping-test.log'))
      .replaceAll('D:\\Clawbot\\ezbookkeeping-test\\storage', join(fixture.installDirectory, 'storage'));
    mkdirSync(join(fixture.installDirectory, 'conf'), { recursive: true });
    mkdirSync(join(fixture.installDirectory, 'data'));
    mkdirSync(join(fixture.installDirectory, 'log'));
    mkdirSync(join(fixture.installDirectory, 'storage'));
    mkdirSync(join(fixture.installDirectory, 'public'));
    writeFileSync(join(fixture.installDirectory, 'ezbookkeeping.exe'), 'immutable-test-program', 'utf8');
    writeFileSync(configPath, template, 'utf8');
    writeFileSync(
      join(fixture.installDirectory, '.clawbot-ledger-test-instance-installing'),
      `CLAWBOT_LEDGER_TEST_INSTANCE_INSTALLING_V1:${'b'.repeat(32)}\n`,
      'utf8',
    );

    const result = runPowerShell([
      '-File', fixture.wrapperPath, installTestInstanceScript, 'retry-running',
      fixture.sourceDirectory, fixture.installDirectory, fixture.templatePath,
      process.execPath, fixture.seedScript, fixture.tokenPath,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const trace = result.stdout.trim().split(/\r?\n/u).at(-1).split(/\s*,\s*/u);
    assert.ok(trace.indexOf('stop') >= 0, result.stdout);
    assert.ok(trace.indexOf('stop') < trace.indexOf('start'), result.stdout);
    assert.ok(trace.indexOf('stop') < trace.indexOf('register-api'), result.stdout);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('test-instance retry refuses a detached or surviving listener without stopping its process', () => {
  for (const mode of ['retry-detached', 'retry-survives']) {
    const fixture = makeTestInstallFixture();
    try {
      const configPath = join(fixture.installDirectory, 'conf', 'ezbookkeeping-test.ini');
      const template = readFileSync(fixture.templatePath, 'utf8')
        .replace('__GENERATE_LOCAL_TEST_SECRET__', 'a'.repeat(128))
        .replaceAll('D:\\Clawbot\\ezbookkeeping-test\\data\\ezbookkeeping-test.db', join(fixture.installDirectory, 'data', 'ezbookkeeping-test.db'))
        .replaceAll('D:\\Clawbot\\ezbookkeeping-test\\log\\ezbookkeeping-test.log', join(fixture.installDirectory, 'log', 'ezbookkeeping-test.log'))
        .replaceAll('D:\\Clawbot\\ezbookkeeping-test\\storage', join(fixture.installDirectory, 'storage'));
      mkdirSync(join(fixture.installDirectory, 'conf'), { recursive: true });
      for (const name of ['data', 'log', 'storage', 'public']) mkdirSync(join(fixture.installDirectory, name));
      writeFileSync(join(fixture.installDirectory, 'ezbookkeeping.exe'), 'immutable-test-program', 'utf8');
      writeFileSync(configPath, template, 'utf8');
      writeFileSync(
        join(fixture.installDirectory, '.clawbot-ledger-test-instance-installing'),
        `CLAWBOT_LEDGER_TEST_INSTANCE_INSTALLING_V1:${'b'.repeat(32)}\n`,
        'utf8',
      );

      const result = runPowerShell([
        '-File', fixture.wrapperPath, installTestInstanceScript, mode,
        fixture.sourceDirectory, fixture.installDirectory, fixture.templatePath,
        process.execPath, fixture.seedScript, fixture.tokenPath,
      ]);
      assert.equal(result.status, 0, `${mode}: ${result.stderr || result.stdout}`);
      const trace = result.stdout.trim().split(/\r?\n/u).at(-1).split(/\s*,\s*/u);
      assert.equal(trace.includes('stop-process'), false, result.stdout);
      if (mode === 'retry-detached') assert.equal(trace.includes('stop'), false, result.stdout);
      assert.equal(readFileSync(configPath, 'utf8'), template, mode);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

test('test-instance ready marker never masks an unhealthy runtime or missing database', () => {
  for (const mode of ['ready-stopped', 'ready-detached', 'ready-unhealthy', 'ready-missing-database']) {
    const fixture = makeTestInstallFixture();
    try {
      const bootstrap = runPowerShell([
        '-File', fixture.wrapperPath, installTestInstanceScript, 'success',
        fixture.sourceDirectory, fixture.installDirectory, fixture.templatePath,
        process.execPath, fixture.seedScript, fixture.tokenPath,
      ]);
      assert.equal(bootstrap.status, 0, bootstrap.stderr || bootstrap.stdout);
      if (mode === 'ready-missing-database') {
        rmSync(join(fixture.installDirectory, 'data', 'ezbookkeeping-test.db'));
      }

      const result = runPowerShell([
        '-File', fixture.wrapperPath, installTestInstanceScript, mode,
        fixture.sourceDirectory, fixture.installDirectory, fixture.templatePath,
        process.execPath, fixture.seedScript, fixture.tokenPath,
      ]);
      assert.equal(result.status, 0, `${mode}: ${result.stderr || result.stdout}`);
      assert.equal(result.stdout.includes('already_ready'), false, result.stdout);
      assert.equal(result.stdout.includes('stop-process'), false, result.stdout);
      assert.equal(result.stdout.includes('stop'), false, result.stdout);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

test('test-instance ready marker remains idempotent for the exact healthy instance', () => {
  const fixture = makeTestInstallFixture();
  try {
    const bootstrap = runPowerShell([
      '-File', fixture.wrapperPath, installTestInstanceScript, 'success',
      fixture.sourceDirectory, fixture.installDirectory, fixture.templatePath,
      process.execPath, fixture.seedScript, fixture.tokenPath,
    ]);
    assert.equal(bootstrap.status, 0, bootstrap.stderr || bootstrap.stdout);

    const result = runPowerShell([
      '-File', fixture.wrapperPath, installTestInstanceScript, 'ready-healthy',
      fixture.sourceDirectory, fixture.installDirectory, fixture.templatePath,
      process.execPath, fixture.seedScript, fixture.tokenPath,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /already_ready/u);
    assert.equal(result.stdout.includes('stop'), false, result.stdout);
    assert.equal(result.stdout.includes('start'), false, result.stdout);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('PowerShell 5.1 resolves script-relative helper defaults after parameter binding', () => {
  const fixture = makeTestInstallFixture();
  try {
    const result = runPowerShell([
      '-File', fixture.wrapperPath, installTestInstanceScript, 'default-paths',
      fixture.sourceDirectory, fixture.installDirectory, fixture.templatePath,
      process.execPath, fixture.seedScript, fixture.tokenPath,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(join(fixture.installDirectory, '.clawbot-ledger-test-instance-ready')), true);
    assert.equal(readFileSync(fixture.tokenPath, 'utf8'), 'isolated-test-api-token');

    for (const scriptPath of [
      installTestInstanceScript,
      migrationScript,
      initializeTestLedgerScript,
    ]) {
      const source = readFileSync(scriptPath, 'utf8');
      const parameterBlock = source.slice(source.indexOf('param('), source.indexOf('\n)') + 2);
      assert.doesNotMatch(parameterBlock, /Join-Path\s+\$PSScriptRoot/u, scriptPath);
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('test-instance bootstrap failure disables registration, stops only its task, and creates no ready state', () => {
  for (const mode of ['registration-fail', 'lockdown-fail']) {
    const fixture = makeTestInstallFixture();
    try {
      const result = runPowerShell([
        '-File', fixture.wrapperPath, installTestInstanceScript, mode,
        fixture.sourceDirectory, fixture.installDirectory, fixture.templatePath,
        process.execPath, fixture.seedScript, fixture.tokenPath,
      ]);
      assert.equal(result.status, 0, `${mode}: ${result.stderr || result.stdout}`);
      assert.match(result.stdout, /stop/u, mode);
      const config = readFileSync(join(fixture.installDirectory, 'conf', 'ezbookkeeping-test.ini'), 'utf8');
      assert.match(config, /enable_register = false/u, mode);
      assert.equal(existsSync(join(fixture.installDirectory, '.clawbot-ledger-test-instance-ready')), false, mode);
      assert.equal(existsSync(fixture.tokenPath), false, mode);
      assert.equal(existsSync(join(fixture.installDirectory, '.clawbot-ledger-test-instance-installing')), true, mode);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /temporary-password|temporary-session-token|isolated-test-api-token/u);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }

  const source = readFileSync(installTestInstanceScript, 'utf8');
  assert.match(source, /Read-Host[^\r\n]*-AsSecureString/u);
  assert.doesNotMatch(source, /--password|\[string\]\$Password/u);
  assert.doesNotMatch(source, /Register-ScheduledTask[^\r\n]*-Force/u);
  assert.doesNotMatch(source, /Copy-Item[^\r\n]*\$SourceInstallDirectory[^\r\n]*-Recurse/u);
  assert.match(source, /MaximumRedirection(?:\s*=|\s+)\s*0/u);
});

test('test-instance installer refuses task or process control after listener ownership changes', () => {
  const fixture = makeTestInstallFixture();
  try {
    const result = runPowerShell([
      '-File', fixture.wrapperPath, installTestInstanceScript, 'owner-changed-before-lockdown',
      fixture.sourceDirectory, fixture.installDirectory, fixture.templatePath,
      process.execPath, fixture.seedScript, fixture.tokenPath,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const trace = result.stdout.trim().split(/\r?\n/u).at(-1).split(/\s*,\s*/u);
    assert.equal(trace.includes('stop'), false, result.stdout);
    assert.equal(existsSync(join(fixture.installDirectory, '.clawbot-ledger-test-instance-ready')), false);
    assert.equal(existsSync(fixture.tokenPath), false);
    assert.match(readFileSync(join(fixture.installDirectory, 'conf', 'ezbookkeeping-test.ini'), 'utf8'), /enable_register = false/u);
    assert.ok(trace.includes('rollback-incomplete'), result.stdout);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('test-instance installer reports incomplete rollback when its newly registered task becomes unrecognizable', () => {
  const fixture = makeTestInstallFixture();
  try {
    const result = runPowerShell([
      '-File', fixture.wrapperPath, installTestInstanceScript, 'registered-task-became-unverifiable',
      fixture.sourceDirectory, fixture.installDirectory, fixture.templatePath,
      process.execPath, fixture.seedScript, fixture.tokenPath,
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const trace = result.stdout.trim().split(/\r?\n/u).at(-1).split(/\s*,\s*/u);
    assert.ok(trace.includes('register'), result.stdout);
    assert.ok(trace.includes('rollback-incomplete'), result.stdout);
    assert.equal(trace.includes('stop'), false, result.stdout);
    assert.equal(existsSync(join(fixture.installDirectory, '.clawbot-ledger-test-instance-ready')), false);
    assert.equal(existsSync(fixture.tokenPath), false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
