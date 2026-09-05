import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, win32 } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const scriptsDirectory = join(projectDirectory, 'scripts');
const syntheticSha256 = 'abcdef0123456789'.repeat(4);

function psString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

const helperSources = [
  ['test-ledger-restart.ps1', [
    'Get-RestartNormalizedPath',
    'Test-RestartSamePath',
    'Get-RestartWindowsIdentitySid',
    'Test-RestartSameWindowsIdentity',
    'ConvertTo-RestartTaskQuotedArgument',
    'Get-ExpectedTunnelTaskArguments',
    'Get-ExactTunnelTask',
    'Assert-RestartTaskPolicy',
  ]],
  ['install-ledger-tunnel-task.ps1', [
    'ConvertTo-TaskQuotedArgument',
    'Get-TunnelTaskArguments',
  ]],
  ['test-ledger-local.ps1', ['Get-LocalNormalizedPath', 'Get-LocalTaskArguments']],
].map(([filename, names]) => `
  $tokens = $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile(${psString(join(scriptsDirectory, filename))}, [ref]$tokens, [ref]$errors)
  if ($errors.Count -ne 0) { throw 'Fixture source did not parse.' }
  foreach ($name in @(${names.map(psString).join(', ')})) {
    $definitions = @($ast.FindAll({
      param($node)
      $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
    }, $true))
    if ($definitions.Count -ne 1) { throw 'Expected exactly one helper definition.' }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
  }
`).join('\n');

function runHelpers(script) {
  // Parse and load only the named functions: never execute installer or acceptance entrypoints.
  const source = `
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version 2.0
    if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
      throw 'This regression must run under Windows PowerShell 5.1.'
    }
    ${helperSources}
    ${script}
  `;
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64'),
  ], { cwd: projectDirectory, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

function fixture(root) {
  const paths = {
    Runtime: win32.join(root, 'runtime'),
    Cloudflared: win32.join(root, 'cloudflared.exe'),
    CloudflaredSha256: syntheticSha256,
    TunnelConfig: win32.join(root, 'ledger.yml'),
    EzBookkeeping: win32.join(root, 'ezbookkeeping.exe'),
    EzBookkeepingConfig: win32.join(root, 'ezbookkeeping.ini'),
    SupervisorLog: win32.join(root, 'supervisor.log'),
  };
  const supervisor = win32.join(paths.Runtime, 'ledger-tunnel-supervisor.ps1');
  const common = win32.join(paths.Runtime, 'ledger-runtime-common.ps1');
  // Independent command-line contract, including every required separator and quote.
  const expected = `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${supervisor}" -CommonScriptPath "${common}" -RuntimeDirectory "${paths.Runtime}" -CloudflaredPath "${paths.Cloudflared}" -ExpectedCloudflaredSha256 ${syntheticSha256.toUpperCase()} -TunnelConfigPath "${paths.TunnelConfig}" -EzBookkeepingExecutable "${paths.EzBookkeeping}" -EzBookkeepingConfigPath "${paths.EzBookkeepingConfig}" -LogPath "${paths.SupervisorLog}"`;
  const setup = `
    $parameters = @{
      ${Object.entries(paths).map(([name, value]) => `${name} = ${psString(value)}`).join('\n')}
    }
    $supervisor = ${psString(supervisor)}
    $common = ${psString(common)}
  `;
  return { paths, supervisor, expected, setup };
}

for (const [label, root] of [
  ['without spaces', 'C:\\SyntheticLedgerTest'],
  ['with single spaces', 'C:\\Synthetic Ledger Test'],
  ['with double internal spaces', 'C:\\Synthetic  Ledger  Test'],
]) {
  test(`restart arguments match canonical, installer, and local commands ${label}`, () => {
    const { expected, setup } = fixture(root);
    const commands = runHelpers(`
      ${setup}
      $CloudflaredPath = $parameters.Cloudflared
      $ExpectedCloudflaredSha256 = $parameters.CloudflaredSha256
      $TunnelConfigPath = $parameters.TunnelConfig
      $EzBookkeepingExecutable = $parameters.EzBookkeeping
      $EzBookkeepingConfigPath = $parameters.EzBookkeepingConfig
      $TunnelRuntimeDirectory = $parameters.Runtime
      $TunnelLogPath = $parameters.SupervisorLog
      [ordered]@{
        installer = Get-TunnelTaskArguments @parameters -InstalledSupervisor $supervisor -InstalledCommon $common
        local = Get-LocalTaskArguments -InstalledSupervisor $supervisor -InstalledCommon $common
        restart = Get-ExpectedTunnelTaskArguments @parameters
      } | ConvertTo-Json -Compress
    `);
    assert.equal(commands.installer, expected);
    assert.equal(commands.local, expected);
    assert.equal(commands.restart, expected);
  });

  test(`restart accepts only the exact synthetic Tunnel task arguments ${label}`, () => {
    const { paths, supervisor, expected, setup } = fixture(root);
    const cases = {
      canonical: expected,
      wrongPath: expected.replace(supervisor, win32.join(paths.Runtime, 'other-supervisor.ps1')),
      wrongHash: expected.replace(syntheticSha256.toUpperCase(), '0'.repeat(64)),
      extraArgument: `${expected} -UnexpectedArgument`,
      extraSeparator: expected.replace('-File ', '-File  '),
    };
    if (root.includes('  ')) cases.changedInternalSpaces = expected.replaceAll('  ', ' ');
    const results = runHelpers(`
      ${setup}
      $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
      $script:syntheticTask = [pscustomobject]@{
        TaskName = 'Synthetic Ledger Tunnel'
        TaskPath = '\\'
        Actions = @([pscustomobject]@{
          Execute = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
          WorkingDirectory = $parameters.Runtime
          Arguments = ''
        })
        Principal = [pscustomobject]@{ UserId = $identity; LogonType = 'Interactive'; RunLevel = 'Limited' }
        Triggers = @([pscustomobject]@{
          CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' }
          UserId = $identity
          Enabled = $true
        })
        Settings = [pscustomobject]@{
          Enabled = $true
          MultipleInstances = 'IgnoreNew'
          RestartCount = 999
          RestartInterval = 'PT1M'
          ExecutionTimeLimit = 'PT0S'
          StartWhenAvailable = $true
          DisallowStartIfOnBatteries = $false
          StopIfGoingOnBatteries = $false
        }
      }
      function Get-ScheduledTask {
        [CmdletBinding()]
        param()
        return $script:syntheticTask
      }
      $cases = [ordered]@{
        ${Object.entries(cases).map(([name, value]) => `${name} = ${psString(value)}`).join('\n')}
      }
      $results = [ordered]@{}
      foreach ($case in $cases.GetEnumerator()) {
        $script:syntheticTask.Actions[0].Arguments = $case.Value
        try {
          $task = Get-ExactTunnelTask @parameters -Name 'Synthetic Ledger Tunnel'
          $results[$case.Key] = if ([object]::ReferenceEquals($task, $script:syntheticTask)) { 'accepted' } else { 'wrong task' }
        } catch {
          $results[$case.Key] = $_.Exception.Message
        }
      }
      $results | ConvertTo-Json -Compress
    `);
    assert.equal(results.canonical, 'accepted');
    for (const name of Object.keys(cases).filter((name) => name !== 'canonical')) {
      assert.equal(results[name], 'The Ledger Tunnel scheduled task action or principal is not recognized.', name);
    }
  });
}
