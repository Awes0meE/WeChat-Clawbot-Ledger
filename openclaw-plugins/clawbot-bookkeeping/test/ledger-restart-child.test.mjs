import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, win32 } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const restartScript = join(projectDirectory, 'scripts', 'test-ledger-restart.ps1');
const countError = 'Restart acceptance requires exactly one recognized cloudflared child.';
const pathError = 'An unknown cloudflared process is present; restart acceptance refused to adopt or terminate it.';
const commandError = 'A cloudflared process has an unrecognized command line; restart acceptance refused it.';

function psString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runCases(cloudflared, tunnelConfig, cases) {
  // Load only these helpers. Never dot-source the restart acceptance entrypoint.
  const helperNames = [
    'Get-RestartNormalizedPath',
    'Test-RestartSamePath',
    'Get-ExpectedCloudflaredChild',
  ];
  const source = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    Set-StrictMode -Version 2.0
    if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
      throw 'This regression must run under Windows PowerShell 5.1.'
    }
    $tokens = $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile(${psString(restartScript)}, [ref]$tokens, [ref]$errors)
    if ($errors.Count -ne 0) { throw 'Fixture source did not parse.' }
    foreach ($name in @(${helperNames.map(psString).join(', ')})) {
      $definitions = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
      }, $true))
      if ($definitions.Count -ne 1) { throw 'Expected exactly one helper definition.' }
      . ([scriptblock]::Create($definitions[0].Extent.Text))
    }
    $script:syntheticProcesses = @()
    function Get-CimInstance {
      [CmdletBinding()]
      param([string]$ClassName, [string]$Filter)
      if ($ClassName -cne 'Win32_Process' -or $Filter -cne "Name='cloudflared.exe'") {
        throw 'The synthetic fixture received an unexpected process query.'
      }
      return $script:syntheticProcesses
    }
    $cases = @(${cases.map((entry) => `
      [pscustomobject]@{
        Name = ${psString(entry.name)}
        AllowAbsent = ${entry.allowAbsent ? '$true' : '$false'}
        Processes = @(${entry.processes.map((process) => `
          [pscustomobject]@{
            ExecutablePath = ${psString(process.ExecutablePath)}
            CommandLine = ${psString(process.CommandLine)}
          }
        `).join('\n')})
      }
    `).join('\n')})
    $results = [ordered]@{}
    foreach ($case in $cases) {
      $script:syntheticProcesses = @($case.Processes)
      try {
        $child = Get-ExpectedCloudflaredChild -Cloudflared ${psString(cloudflared)} -TunnelConfig ${psString(tunnelConfig)} -AllowAbsent:$case.AllowAbsent
        if ($null -eq $child) {
          $results[$case.Name] = 'absent'
        } elseif ($script:syntheticProcesses.Count -eq 1 -and [object]::ReferenceEquals($child, $script:syntheticProcesses[0])) {
          $results[$case.Name] = 'accepted'
        } else {
          $results[$case.Name] = 'unexpected child result'
        }
      } catch {
        $results[$case.Name] = $_.Exception.Message
      }
    }
    $results | ConvertTo-Json -Compress
  `;
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64'),
  ], { cwd: projectDirectory, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

for (const [label, root] of [
  ['without spaces', 'C:\\SyntheticLedgerTest'],
  ['with single spaces', 'C:\\Synthetic Ledger Test'],
  ['with double internal spaces', 'C:\\Synthetic  Ledger  Test'],
]) {
  test(`restart child recognition ${label}`, async (t) => {
    const cloudflared = win32.join(root, 'cloudflared.exe');
    const tunnelConfig = win32.join(root, 'ledger.yml');
    // Literal fixtures define the four currently supported command-line forms independently.
    const supportedCommands = [
      ['both paths quoted', `"${cloudflared}" tunnel --config "${tunnelConfig}" run`],
      ['only config quoted', `${cloudflared} tunnel --config "${tunnelConfig}" run`],
      ['only executable quoted', `"${cloudflared}" tunnel --config ${tunnelConfig} run`],
      ['neither path quoted', `${cloudflared} tunnel --config ${tunnelConfig} run`],
    ];
    const canonical = supportedCommands[0][1];
    const process = (commandLine = canonical, executablePath = cloudflared) => ({
      ExecutablePath: executablePath,
      CommandLine: commandLine,
    });
    const cases = supportedCommands.map(([name, command]) => ({
      name: `accepts ${name}`,
      processes: [process(command)],
      expected: 'accepted',
    }));
    cases.push(
      { name: 'allows absence only when requested', processes: [], allowAbsent: true, expected: 'absent' },
      { name: 'rejects absence by default', processes: [], expected: countError },
      { name: 'rejects multiple recognized children', processes: [process(), process()], expected: countError },
      { name: 'AllowAbsent still rejects multiple children', processes: [process(), process()], allowAbsent: true, expected: countError },
      { name: 'rejects an unknown executable path', processes: [process(canonical, win32.join(root, 'unknown.exe'))], expected: pathError },
      { name: 'AllowAbsent still rejects unknown children', processes: [process(canonical, win32.join(root, 'unknown.exe'))], allowAbsent: true, expected: pathError },
      { name: 'rejects an empty executable path', processes: [process(canonical, '')], expected: pathError },
      { name: 'rejects an unknown child alongside a recognized child', processes: [process(), process(canonical, win32.join(root, 'unknown.exe'))], expected: pathError },
      { name: 'rejects an altered command executable', processes: [process(canonical.replace(cloudflared, win32.join(root, 'other.exe')))], expected: commandError },
      { name: 'rejects an altered configuration path', processes: [process(canonical.replace(tunnelConfig, win32.join(root, 'other.yml')))], expected: commandError },
      { name: 'rejects an extra argument', processes: [process(`${canonical} --unexpected`)], expected: commandError },
      { name: 'rejects an extra separator', processes: [process(canonical.replace(' tunnel ', '  tunnel '))], expected: commandError },
      { name: 'rejects concatenated alternative commands', processes: [process(supportedCommands.map(([, command]) => command).join(' '))], expected: commandError },
    );
    if (root.includes('  ')) {
      cases.push({
        name: 'preserves double spaces inside paths',
        processes: [process(canonical.replaceAll('  ', ' '))],
        expected: commandError,
      });
    }
    const results = runCases(cloudflared, tunnelConfig, cases);
    for (const entry of cases) {
      await t.test(entry.name, () => {
        assert.equal(results[entry.name], entry.expected);
      });
    }
  });
}
