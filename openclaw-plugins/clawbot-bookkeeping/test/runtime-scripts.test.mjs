import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
    '[IO.File]::WriteAllText($ConfigPath',
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
    writeFileSync(configPath, '[mcp]\nenable_mcp = false\nmcp_allowed_remote_ips = 10.0.0.1\n', 'utf8');
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
    Actions = @([pscustomobject]@{ Execute = $global:expectedExecutable; Arguments = 'server wrong'; WorkingDirectory = $global:installDirectory })
  }
}
function Stop-ScheduledTask { [CmdletBinding()] param([object]$InputObject, [string]$TaskName) $global:unexpectedTaskControl = $true; throw 'Unexpected task stop.' }
function Start-ScheduledTask { [CmdletBinding()] param([object]$InputObject, [string]$TaskName) $global:unexpectedTaskControl = $true; throw 'Unexpected task start.' }
function Get-CimInstance { [CmdletBinding()] param() $global:unexpectedTaskControl = $true }
function Stop-Process { [CmdletBinding()] param() $global:unexpectedTaskControl = $true }
try {
  & $args[0] -ConfigPath $args[1] -ApiTokenPath $args[2] -McpTokenPath $args[3] -TaskName 'Clawbot test task' -Confirm:$false
  throw 'Expected the mismatched task action to be rejected.'
} catch {
  if ($_.Exception.Message -ne 'Could not complete local ezBookkeeping MCP setup. Check the configuration, task, and service health, then retry.') { throw }
}
if ($global:unexpectedTaskControl) { throw 'Task controls were reached for a mismatched action.' }
`, 'utf8');

    runPowerShell([
      '-File', wrapperPath, configureScript, configPath, join(temporaryDirectory, 'api.txt'), join(temporaryDirectory, 'mcp.txt'), executablePath, temporaryDirectory,
    ]);
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

test('configure source uses atomic backups, strict task actions, and normalized tokens', () => {
  const configureSource = readFileSync(configureScript, 'utf8');
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
});
