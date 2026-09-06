import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const commonPath = resolve(root, 'scripts/ledger-runtime-common.ps1').replaceAll("'", "''");
const prelude = `
$ErrorActionPreference = 'Stop'
. '${commonPath}'
$global:listenerProbes = 0
$identity = [pscustomobject]@{ ProcessId = 4100; CreationDate = 'original' }
$expectedExecutable = 'D:\\synthetic-ledger\\ezbookkeeping.exe'
$expectedConfig = 'D:\\synthetic-ledger\\conf\\ezbookkeeping.ini'
`;

function runPowerShell(body) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', prelude + body,
  ], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (result.error) throw result.error;
  return result;
}

function waitCommand(legacy = false) {
  return `Wait-LedgerListenerExit -Identity $identity -Port 18888 -ExpectedExecutable $expectedExecutable -ExpectedConfigPath $expectedConfig -Attempts 1 -IntervalMilliseconds 1 ${legacy ? '-Legacy' : ''}`;
}

for (const legacy of [false, true]) {
  test(`listener exit accepts a port disappearing during ${legacy ? 'legacy' : 'explicit'} owner lookup`, () => {
    const result = runPowerShell(`
function Get-NetTCPConnection {
    [CmdletBinding()] param([string]$State, [int]$LocalPort)
    if ($LocalPort -ne 18888) { throw 'Unexpected test port' }
    $global:listenerProbes++
    if ($global:listenerProbes -eq 1) {
        return [pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 4100 }
    }
    return @()
}
function Get-CimInstance { throw 'A vanished listener must not inspect a process' }
${waitCommand(legacy)}
if ($global:listenerProbes -lt 3) { throw 'Port absence was not independently confirmed' }
'PORT_EXIT_CONFIRMED'
`);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /PORT_EXIT_CONFIRMED/u);
  });
}

test('listener exit accepts a process disappearing after the listener snapshot', () => {
  const result = runPowerShell(`
function Get-NetTCPConnection {
    [CmdletBinding()] param([string]$State, [int]$LocalPort)
    if ($LocalPort -ne 18888) { throw 'Unexpected test port' }
    $global:listenerProbes++
    if ($global:listenerProbes -le 2) {
        return [pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 4100 }
    }
    return @()
}
function Get-CimInstance {
    [CmdletBinding()] param([string]$ClassName, [string]$Filter)
    return @()
}
${waitCommand()}
if ($global:listenerProbes -lt 3) { throw 'Port absence was not independently confirmed' }
'PROCESS_EXIT_CONFIRMED'
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PROCESS_EXIT_CONFIRMED/u);
});

for (const legacy of [false, true]) {
  test(`listener exit rejects an unknown executable still holding the ${legacy ? 'legacy' : 'explicit'} port`, () => {
    const result = runPowerShell(`
function Get-NetTCPConnection {
    [CmdletBinding()] param([string]$State, [int]$LocalPort)
    if ($LocalPort -ne 18888) { throw 'Unexpected test port' }
    return [pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 4200 }
}
function Get-CimInstance {
    [CmdletBinding()] param([string]$ClassName, [string]$Filter)
    return [pscustomobject]@{ ExecutablePath = 'D:\\unknown-service\\other.exe' }
}
try { ${waitCommand(legacy)}; throw 'Unsafe success' }
catch {
    if ($_.Exception.Message -notmatch 'unexpected executable') { throw }
    'UNKNOWN_OWNER_REJECTED'
}
`);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /UNKNOWN_OWNER_REJECTED/u);
  });
}

test('listener exit does not treat a failed absence probe as an empty port', () => {
  const result = runPowerShell(`
function Get-NetTCPConnection {
    [CmdletBinding()] param([string]$State, [int]$LocalPort)
    if ($LocalPort -ne 18888) { throw 'Unexpected test port' }
    $global:listenerProbes++
    if ($global:listenerProbes -eq 1) {
        return [pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 4100 }
    }
    throw 'Probe unavailable'
}
try { ${waitCommand()}; throw 'Unsafe success' }
catch {
    if ($_.Exception.Message -ne 'Probe unavailable') { throw }
    'PROBE_FAILURE_PROPAGATED'
}
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PROBE_FAILURE_PROPAGATED/u);
});

test('listener exit retains the creation-time guard against PID reuse', () => {
  const result = runPowerShell(`
function Get-NetTCPConnection {
    [CmdletBinding()] param([string]$State, [int]$LocalPort)
    if ($LocalPort -ne 18888) { throw 'Unexpected test port' }
    return [pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 4100 }
}
function Get-LedgerListenerOwner {
    param($Port, $ExpectedExecutable, $ExpectedConfigPath)
    return [pscustomobject]@{ ProcessId = 4100; CreationDate = 'replacement' }
}
try { ${waitCommand()}; throw 'Unsafe success' }
catch {
    if ($_.Exception.Message -ne 'Listener ownership changed after the exact scheduled task was stopped.') { throw }
    'PID_REUSE_REJECTED'
}
`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PID_REUSE_REJECTED/u);
});
