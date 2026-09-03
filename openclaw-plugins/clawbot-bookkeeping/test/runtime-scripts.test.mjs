import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const scriptsDirectory = join(projectDirectory, 'scripts');
const configureScript = join(scriptsDirectory, 'configure-ezbookkeeping-mcp.ps1');
const installScript = join(scriptsDirectory, 'install-ezbookkeeping-task.ps1');

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

function hiddenPowerShellLauncher() {
  return join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function hiddenServiceArguments(executablePath) {
  const escapedExecutable = executablePath.replace(/'/g, "''");
  return `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "& '${escapedExecutable}' server run"`;
}

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
    '[IO.File]::Copy',
    'Write-ConfigAtomically',
    'Get-ScheduledTask',
    'Stop-ScheduledTask',
    'Start-ScheduledTask',
    'Get-CimInstance',
    'Stop-Process',
    'Invoke-RestMethod',
    'Read-Host',
    '[IO.File]::ReadAllText($ApiTokenPath',
    'Set-OwnerOnlyTokenFile',
    'Set-Acl',
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
$global:expectedLauncher = $args[6]
$global:expectedLauncherArguments = $args[7]
$global:expectedTaskName = 'Clawbot test task'
function Get-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName)
  [pscustomobject]@{
    TaskName = $global:expectedTaskName
    TaskPath = '\\'
    Actions = @([pscustomobject]@{ Execute = $global:expectedLauncher; Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "& ''wrong.exe'' server run"'; WorkingDirectory = $global:installDirectory })
  }
}
function Stop-ScheduledTask { [CmdletBinding()] param([object]$InputObject, [string]$TaskName) $global:unexpectedTaskControl = $true; throw 'Unexpected task stop.' }
function Start-ScheduledTask { [CmdletBinding()] param([object]$InputObject, [string]$TaskName) $global:unexpectedTaskControl = $true; throw 'Unexpected task start.' }
function Get-CimInstance { [CmdletBinding()] param() $global:unexpectedTaskControl = $true }
function Stop-Process { [CmdletBinding()] param() $global:unexpectedTaskControl = $true }
try {
  & $args[0] -ConfigPath $args[1] -InstallDirectory $args[5] -ApiTokenPath $args[2] -McpTokenPath $args[3] -TaskName 'Clawbot test task' -Confirm:$false
  throw 'Expected the mismatched task action to be rejected.'
} catch {
  if ($_.Exception.Message -ne 'Could not complete local ezBookkeeping MCP setup. Check the configuration, task, and service health, then retry.') { throw }
}
if ($global:unexpectedTaskControl) { throw 'Task controls were reached for a mismatched action.' }
`, 'utf8');

    runPowerShell([
      '-File', wrapperPath, configureScript, configPath, join(temporaryDirectory, 'api.txt'), join(temporaryDirectory, 'mcp.txt'), executablePath, temporaryDirectory, hiddenPowerShellLauncher(), hiddenServiceArguments(executablePath),
    ]);
    assert.equal(readFileSync(configPath, 'utf8'), originalIni);
    assert.deepEqual(readdirSync(temporaryDirectory).sort(), ['ezbookkeeping.exe', 'ezbookkeeping.ini', 'run-configure-shim.ps1']);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('installer WhatIf reaches neither scheduled-task construction nor registration', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clawbot-runtime-install-shim-'));
  try {
    const executablePath = join(temporaryDirectory, 'ezbookkeeping.exe');
    const wrapperPath = join(temporaryDirectory, 'run-install-shim.ps1');
    writeFileSync(executablePath, '', 'utf8');
    writeFileSync(wrapperPath, `
$script:registered = $false
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

test('installer registers only the exact hidden Windows PowerShell launcher action', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clawbot-runtime-hidden-install-'));
  try {
    const executablePath = join(temporaryDirectory, 'ezbookkeeping.exe');
    const wrapperPath = join(temporaryDirectory, 'run-hidden-install-shim.ps1');
    const launcherPath = hiddenPowerShellLauncher();
    const launcherArguments = hiddenServiceArguments(executablePath);
    writeFileSync(executablePath, '', 'utf8');
    writeFileSync(wrapperPath, `
$global:registered = $false
$global:expectedDirectory = $args[1]
$global:expectedLauncher = $args[2]
$global:expectedArguments = $args[3]
function New-ScheduledTaskAction { [CmdletBinding()] param([string]$Execute, [string]$Argument, [string]$WorkingDirectory) [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory } }
function New-ScheduledTaskTrigger { [CmdletBinding()] param([switch]$AtLogOn, [string]$User) [pscustomobject]@{} }
function New-ScheduledTaskSettingsSet { [CmdletBinding()] param([int]$RestartCount, [TimeSpan]$RestartInterval, [TimeSpan]$ExecutionTimeLimit, [string]$MultipleInstances, [switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries) [pscustomobject]@{} }
function New-ScheduledTaskPrincipal { [CmdletBinding()] param([string]$UserId, [string]$LogonType, [string]$RunLevel) [pscustomobject]@{} }
function Register-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName, [object]$Action, [object]$Trigger, [object]$Settings, [object]$Principal, [switch]$Force)
  if ($Action.Execute -cne $global:expectedLauncher -or $Action.Arguments -cne $global:expectedArguments -or $Action.WorkingDirectory -cne $global:expectedDirectory) { throw 'Scheduled action was not the exact hidden launcher.' }
  $global:registered = $true
}
& $args[0] -InstallDirectory $args[1] -TaskName 'Clawbot hidden task' -Confirm:$false
if (-not $global:registered) { throw 'Expected shimmed task registration.' }
`, 'utf8');

    runPowerShell(['-File', wrapperPath, installScript, temporaryDirectory, launcherPath, launcherArguments]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('configure source uses atomic backups, strict task actions, and normalized tokens', () => {
  const configureSource = readFileSync(configureScript, 'utf8');
  const installSource = readFileSync(installScript, 'utf8');
  assert.doesNotMatch(configureSource, /Copy-Item\s+-LiteralPath\s+\$ConfigPath/);
  assert.match(configureSource, /\[IO\.File\]::Copy\(\$ConfigPath, \$backupPath, \$false\)/);
  assert.match(configureSource, /catch \[System\.IO\.IOException\]/);
  assert.match(configureSource, /Get-ScheduledTask -ErrorAction Stop/);
  assert.ok(configureSource.includes("TaskPath -eq '\\'"));
  assert.match(configureSource, /Stop-ScheduledTask -InputObject \$task/);
  assert.match(configureSource, /Start-ScheduledTask -InputObject \$task/);
  assert.doesNotMatch(configureSource, /(?:Stop|Start)-ScheduledTask -TaskName/);
  assert.match(configureSource, /\(\[string\]\$response\.result\.token\)\.Trim\(\)/);
  assert.match(configureSource, /\$mcpToken -match '\[\\r\\n\]'/);
  assert.match(configureSource, /\[string\]\$ConfigPath = 'D:\\Clawbot\\ezbookkeeping\\conf\\ezbookkeeping\.ini'/);
  assert.match(configureSource, /\[string\]\$InstallDirectory = 'D:\\Clawbot\\ezbookkeeping'/);
  assert.match(configureSource, /tokens\/generate\/mcp\.json'.*-TimeoutSec 15/);
  assert.doesNotMatch(configureSource, /\[IO\.File\]::WriteAllText\(\$ConfigPath/);
  assert.match(configureSource, /\[IO\.File\]::Replace\(\$temporaryConfigPath, \$ConfigPath, \$replacementBackupPath\)/);
  assert.match(configureSource, /Restore the configuration backup at '\{0\}'/);
  assert.match(configureSource, /-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command/);
  assert.match(installSource, /-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command/);
  assert.match(installSource, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
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
$global:expectedLauncher = $args[7]
$global:expectedLauncherArguments = $args[8]
$global:trace = @()
if (-not (Test-Path -LiteralPath $args[3])) { throw 'Happy-path API token fixture is missing.' }
$global:task = [pscustomobject]@{
  TaskName = $global:expectedTaskName
  TaskPath = '\\'
  State = 'Running'
  Actions = @([pscustomobject]@{ Execute = $global:expectedLauncher; Arguments = $global:expectedLauncherArguments; WorkingDirectory = $global:installDirectory })
}
function Get-ScheduledTask { [CmdletBinding()] param() $global:task }
function Stop-ScheduledTask { [CmdletBinding()] param([object]$InputObject) if ($InputObject -ne $global:task) { throw 'Wrong stop task object.' }; [void]($global:trace += 'stop') }
function Start-ScheduledTask { [CmdletBinding()] param([object]$InputObject) if ($InputObject -ne $global:task) { throw 'Wrong start task object.' }; [void]($global:trace += 'start') }
function Get-CimInstance { [CmdletBinding()] param([string]$ClassName, [string]$Filter) @() }
function Stop-Process { [CmdletBinding()] param() throw 'No process should be stopped in this fixture.' }
function Invoke-RestMethod {
  [CmdletBinding()]
  param([string]$Uri, [string]$Method, [int]$TimeoutSec, [object]$Headers, [string]$ContentType, [string]$Body)
  if ($Uri -like '*healthz.json') { [void]($global:trace += 'health'); return [pscustomobject]@{ success = $true } }
  if ($Uri -like '*generate/mcp.json') { if ($TimeoutSec -ne 15) { throw 'Token timeout was not bounded.' }; [void]($global:trace += 'token'); return [pscustomobject]@{ success = $true; result = [pscustomobject]@{ token = '  normalized-test-token  ' } } }
  throw 'Unexpected URI.'
}
function Read-Host { [CmdletBinding()] param([string]$Prompt, [switch]$AsSecureString) [void]($global:trace += 'password'); $secure = New-Object System.Security.SecureString; 'temporary-password'.ToCharArray() | ForEach-Object { $secure.AppendChar($_) }; $secure.MakeReadOnly(); Write-Output -NoEnumerate $secure }
function Set-Acl {
  [CmdletBinding()]
  param([string]$LiteralPath, [object]$AclObject)
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $rules = @($AclObject.Access | Where-Object { $_.IdentityReference.Value -eq $currentIdentity })
  if (-not $AclObject.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'ACL was not exactly current-user FullControl allow.' }
  [void]($global:trace += 'acl')
}
try { & $args[0] -ConfigPath $args[1] -InstallDirectory $args[2] -ApiTokenPath $args[3] -McpTokenPath $args[4] -TaskName $global:expectedTaskName -Confirm:$false } catch { throw ('Happy-path error after ' + ($global:trace -join ',') + ': ' + (($Error | ForEach-Object { $_.Exception.Message }) -join ' | ')) }
if (($global:trace -join ',') -ne 'stop,start,health,password,token,acl') { throw ('Unexpected call order: ' + ($global:trace -join ',')) }
`, 'utf8');

    runPowerShell(['-File', wrapperPath, configureScript, configPath, temporaryDirectory, apiTokenPath, mcpTokenPath, executablePath, temporaryDirectory, hiddenPowerShellLauncher(), hiddenServiceArguments(executablePath)]);
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
$global:task = [pscustomobject]@{ TaskName = 'Clawbot rollback task'; TaskPath = '\\'; State = 'Running'; Actions = @([pscustomobject]@{ Execute = $args[6]; Arguments = $args[7]; WorkingDirectory = $args[2] }) }
function Get-ScheduledTask { [CmdletBinding()] param() $global:task }
function Stop-ScheduledTask { [CmdletBinding()] param([object]$InputObject) if ($InputObject -ne $global:task) { throw 'Wrong rollback stop object.' }; [void]($global:trace += 'stop') }
function Start-ScheduledTask { [CmdletBinding()] param([object]$InputObject) if ($InputObject -ne $global:task) { throw 'Wrong rollback start object.' }; [void]($global:trace += 'start') }
function Get-CimInstance { [CmdletBinding()] param([string]$ClassName, [string]$Filter) @() }
function Stop-Process { [CmdletBinding()] param() throw 'No process should be stopped in this fixture.' }
function Invoke-RestMethod { [CmdletBinding()] param([string]$Uri, [string]$Method, [int]$TimeoutSec, [object]$Headers, [string]$ContentType, [string]$Body) if ($Uri -like '*healthz.json') { [void]($global:trace += 'health'); return [pscustomobject]@{ success = $true } }; [void]($global:trace += 'token'); throw 'Temporary token failure.' }
function Read-Host { [CmdletBinding()] param([string]$Prompt, [switch]$AsSecureString) [void]($global:trace += 'password'); $secure = New-Object System.Security.SecureString; 'temporary-password'.ToCharArray() | ForEach-Object { $secure.AppendChar($_) }; $secure.MakeReadOnly(); Write-Output -NoEnumerate $secure }
try { & $args[0] -ConfigPath $args[1] -InstallDirectory $args[2] -ApiTokenPath $args[3] -McpTokenPath $args[4] -TaskName 'Clawbot rollback task' -Confirm:$false; throw 'Expected token failure.' } catch { if ($_.Exception.Message -notmatch 'Could not complete local ezBookkeeping MCP setup') { throw } }
if (($global:trace -join ',') -ne 'stop,start,health,password,token,stop,start') { throw ('Unexpected rollback order: ' + ($global:trace -join ',')) }
`, 'utf8');
    runPowerShell(['-File', wrapperPath, configureScript, configPath, temporaryDirectory, apiTokenPath, join(temporaryDirectory, 'mcp.txt'), executablePath, hiddenPowerShellLauncher(), hiddenServiceArguments(executablePath)]);
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
$global:task = [pscustomobject]@{ TaskName = 'Clawbot replace fault'; TaskPath = '\\'; State = 'Ready'; Actions = @([pscustomobject]@{ Execute = $args[5]; Arguments = $args[6]; WorkingDirectory = $args[2] }) }
function Get-ScheduledTask { [CmdletBinding()] param() $global:configLock = [IO.File]::Open($global:configPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); $global:task }
try { & $args[0] -ConfigPath $args[1] -InstallDirectory $args[2] -ApiTokenPath $args[3] -McpTokenPath (Join-Path $args[2] 'mcp.txt') -TaskName 'Clawbot replace fault' -Confirm:$false; throw 'Expected locked replace failure.' } catch { if ($_.Exception.Message -notmatch 'Could not complete local ezBookkeeping MCP setup') { throw } } finally { if ($global:configLock) { $global:configLock.Dispose() } }
`, 'utf8');
    runPowerShell(['-File', wrapperPath, configureScript, configPath, temporaryDirectory, join(temporaryDirectory, 'api.txt'), executablePath, hiddenPowerShellLauncher(), hiddenServiceArguments(executablePath)]);
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
