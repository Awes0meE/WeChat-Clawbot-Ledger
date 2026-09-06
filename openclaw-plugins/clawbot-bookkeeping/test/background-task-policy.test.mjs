import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scripts = fileURLToPath(new URL('../../../scripts/', import.meta.url));

for (const [file, policy] of [
  ['test-ledger-local.ps1', 'Assert-LocalScheduledTaskPolicy'],
  ['test-ledger-restart.ps1', 'Assert-RestartTaskPolicy'],
  ['install-ledger-tunnel-task.ps1', 'Test-TunnelInstallExactTask'],
]) {
  test(`${policy} accepts password-free background tasks and rejects unsafe principals`, () => {
    const path = resolve(scripts, file).replaceAll("'", "''");
    // Load definitions without executing service checks or installation side effects.
    const command = `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Fixture source could not be parsed.' }
foreach ($fn in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  Invoke-Expression $fn.Extent.Text
}
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$task = [pscustomobject]@{
  TaskName = 'Clawbot Ledger Tunnel'; TaskPath = '\\'
  Principal = [pscustomobject]@{ UserId = $user; LogonType = 'S4U'; RunLevel = 'Limited' }
  Actions = @([pscustomobject]@{ Execute = 'C:\\fixture\\powershell.exe'; Arguments = 'fixture'; WorkingDirectory = 'C:\\fixture' })
  Triggers = @([pscustomobject]@{ CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' }; UserId = $user; Enabled = $true })
  Settings = [pscustomobject]@{ Enabled = $true; MultipleInstances = 'IgnoreNew'; RestartCount = 999; RestartInterval = 'PT1M'; ExecutionTimeLimit = 'PT0S'; StartWhenAvailable = $true; DisallowStartIfOnBatteries = $false; StopIfGoingOnBatteries = $false }
}
function Test-Policy {
  try {
    ${policy.startsWith('Test-')
      ? `return ${policy} -Task $task -TaskName $task.TaskName -ExpectedLauncher $task.Actions[0].Execute -ExpectedArguments 'fixture' -ExpectedWorkingDirectory 'C:\\fixture' -ExpectedUser $user`
      : `${policy} -Task $task -ExpectedRestartCount 999; return $true`}
  } catch { return $false }
}
foreach ($mode in @('S4U', 'Interactive')) {
  $task.Principal.LogonType = $mode
  if (-not (Test-Policy)) { throw ('Rejected supported logon mode: ' + $mode) }
}
foreach ($mode in @('Password', 'ServiceAccount', 'Group', 'None')) {
  $task.Principal.LogonType = $mode
  if (Test-Policy) { throw ('Accepted unsupported logon mode: ' + $mode) }
}
$task.Principal.LogonType = 'S4U'
$task.Principal.RunLevel = 'Highest'
if (Test-Policy) { throw 'Accepted elevated task.' }
$task.Principal.RunLevel = 'Limited'
$task.Principal.UserId = 'S-1-5-18'
if (Test-Policy) { throw 'Accepted a different principal.' }
Write-Output 'PASS'
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /PASS/u);
  });
}
