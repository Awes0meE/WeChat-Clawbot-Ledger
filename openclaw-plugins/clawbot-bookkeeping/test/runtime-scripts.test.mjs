import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { after } from 'node:test';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const scriptsDirectory = join(projectDirectory, 'scripts');
const commonScript = join(scriptsDirectory, 'ledger-runtime-common.ps1');

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

const isolatedRoot = mkdtempSync(join(tmpdir(), 'clawbot-runtime-isolated-'));
const isolatedScriptsDirectory = join(isolatedRoot, 'scripts');
mkdirSync(isolatedScriptsDirectory, { recursive: true });
writeEnvironmentIsolatedCommon(commonScript, join(isolatedScriptsDirectory, 'ledger-runtime-common.ps1'));
for (const scriptName of ['configure-ezbookkeeping-mcp.ps1', 'install-ezbookkeeping-task.ps1']) {
  writeFileSync(
    join(isolatedScriptsDirectory, scriptName),
    readFileSync(join(scriptsDirectory, scriptName), 'utf8'),
    'utf8',
  );
}
const configureScript = join(isolatedScriptsDirectory, 'configure-ezbookkeeping-mcp.ps1');
const installScript = join(isolatedScriptsDirectory, 'install-ezbookkeeping-task.ps1');
after(() => rmSync(isolatedRoot, { recursive: true, force: true }));

function runPowerShellResult(arguments_) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...arguments_],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function runPowerShell(arguments_) {
  return runPowerShellResult(arguments_).stdout;
}

test('owner-only file verification rejects a foreign ACL owner', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clawbot-runtime-acl-owner-'));
  try {
    const wrapperPath = join(temporaryDirectory, 'owner-check.ps1');
    const fixturePath = join(temporaryDirectory, 'protected.txt');
    writeFileSync(fixturePath, 'fixture', 'utf8');
    writeFileSync(wrapperPath, `
. $args[0]
function Get-Acl {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  [pscustomobject]@{
    Owner = 'BUILTIN\\Administrators'
    AreAccessRulesProtected = $true
    Access = @([pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = $identity }; AccessControlType = 'Allow'; FileSystemRights = 'FullControl' })
  }
}
try {
  Assert-LedgerOwnerOnlyFile -Path $args[1]
  throw 'Expected foreign owner rejection.'
} catch {
  if ($_.Exception.Message -eq 'Expected foreign owner rejection.') { throw }
  if ($_.Exception.Message -notmatch 'unsafe access control') { throw }
}
`, 'utf8');
    runPowerShell(['-File', wrapperPath, commonScript, fixturePath]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('runtime setup scripts parse and WhatIf leaves a UTF-8 INI untouched', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clawbot-runtime-scripts-'));
  try {
    const configPath = join(temporaryDirectory, 'ezbookkeeping.ini');
    const apiTokenPath = join(temporaryDirectory, 'api-token.txt');
    const mcpTokenPath = join(temporaryDirectory, 'secrets', 'mcp-token.txt');
    const originalIni = '[mcp]\r\nenable_mcp = false\r\nmcp_allowed_remote_ips = 10.0.0.1\r\n';
    writeFileSync(configPath, originalIni, 'utf8');
    writeFileSync(apiTokenPath, 'api-token-that-must-not-appear', 'utf8');

    for (const scriptPath of [configureScript, installScript]) {
      const quotedPath = scriptPath.replace(/'/g, "''");
      const output = runPowerShell([
        '-Command',
        "$tokens = $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('" + quotedPath + "', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }",
      ]);
      assert.equal(output.trim(), '');
    }

    const result = runPowerShellResult([
      '-File',
      configureScript,
      '-WhatIf',
      '-ConfigPath',
      configPath,
      '-ApiTokenPath',
      apiTokenPath,
      '-McpTokenPath',
      mcpTokenPath,
    ]);
    const output = result.stdout;
    assert.equal(readFileSync(configPath, 'utf8'), originalIni);
    assert.equal(output.includes('api-token-that-must-not-appear'), false);
    assert.equal(output.includes('mcp-token'), false);
    assert.equal(result.stderr.includes('ezBookkeeping password'), false);
    assert.equal(output.includes('ezBookkeeping password'), false);
    assert.equal(readFileSync(configPath).equals(Buffer.from(originalIni, 'utf8')), true);
    assert.throws(() => readFileSync(mcpTokenPath));
    assert.deepEqual(readdirSync(temporaryDirectory).sort(), ['api-token.txt', 'ezbookkeeping.ini']);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('runtime setup scripts keep non-mutating approval guards before secrets or registration', () => {
  const configureSource = readFileSync(configureScript, 'utf8');
  const installSource = readFileSync(installScript, 'utf8');

  for (const source of [configureSource, installSource]) {
    assert.match(source, /CmdletBinding\s*\(\s*SupportsShouldProcess/);
  }
  assert.equal([...configureSource.matchAll(/\$PSCmdlet\.ShouldProcess\(/g)].length, 1);
  const guardStart = configureSource.indexOf('if (-not $PSCmdlet.ShouldProcess(');
  const guardEnd = configureSource.indexOf('}', guardStart) + 1;
  assert.ok(guardStart >= 0);
  assert.match(configureSource.slice(guardStart, guardEnd), /return/);
  for (const prohibitedOperation of [
    'Copy-LedgerFileBytesIntoExistingFile',
    'Write-ConfigAtomically',
    'Get-LedgerExpectedTask',
    'Stop-ScheduledTask',
    'Start-ScheduledTask',
    'Get-LedgerListenerOwner',
    'Wait-LedgerListenerExit',
    'Invoke-RestMethod',
    'Read-Host',
    '[IO.File]::ReadAllText($ApiTokenPath',
    'Set-OwnerOnlyTokenFile',
    'Protect-LedgerOwnerOnlyFile',
  ]) {
    assert.equal(configureSource.slice(guardStart, guardEnd).includes(prohibitedOperation), false);
    assert.ok(configureSource.indexOf(prohibitedOperation, guardEnd) > guardEnd, prohibitedOperation);
  }
  assert.ok(installSource.indexOf('$PSCmdlet.ShouldProcess(') < installSource.indexOf('Register-ScheduledTask'));
});

test('configure script rejects a root task with a non-matching action before task controls', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clawbot-runtime-task-shim-'));
  try {
    const configPath = join(temporaryDirectory, 'ezbookkeeping.ini');
    const executablePath = join(temporaryDirectory, 'ezbookkeeping.exe');
    const wrapperPath = join(temporaryDirectory, 'run-configure-shim.ps1');
    const originalIni = '[mcp]\nenable_mcp = false\nmcp_allowed_remote_ips = 10.0.0.1\n';
    writeFileSync(configPath, originalIni, 'utf8');
    writeFileSync(executablePath, '', 'utf8');
    writeFileSync(wrapperPath, `
$global:unexpectedTaskControl = $false
$global:expectedExecutable = $args[4]
$global:installDirectory = $args[5]
$global:expectedTaskName = 'Clawbot test task'
function Get-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName)
  [pscustomobject]@{
    TaskName = $global:expectedTaskName
    TaskPath = '\\'
    Actions = @([pscustomobject]@{ Execute = 'C:\\Other\\wrong.exe'; Arguments = '--conf-path "C:\\Other\\wrong.ini" server run'; WorkingDirectory = 'C:\\Other' })
  }
}
function Stop-ScheduledTask { [CmdletBinding()] param([object]$InputObject, [string]$TaskName) $global:unexpectedTaskControl = $true; throw 'Unexpected task stop.' }
function Start-ScheduledTask { [CmdletBinding()] param([object]$InputObject, [string]$TaskName) $global:unexpectedTaskControl = $true; throw 'Unexpected task start.' }
function Get-CimInstance { [CmdletBinding()] param() $global:unexpectedTaskControl = $true }
function Stop-Process { [CmdletBinding()] param() $global:unexpectedTaskControl = $true }
try {
  & $args[0] -ConfigPath $args[1] -InstallDirectory $args[5] -ApiTokenPath $args[2] -McpTokenPath $args[3] -BackupRoot (Join-Path $args[5] 'backups') -TaskName 'Clawbot test task' -Confirm:$false
  throw 'Expected the mismatched task action to be rejected.'
} catch {
  if ($_.Exception.Message -ne 'Could not complete local ezBookkeeping MCP setup. Check the configuration, task, and service health, then retry.') { throw }
}
if ($global:unexpectedTaskControl) { throw 'Task controls were reached for a mismatched action.' }
`, 'utf8');

    runPowerShell([
      '-File', wrapperPath, configureScript, configPath, join(temporaryDirectory, 'api.txt'), join(temporaryDirectory, 'mcp.txt'), executablePath, temporaryDirectory,
    ]);
    assert.equal(readFileSync(configPath, 'utf8'), originalIni);
    assert.deepEqual(readdirSync(temporaryDirectory).sort(), ['ezbookkeeping.exe', 'ezbookkeeping.ini', 'run-configure-shim.ps1']);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('configure rejects MCP token paths aliased to protected production files before task control', () => {
  for (const targetName of ['config', 'database', 'openclaw', 'api-token', 'backup']) {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clawbot-runtime-token-alias-'));
    try {
      const installDirectory = join(temporaryDirectory, 'ezbookkeeping');
      const configDirectory = join(installDirectory, 'conf');
      const dataDirectory = join(installDirectory, 'data');
      const secretsDirectory = join(temporaryDirectory, 'secrets');
      const backupRoot = join(temporaryDirectory, 'backups');
      const configPath = join(configDirectory, 'ezbookkeeping.ini');
      const databasePath = join(dataDirectory, 'ezbookkeeping.db');
      const openClawConfigPath = join(temporaryDirectory, 'openclaw.json');
      const apiTokenPath = join(secretsDirectory, 'ezbookkeeping-token.txt');
      const backupPath = join(backupRoot, 'snapshot', 'ezbookkeeping.ini');
      const mcpTokenPath = targetName === 'config' ? configPath : join(secretsDirectory, `mcp-${targetName}.txt`);
      const executablePath = join(installDirectory, 'ezbookkeeping.exe');
      const wrapperPath = join(temporaryDirectory, 'run-token-alias-shim.ps1');
      mkdirSync(configDirectory, { recursive: true });
      mkdirSync(dataDirectory, { recursive: true });
      mkdirSync(secretsDirectory, { recursive: true });
      mkdirSync(dirname(backupPath), { recursive: true });
      const originalIni = '[mcp]\nenable_mcp = false\nmcp_allowed_remote_ips = 10.0.0.1\n[database]\ntype = sqlite3\ndb_path = data/ezbookkeeping.db\n';
      writeFileSync(configPath, originalIni, 'utf8');
      writeFileSync(databasePath, 'database-sentinel', 'utf8');
      writeFileSync(openClawConfigPath, '{"sentinel":true}\n', 'utf8');
      writeFileSync(apiTokenPath, 'api-token-sentinel', 'utf8');
      writeFileSync(backupPath, 'backup-sentinel', 'utf8');
      writeFileSync(executablePath, '', 'utf8');
      const protectedTargets = {
        database: databasePath,
        openclaw: openClawConfigPath,
        'api-token': apiTokenPath,
        backup: backupPath,
      };
      if (targetName !== 'config') linkSync(protectedTargets[targetName], mcpTokenPath);
      writeFileSync(wrapperPath, `
$global:taskControlReached = $false
function Get-ScheduledTask { [CmdletBinding()] param() $global:taskControlReached = $true; throw 'Task lookup must not run for a protected token alias.' }
try {
  & $args[0] -ConfigPath $args[1] -InstallDirectory $args[2] -ApiTokenPath $args[3] -McpTokenPath $args[4] -OpenClawConfigPath $args[5] -BackupRoot $args[6] -TaskName 'Clawbot alias fixture' -Confirm:$false
  throw 'Expected a protected token alias rejection.'
} catch {
  if ($_.Exception.Message -notmatch 'token.*(?:alias|conflict|same file)|protected.*file|Could not complete') { throw }
}
if ($global:taskControlReached) { throw 'Task control was reached for a protected token alias.' }
`, 'utf8');

      runPowerShell([
        '-File', wrapperPath, configureScript, configPath, installDirectory, apiTokenPath,
        mcpTokenPath, openClawConfigPath, backupRoot,
      ]);
      assert.equal(readFileSync(configPath, 'utf8'), originalIni);
      assert.equal(readFileSync(databasePath, 'utf8'), 'database-sentinel');
      assert.equal(readFileSync(openClawConfigPath, 'utf8'), '{"sentinel":true}\n');
      assert.equal(readFileSync(apiTokenPath, 'utf8'), 'api-token-sentinel');
      assert.equal(readFileSync(backupPath, 'utf8'), 'backup-sentinel');
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
});

test('configure rejects an ezBookkeeping environment override before task control without disclosing it', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clawbot-runtime-mcp-override-'));
  try {
    const installDirectory = join(temporaryDirectory, 'ezbookkeeping');
    const configDirectory = join(installDirectory, 'conf');
    const configPath = join(configDirectory, 'ezbookkeeping.ini');
    const executablePath = join(installDirectory, 'ezbookkeeping.exe');
    const wrapperPath = join(temporaryDirectory, 'run-override-shim.ps1');
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(configPath, '[mcp]\nenable_mcp = false\nmcp_allowed_remote_ips = 10.0.0.1\n', 'utf8');
    writeFileSync(executablePath, '', 'utf8');
    writeFileSync(wrapperPath, `
$global:taskControlReached = $false
$global:LedgerTestEnvironmentOverrides = @{ Process = @{ 'EBK_MCP_MCP_ALLOWED_REMOTE_IPS' = 'override-secret-must-not-appear' } }
function Get-ScheduledTask { [CmdletBinding()] param() $global:taskControlReached = $true; throw 'Task lookup must not run with an environment override.' }
try {
  & $args[0] -ConfigPath $args[1] -InstallDirectory $args[2] -ApiTokenPath $args[3] -McpTokenPath $args[4] -BackupRoot (Join-Path $args[2] 'backups') -TaskName 'Clawbot override fixture' -Confirm:$false
  throw 'Expected environment override rejection.'
} catch {
  if ($_.Exception.Message -notmatch 'environment override|Could not complete') { throw }
} finally {
  Remove-Variable -Name LedgerTestEnvironmentOverrides -Scope Global -ErrorAction SilentlyContinue
}
if ($global:taskControlReached) { throw 'Task control was reached with an environment override.' }
`, 'utf8');
    const result = runPowerShellResult([
      '-File', wrapperPath, configureScript, configPath, installDirectory,
      join(temporaryDirectory, 'api.txt'), join(temporaryDirectory, 'mcp.txt'),
    ]);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /override-secret-must-not-appear/u);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('configure rejects a concurrent INI change before writing or stopping the task', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clawbot-runtime-config-race-'));
  try {
    const installDirectory = join(temporaryDirectory, 'ezbookkeeping');
    const configDirectory = join(installDirectory, 'conf');
    const configPath = join(configDirectory, 'ezbookkeeping.ini');
    const executablePath = join(installDirectory, 'ezbookkeeping.exe');
    const wrapperPath = join(temporaryDirectory, 'run-config-race-shim.ps1');
    const originalIni = '[mcp]\nenable_mcp = false\nmcp_allowed_remote_ips = 10.0.0.1\n';
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(configPath, originalIni, 'utf8');
    writeFileSync(executablePath, '', 'utf8');
    writeFileSync(wrapperPath, `
$global:configPath = $args[1]
$global:installDirectory = $args[2]
$global:executable = Join-Path $global:installDirectory 'ezbookkeeping.exe'
$global:arguments = '--conf-path "' + $global:configPath + '" server run'
$global:changed = $false
$global:taskControlReached = $false
$global:task = [pscustomobject]@{ TaskName = 'Clawbot race fixture'; TaskPath = '\\'; State = 'Running'; Actions = @([pscustomobject]@{ Execute = $global:executable; Arguments = $global:arguments; WorkingDirectory = $global:installDirectory }) }
function Get-ScheduledTask {
  [CmdletBinding()] param()
  if (-not $global:changed) {
    [IO.File]::AppendAllText($global:configPath, '; concurrent-setting-must-survive' + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    $global:changed = $true
  }
  $global:task
}
function Get-NetTCPConnection { [CmdletBinding()] param([string]$State, [int]$LocalPort) [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8888; OwningProcess = 5151 } }
function Get-CimInstance { [CmdletBinding()] param([string]$ClassName, [string]$Filter) [pscustomobject]@{ ProcessId = 5151; CreationDate = 'race'; ExecutablePath = $global:executable; CommandLine = ('"' + $global:executable + '" ' + $global:arguments) } }
function Invoke-RestMethod { [CmdletBinding()] param([string]$Uri, [int]$MaximumRedirection, [int]$TimeoutSec) [pscustomobject]@{ success = $true } }
function Invoke-WebRequest { [CmdletBinding()] param([string]$Uri, [switch]$UseBasicParsing, [int]$MaximumRedirection, [int]$TimeoutSec) [pscustomobject]@{ Content = '<title>ezBookkeeping</title>' } }
function Stop-ScheduledTask { $global:taskControlReached = $true; throw 'Task stop must not run after a concurrent INI change.' }
function Start-ScheduledTask { $global:taskControlReached = $true; throw 'Task start must not run after a concurrent INI change.' }
function Set-Acl { [CmdletBinding()] param([string]$LiteralPath, [object]$AclObject) }
function Get-Acl {
  [CmdletBinding()] param([string]$LiteralPath)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  [pscustomobject]@{ Owner = $identity; AreAccessRulesProtected = $true; Access = @([pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = $identity }; AccessControlType = 'Allow'; FileSystemRights = 'FullControl' }) }
}
try {
  & $args[0] -ConfigPath $args[1] -InstallDirectory $args[2] -ApiTokenPath $args[3] -McpTokenPath $args[4] -BackupRoot (Join-Path $args[2] 'backups') -TaskName 'Clawbot race fixture' -Confirm:$false
  throw 'Expected concurrent INI rejection.'
} catch {
  if ($_.Exception.Message -notmatch 'Could not complete|configuration changed') { throw }
}
if ($global:taskControlReached) { throw 'Task control was reached after a concurrent INI change.' }
`, 'utf8');
    runPowerShell([
      '-File', wrapperPath, configureScript, configPath, installDirectory,
      join(temporaryDirectory, 'api.txt'), join(temporaryDirectory, 'mcp.txt'),
    ]);
    assert.equal(readFileSync(configPath, 'utf8'), `${originalIni}; concurrent-setting-must-survive\r\n`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('configure refuses a matching listener when the exact task is not running', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clawbot-runtime-detached-listener-'));
  try {
    const installDirectory = join(temporaryDirectory, 'ezbookkeeping');
    const configDirectory = join(installDirectory, 'conf');
    const configPath = join(configDirectory, 'ezbookkeeping.ini');
    const executablePath = join(installDirectory, 'ezbookkeeping.exe');
    const wrapperPath = join(temporaryDirectory, 'run-detached-listener-shim.ps1');
    const originalIni = '[mcp]\nenable_mcp = false\nmcp_allowed_remote_ips = 10.0.0.1\n';
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(configPath, originalIni, 'utf8');
    writeFileSync(executablePath, '', 'utf8');
    writeFileSync(wrapperPath, `
$global:configPath = $args[1]
$global:installDirectory = $args[2]
$global:executable = Join-Path $global:installDirectory 'ezbookkeeping.exe'
$global:arguments = '--conf-path "' + $global:configPath + '" server run'
$global:taskControlReached = $false
$global:task = [pscustomobject]@{ TaskName = 'Clawbot detached fixture'; TaskPath = '\\'; State = 'Ready'; Actions = @([pscustomobject]@{ Execute = $global:executable; Arguments = $global:arguments; WorkingDirectory = $global:installDirectory }) }
function Get-ScheduledTask { [CmdletBinding()] param() $global:task }
function Get-NetTCPConnection { [CmdletBinding()] param([string]$State, [int]$LocalPort) [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8888; OwningProcess = 5252 } }
function Get-CimInstance { [CmdletBinding()] param([string]$ClassName, [string]$Filter) [pscustomobject]@{ ProcessId = 5252; CreationDate = 'detached'; ExecutablePath = $global:executable; CommandLine = ('"' + $global:executable + '" ' + $global:arguments) } }
function Stop-ScheduledTask { [CmdletBinding()] param([object]$InputObject) $global:taskControlReached = $true; throw 'Detached task must not be stopped.' }
function Start-ScheduledTask { [CmdletBinding()] param([object]$InputObject) $global:taskControlReached = $true; throw 'Detached task must not be started.' }
function Stop-Process { [CmdletBinding()] param([int]$Id, [switch]$Force) $global:taskControlReached = $true; throw 'Detached listener must not be stopped.' }
try {
  & $args[0] -ConfigPath $args[1] -InstallDirectory $args[2] -ApiTokenPath $args[3] -McpTokenPath $args[4] -BackupRoot (Join-Path $args[2] 'backups') -TaskName 'Clawbot detached fixture' -Confirm:$false
  throw 'Expected detached listener rejection.'
} catch {
  if ($_.Exception.Message -notmatch 'Could not complete|not running|detached') { throw }
}
if ($global:taskControlReached) { throw 'Task or process control was reached for a detached listener.' }
`, 'utf8');
    runPowerShell([
      '-File', wrapperPath, configureScript, configPath, installDirectory,
      join(temporaryDirectory, 'api.txt'), join(temporaryDirectory, 'mcp.txt'),
    ]);
    assert.equal(readFileSync(configPath, 'utf8'), originalIni);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('installer WhatIf reaches neither scheduled-task construction nor registration', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clawbot-runtime-install-shim-'));
  try {
    const executablePath = join(temporaryDirectory, 'ezbookkeeping.exe');
    const configDirectory = join(temporaryDirectory, 'conf');
    const configPath = join(configDirectory, 'ezbookkeeping.ini');
    const wrapperPath = join(temporaryDirectory, 'run-install-shim.ps1');
    mkdirSync(configDirectory);
    writeFileSync(executablePath, '', 'utf8');
    writeFileSync(configPath, '[server]\nhttp_port = 8888\n', 'utf8');
    writeFileSync(wrapperPath, `
$script:registered = $false
function Get-ScheduledTask { [CmdletBinding()] param() @() }
function New-ScheduledTaskAction { throw 'WhatIf unexpectedly constructed a task action.' }
function New-ScheduledTaskTrigger { throw 'WhatIf unexpectedly constructed a task trigger.' }
function New-ScheduledTaskSettingsSet { throw 'WhatIf unexpectedly constructed task settings.' }
function New-ScheduledTaskPrincipal { throw 'WhatIf unexpectedly constructed a task principal.' }
function Register-ScheduledTask { $script:registered = $true; throw 'WhatIf unexpectedly registered a task.' }
& $args[0] -InstallDirectory $args[1] -TaskName 'Clawbot test WhatIf' -WhatIf
if ($script:registered) { throw 'WhatIf registered a task.' }
`, 'utf8');
    const result = runPowerShellResult(['-File', wrapperPath, installScript, temporaryDirectory]);
    assert.equal(result.stderr.trim(), '');
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('installer registers only the exact explicit-config ezBookkeeping action without Force', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clawbot-runtime-hidden-install-'));
  try {
    const executablePath = join(temporaryDirectory, 'ezbookkeeping.exe');
    const configDirectory = join(temporaryDirectory, 'conf');
    const configPath = join(configDirectory, 'ezbookkeeping.ini');
    const wrapperPath = join(temporaryDirectory, 'run-hidden-install-shim.ps1');
    const expectedArguments = `--conf-path "${configPath}" server run`;
    mkdirSync(configDirectory);
    writeFileSync(executablePath, '', 'utf8');
    writeFileSync(configPath, '[server]\nhttp_port = 8888\n', 'utf8');
    writeFileSync(wrapperPath, `
$global:registered = $false
$global:expectedDirectory = $args[1]
$global:expectedExecutable = $args[2]
$global:expectedArguments = $args[3]
function Get-ScheduledTask { [CmdletBinding()] param() @() }
function New-ScheduledTaskAction { [CmdletBinding()] param([string]$Execute, [string]$Argument, [string]$WorkingDirectory) [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory } }
function New-ScheduledTaskTrigger { [CmdletBinding()] param([switch]$AtLogOn, [string]$User) [pscustomobject]@{} }
function New-ScheduledTaskSettingsSet { [CmdletBinding()] param([int]$RestartCount, [TimeSpan]$RestartInterval, [TimeSpan]$ExecutionTimeLimit, [string]$MultipleInstances, [switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries) [pscustomobject]@{} }
function New-ScheduledTaskPrincipal { [CmdletBinding()] param([string]$UserId, [string]$LogonType, [string]$RunLevel) [pscustomobject]@{} }
function Register-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName, [object]$Action, [object]$Trigger, [object]$Settings, [object]$Principal, [string]$Description, [switch]$Force)
  if ($Force) { throw 'Installer used Force.' }
  if ($Action.Execute -cne $global:expectedExecutable -or $Action.Arguments -cne $global:expectedArguments -or $Action.WorkingDirectory -cne $global:expectedDirectory) { throw 'Scheduled action was not the exact explicit-config service.' }
  $global:registered = $true
}
& $args[0] -InstallDirectory $args[1] -TaskName 'Clawbot explicit task' -Confirm:$false
if (-not $global:registered) { throw 'Expected shimmed task registration.' }
`, 'utf8');

    runPowerShell(['-File', wrapperPath, installScript, temporaryDirectory, executablePath, expectedArguments]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('installer accepts an exact existing task and rejects a mismatched task without replacement', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clawbot-runtime-existing-install-'));
  try {
    const executablePath = join(temporaryDirectory, 'ezbookkeeping.exe');
    const configDirectory = join(temporaryDirectory, 'conf');
    const configPath = join(configDirectory, 'ezbookkeeping.ini');
    const wrapperPath = join(temporaryDirectory, 'run-existing-install-shim.ps1');
    mkdirSync(configDirectory);
    writeFileSync(executablePath, '', 'utf8');
    writeFileSync(configPath, '[server]\nhttp_port = 8888\n', 'utf8');
    writeFileSync(wrapperPath, `
$global:mode = $args[2]
$global:registered = $false
$global:expectedDirectory = $args[1]
$global:expectedExecutable = Join-Path $global:expectedDirectory 'ezbookkeeping.exe'
$global:expectedConfig = Join-Path $global:expectedDirectory 'conf\\ezbookkeeping.ini'
$global:arguments = '--conf-path "' + $global:expectedConfig + '" server run'
function Get-ScheduledTask {
  [CmdletBinding()] param()
  $execute = if ($global:mode -eq 'exact') { $global:expectedExecutable } else { 'C:\\Other\\unknown.exe' }
  [pscustomobject]@{ TaskName = 'Clawbot existing task'; TaskPath = '\\'; Actions = @([pscustomobject]@{ Execute = $execute; Arguments = $global:arguments; WorkingDirectory = $global:expectedDirectory }) }
}
function Register-ScheduledTask { $global:registered = $true; throw 'Existing task was replaced.' }
function New-ScheduledTaskAction { throw 'Existing task caused task construction.' }
try {
  & $args[0] -InstallDirectory $args[1] -TaskName 'Clawbot existing task' -Confirm:$false
  if ($global:mode -ne 'exact') { throw 'Expected mismatched task rejection.' }
} catch {
  if ($global:mode -eq 'exact' -or $_.Exception.Message -notmatch 'does not match') { throw }
}
if ($global:registered) { throw 'Existing task was registered over.' }
`, 'utf8');

    for (const mode of ['exact', 'mismatch']) {
      runPowerShell(['-File', wrapperPath, installScript, temporaryDirectory, mode]);
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('configure source uses atomic backups, strict task actions, and normalized tokens', () => {
  const configureSource = readFileSync(configureScript, 'utf8');
  const installSource = readFileSync(installScript, 'utf8');
  const commonSource = readFileSync(join(scriptsDirectory, 'ledger-runtime-common.ps1'), 'utf8');
  assert.doesNotMatch(configureSource, /Copy-Item\s+-LiteralPath\s+\$ConfigPath/);
  assert.match(configureSource, /Copy-LedgerFileBytesIntoExistingFile -SourcePath \$ConfigPath -DestinationPath \$backupPath/);
  assert.match(configureSource, /Get-LedgerFileSha256 -Path \$ConfigPath/);
  assert.match(configureSource, /Get-LedgerFileSha256 -Path \$backupPath/);
  assert.match(configureSource, /Assert-LedgerExternalSecretPath -Path \$ConfigPath/);
  assert.match(configureSource, /Assert-LedgerExternalSecretPath -Path \$ApiTokenPath/);
  assert.match(configureSource, /Assert-LedgerExternalSecretPath -Path \$McpTokenPath/);
  assert.match(configureSource, /New-LedgerOwnerOnlyEmptyFile -Path \$backupPath/);
  assert.match(configureSource, /Assert-LedgerOwnerOnlyFile -Path \$backupPath/);
  assert.match(configureSource, /Assert-LedgerOwnerOnlyFile -Path \$ConfigPath/);
  assert.match(configureSource, /Assert-LedgerOwnerOnlyFile -Path \$Path/);
  assert.match(configureSource, /catch \[System\.IO\.IOException\]/);
  assert.match(configureSource, /Get-LedgerExpectedTask[^\r\n]+-Mode Explicit/);
  assert.ok(commonSource.includes("TaskPath -eq '\\'"));
  assert.match(configureSource, /Stop-ScheduledTask -InputObject \$task/);
  assert.match(configureSource, /Start-ScheduledTask -InputObject \$task/);
  assert.doesNotMatch(configureSource, /(?:Stop|Start)-ScheduledTask -TaskName/);
  assert.match(configureSource, /\(\[string\]\$response\.result\.token\)\.Trim\(\)/);
  assert.match(configureSource, /\$mcpToken -match '\[\\r\\n\]'/);
  assert.match(configureSource, /\[string\]\$ConfigPath = 'D:\\Clawbot\\ezbookkeeping\\conf\\ezbookkeeping\.ini'/);
  assert.match(configureSource, /\[string\]\$InstallDirectory = 'D:\\Clawbot\\ezbookkeeping'/);
  assert.match(configureSource, /tokens\/generate\/mcp\.json'.*-TimeoutSec 15/);
  assert.doesNotMatch(configureSource, /\[IO\.File\]::WriteAllText\(\$ConfigPath/);
  assert.match(configureSource, /Write-LedgerTextAtomically -Path \$ConfigPath -Text \$Text/);
  assert.match(configureSource, /Restore the configuration backup at '\{0\}'/);
  assert.match(configureSource, /Get-LedgerExpectedTask[^\r\n]+-Mode Explicit/);
  assert.match(installSource, /Get-LedgerExplicitServiceArguments/);
  assert.match(commonSource, /return '--conf-path "' \+ \$normalizedConfig \+ '" server run'/);
  assert.doesNotMatch(configureSource, /Get-HiddenPowerShell|WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.doesNotMatch(installSource, /Register-ScheduledTask[^\r\n]*-Force/);
  assert.doesNotMatch(installSource, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
});

test('configure script accepts the nested conf layout and performs the secured happy path in order', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clawbot-runtime-happy-shim-'));
  try {
    const configDirectory = join(temporaryDirectory, 'conf');
    const configPath = join(configDirectory, 'ezbookkeeping.ini');
    const executablePath = join(temporaryDirectory, 'ezbookkeeping.exe');
    const apiTokenPath = join(temporaryDirectory, 'api-token.txt');
    const mcpTokenPath = join(temporaryDirectory, 'secrets', 'mcp-token.txt');
    const wrapperPath = join(temporaryDirectory, 'run-happy-shim.ps1');
    mkdirSync(configDirectory);
    writeFileSync(configPath, '[mcp]\nenable_mcp = false\nmcp_allowed_remote_ips = 10.0.0.1\n', 'utf8');
    writeFileSync(executablePath, '', 'utf8');
    writeFileSync(apiTokenPath, 'temporary-api-token', 'utf8');
    writeFileSync(wrapperPath, `
$global:expectedTaskName = 'Clawbot test task'
$global:expectedExecutable = $args[5]
$global:installDirectory = $args[6]
$global:configPath = $args[1]
$global:expectedArguments = '--conf-path "' + $global:configPath + '" server run'
$global:trace = @()
$global:phase = 'running'
if (-not (Test-Path -LiteralPath $args[3])) { throw 'Happy-path API token fixture is missing.' }
$global:task = [pscustomobject]@{
  TaskName = $global:expectedTaskName
  TaskPath = '\\'
  State = 'Running'
  Actions = @([pscustomobject]@{ Execute = $global:expectedExecutable; Arguments = $global:expectedArguments; WorkingDirectory = $global:installDirectory })
}
function Get-ScheduledTask { [CmdletBinding()] param() [void]($global:trace += 'task'); $global:task }
function Stop-ScheduledTask { [CmdletBinding()] param([object]$InputObject) if ($InputObject -ne $global:task) { throw 'Wrong stop task object.' }; [void]($global:trace += 'stop'); $global:phase = 'stopped'; $global:task.State = 'Ready' }
function Start-ScheduledTask { [CmdletBinding()] param([object]$InputObject) if ($InputObject -ne $global:task) { throw 'Wrong start task object.' }; [void]($global:trace += 'start'); $global:phase = 'running'; $global:task.State = 'Running' }
function Get-NetTCPConnection { [CmdletBinding()] param([string]$State, [int]$LocalPort) if ($global:phase -eq 'running' -and $LocalPort -eq 8888) { [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8888; OwningProcess = 5252 } } else { @() } }
function Get-CimInstance { [CmdletBinding()] param([string]$ClassName, [string]$Filter) [pscustomobject]@{ ProcessId = 5252; CreationDate = 'happy'; ExecutablePath = $global:expectedExecutable; CommandLine = ('"' + $global:expectedExecutable + '" ' + $global:expectedArguments) } }
function Stop-Process { [CmdletBinding()] param() throw 'No process should be stopped in this fixture.' }
function Invoke-RestMethod {
  [CmdletBinding()]
  param([string]$Uri, [string]$Method, [int]$MaximumRedirection, [int]$TimeoutSec, [object]$Headers, [string]$ContentType, [string]$Body)
  if ($Uri -like '*healthz.json') { [void]($global:trace += 'health'); return [pscustomobject]@{ success = $true } }
  if ($Uri -like '*generate/mcp.json') { if ($MaximumRedirection -ne 0 -or $TimeoutSec -ne 15) { throw 'Token request was not bounded or redirects were enabled.' }; [void]($global:trace += 'token'); return [pscustomobject]@{ success = $true; result = [pscustomobject]@{ token = '  normalized-test-token  ' } } }
  throw 'Unexpected URI.'
}
function Invoke-WebRequest { [CmdletBinding()] param([string]$Uri, [switch]$UseBasicParsing, [int]$MaximumRedirection, [int]$TimeoutSec) [pscustomobject]@{ Content = '<title>ezBookkeeping</title>' } }
function Read-Host { [CmdletBinding()] param([string]$Prompt, [switch]$AsSecureString) [void]($global:trace += 'password'); $secure = New-Object System.Security.SecureString; 'temporary-password'.ToCharArray() | ForEach-Object { $secure.AppendChar($_) }; $secure.MakeReadOnly(); Write-Output -NoEnumerate $secure }
function Set-Acl {
  [CmdletBinding()]
  param([string]$LiteralPath, [object]$AclObject)
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $rules = @($AclObject.Access | Where-Object { $_.IdentityReference.Value -eq $currentIdentity })
  if (-not $AclObject.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'ACL was not exactly current-user FullControl allow.' }
  [void]($global:trace += 'acl')
}
function Get-Acl {
  [CmdletBinding()] param([string]$LiteralPath)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  [pscustomobject]@{
    Owner = $identity
    AreAccessRulesProtected = $true
    Access = @([pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = $identity }; AccessControlType = 'Allow'; FileSystemRights = 'FullControl' })
  }
}
try { & $args[0] -ConfigPath $args[1] -InstallDirectory $args[2] -ApiTokenPath $args[3] -McpTokenPath $args[4] -BackupRoot (Join-Path $args[2] 'backups') -TaskName $global:expectedTaskName -Confirm:$false } catch { throw ('Happy-path error after ' + ($global:trace -join ',') + ': ' + (($Error | ForEach-Object { $_.Exception.Message + ' @ ' + $_.ScriptStackTrace }) -join ' | ')) }
$nonAclTrace = @($global:trace | Where-Object { $_ -ne 'acl' }) -join ','
if ($nonAclTrace -ne 'task,health,task,stop,start,health,password,token') { throw ('Unexpected call order: ' + ($global:trace -join ',')) }
if (@($global:trace | Where-Object { $_ -eq 'acl' }).Count -lt 6) { throw ('Expected backup, config, temporary, and token ACL hardening: ' + ($global:trace -join ',')) }
`, 'utf8');

    runPowerShell(['-File', wrapperPath, configureScript, configPath, temporaryDirectory, apiTokenPath, mcpTokenPath, executablePath, temporaryDirectory]);
    assert.equal(readFileSync(configPath, 'utf8'), '[mcp]\nenable_mcp = true\nmcp_allowed_remote_ips = 127.0.0.1\n');
    assert.deepEqual(readFileSync(mcpTokenPath), Buffer.from('normalized-test-token', 'utf8'));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('configure script rolls back the INI and running task state when token generation fails', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clawbot-runtime-rollback-shim-'));
  try {
    const configDirectory = join(temporaryDirectory, 'conf');
    const configPath = join(configDirectory, 'ezbookkeeping.ini');
    const executablePath = join(temporaryDirectory, 'ezbookkeeping.exe');
    const apiTokenPath = join(temporaryDirectory, 'api.txt');
    const wrapperPath = join(temporaryDirectory, 'run-rollback-shim.ps1');
    const originalIni = '[mcp]\nenable_mcp = false\nmcp_allowed_remote_ips = 10.0.0.1\n';
    mkdirSync(configDirectory);
    writeFileSync(configPath, originalIni, 'utf8');
    writeFileSync(executablePath, '', 'utf8');
    writeFileSync(apiTokenPath, 'temporary-api-token', 'utf8');
    writeFileSync(wrapperPath, `
$global:trace = @()
$global:phase = 'running'
$global:expectedExecutable = $args[5]
$global:configPath = $args[1]
$global:expectedArguments = '--conf-path "' + $global:configPath + '" server run'
$global:task = [pscustomobject]@{ TaskName = 'Clawbot rollback task'; TaskPath = '\\'; State = 'Running'; Actions = @([pscustomobject]@{ Execute = $global:expectedExecutable; Arguments = $global:expectedArguments; WorkingDirectory = $args[2] }) }
function Get-ScheduledTask { [CmdletBinding()] param() $global:task }
function Stop-ScheduledTask { [CmdletBinding()] param([object]$InputObject) if ($InputObject -ne $global:task) { throw 'Wrong rollback stop object.' }; [void]($global:trace += 'stop'); $global:phase = 'stopped'; $global:task.State = 'Ready' }
function Start-ScheduledTask { [CmdletBinding()] param([object]$InputObject) if ($InputObject -ne $global:task) { throw 'Wrong rollback start object.' }; [void]($global:trace += 'start'); $global:phase = 'running'; $global:task.State = 'Running' }
function Get-NetTCPConnection { [CmdletBinding()] param([string]$State, [int]$LocalPort) if ($global:phase -eq 'running' -and $LocalPort -eq 8888) { [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8888; OwningProcess = 5353 } } else { @() } }
function Get-CimInstance { [CmdletBinding()] param([string]$ClassName, [string]$Filter) [pscustomobject]@{ ProcessId = 5353; CreationDate = 'rollback'; ExecutablePath = $global:expectedExecutable; CommandLine = ('"' + $global:expectedExecutable + '" ' + $global:expectedArguments) } }
function Stop-Process { [CmdletBinding()] param() throw 'No process should be stopped in this fixture.' }
function Invoke-RestMethod { [CmdletBinding()] param([string]$Uri, [string]$Method, [int]$MaximumRedirection, [int]$TimeoutSec, [object]$Headers, [string]$ContentType, [string]$Body) if ($Uri -like '*healthz.json') { [void]($global:trace += 'health'); return [pscustomobject]@{ success = $true } }; [void]($global:trace += 'token'); throw 'Temporary token failure.' }
function Invoke-WebRequest { [CmdletBinding()] param([string]$Uri, [switch]$UseBasicParsing, [int]$MaximumRedirection, [int]$TimeoutSec) [pscustomobject]@{ Content = '<title>ezBookkeeping</title>' } }
function Read-Host { [CmdletBinding()] param([string]$Prompt, [switch]$AsSecureString) [void]($global:trace += 'password'); $secure = New-Object System.Security.SecureString; 'temporary-password'.ToCharArray() | ForEach-Object { $secure.AppendChar($_) }; $secure.MakeReadOnly(); Write-Output -NoEnumerate $secure }
function Set-Acl { [CmdletBinding()] param([string]$LiteralPath, [object]$AclObject) [void]($global:trace += 'acl') }
function Get-Acl {
  [CmdletBinding()] param([string]$LiteralPath)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  [pscustomobject]@{
    Owner = $identity
    AreAccessRulesProtected = $true
    Access = @([pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = $identity }; AccessControlType = 'Allow'; FileSystemRights = 'FullControl' })
  }
}
try { & $args[0] -ConfigPath $args[1] -InstallDirectory $args[2] -ApiTokenPath $args[3] -McpTokenPath $args[4] -BackupRoot (Join-Path $args[2] 'backups') -TaskName 'Clawbot rollback task' -Confirm:$false; throw 'Expected token failure.' } catch { if ($_.Exception.Message -notmatch 'Could not complete local ezBookkeeping MCP setup') { throw } }
$nonAclTrace = @($global:trace | Where-Object { $_ -ne 'acl' }) -join ','
if ($nonAclTrace -ne 'health,stop,start,health,password,token,stop,start') { throw ('Unexpected rollback order: ' + ($global:trace -join ',')) }
if (@($global:trace | Where-Object { $_ -eq 'acl' }).Count -lt 6) { throw ('Expected backup, live config, and rollback ACL hardening: ' + ($global:trace -join ',')) }
`, 'utf8');
    runPowerShell(['-File', wrapperPath, configureScript, configPath, temporaryDirectory, apiTokenPath, join(temporaryDirectory, 'mcp.txt'), executablePath]);
    assert.equal(readFileSync(configPath, 'utf8'), originalIni);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('a locked replace leaves the original INI and atomic backup intact without temporary residue', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clawbot-runtime-replace-fault-'));
  try {
    const configDirectory = join(temporaryDirectory, 'conf');
    const configPath = join(configDirectory, 'ezbookkeeping.ini');
    const executablePath = join(temporaryDirectory, 'ezbookkeeping.exe');
    const wrapperPath = join(temporaryDirectory, 'run-replace-fault-shim.ps1');
    const originalIni = '[mcp]\nenable_mcp = false\nmcp_allowed_remote_ips = 10.0.0.1\n';
    mkdirSync(configDirectory);
    writeFileSync(configPath, originalIni, 'utf8');
    writeFileSync(executablePath, '', 'utf8');
    writeFileSync(wrapperPath, `
$global:configLock = $null
$global:configPath = $args[1]
$global:executable = $args[4]
$global:task = [pscustomobject]@{ TaskName = 'Clawbot replace fault'; TaskPath = '\\'; State = 'Running'; Actions = @([pscustomobject]@{ Execute = $args[4]; Arguments = ('--conf-path "' + $args[1] + '" server run'); WorkingDirectory = $args[2] }) }
function Get-ScheduledTask { [CmdletBinding()] param() $global:configLock = [IO.File]::Open($global:configPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); $global:task }
function Get-NetTCPConnection { [CmdletBinding()] param([string]$State, [int]$LocalPort) [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8888; OwningProcess = 5454 } }
function Get-CimInstance { [CmdletBinding()] param([string]$ClassName, [string]$Filter) [pscustomobject]@{ ProcessId = 5454; CreationDate = 'locked'; ExecutablePath = $global:executable; CommandLine = ('"' + $global:executable + '" --conf-path "' + $global:configPath + '" server run') } }
function Invoke-RestMethod { [CmdletBinding()] param([string]$Uri, [int]$MaximumRedirection, [int]$TimeoutSec) [pscustomobject]@{ success = $true } }
function Invoke-WebRequest { [CmdletBinding()] param([string]$Uri, [switch]$UseBasicParsing, [int]$MaximumRedirection, [int]$TimeoutSec) [pscustomobject]@{ Content = '<title>ezBookkeeping</title>' } }
function Set-Acl { [CmdletBinding()] param([string]$LiteralPath, [object]$AclObject) }
function Get-Acl {
  [CmdletBinding()] param([string]$LiteralPath)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  [pscustomobject]@{
    Owner = $identity
    AreAccessRulesProtected = $true
    Access = @([pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = $identity }; AccessControlType = 'Allow'; FileSystemRights = 'FullControl' })
  }
}
try { & $args[0] -ConfigPath $args[1] -InstallDirectory $args[2] -ApiTokenPath $args[3] -McpTokenPath (Join-Path $args[2] 'mcp.txt') -BackupRoot (Join-Path $args[2] 'backups') -TaskName 'Clawbot replace fault' -Confirm:$false; throw 'Expected locked replace failure.' } catch { if ($_.Exception.Message -notmatch 'Could not complete local ezBookkeeping MCP setup') { throw } } finally { if ($global:configLock) { $global:configLock.Dispose() } }
`, 'utf8');
    runPowerShell(['-File', wrapperPath, configureScript, configPath, temporaryDirectory, join(temporaryDirectory, 'api.txt'), executablePath]);
    assert.equal(readFileSync(configPath, 'utf8'), originalIni);
    const names = readdirSync(configDirectory);
    const backups = names.filter((name) => name.includes('.before-mcp-'));
    assert.equal(backups.length, 1);
    assert.deepEqual(readFileSync(join(configDirectory, backups[0])), Buffer.from(originalIni, 'utf8'));
    assert.equal(names.some((name) => name.endsWith('.tmp')), false);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
