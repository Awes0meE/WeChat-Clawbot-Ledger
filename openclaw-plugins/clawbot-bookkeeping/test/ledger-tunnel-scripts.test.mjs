import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const scriptsDirectory = join(projectDirectory, 'scripts');
const configDirectory = join(projectDirectory, 'config');
const commonScript = join(scriptsDirectory, 'ledger-runtime-common.ps1');
const supervisorScript = join(scriptsDirectory, 'ledger-tunnel-supervisor.ps1');
const installerScript = join(scriptsDirectory, 'install-ledger-tunnel-task.ps1');
const localTestScript = join(scriptsDirectory, 'test-ledger-local.ps1');
const exampleConfig = join(configDirectory, 'cloudflared-ledger.example.yml');
const runtimeMarkerName = '.clawbot-ledger-tunnel-runtime-v1';
const logMarkerName = '.clawbot-ledger-tunnel-log-v1';

function write(path, content = '') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function runPowerShell(scriptPath, args = [], env = process.env) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    {
      encoding: 'utf8',
      windowsHide: true,
      env,
    },
  );
}

function assertSucceeded(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function assertFailed(result, pattern) {
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, 'expected command to fail');
  assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

function tunnelYaml(credentialPath, overrides = {}) {
  const values = {
    tunnel: '11111111-2222-4333-8444-555555555555',
    credentialPath,
    hostname: 'ledger.66ccff-labs.com',
    origin: 'http://127.0.0.1:8888',
    fallback: 'http_status:404',
    noAutoupdate: 'true',
    ...overrides,
  };
  return [
    `tunnel: ${values.tunnel}`,
    `credentials-file: '${values.credentialPath}'`,
    `no-autoupdate: ${values.noAutoupdate}`,
    'ingress:',
    `  - hostname: ${values.hostname}`,
    `    service: ${values.origin}`,
    `  - service: ${values.fallback}`,
    '',
  ].join('\n');
}

function productionIni(databasePath) {
  return `; CLAWBOT_LEDGER_PROFILE=production
[global]
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
http_addr = 127.0.0.1
http_port = 8888
domain = ledger.66ccff-labs.com
root_url = https://ledger.66ccff-labs.com/
[mcp]
enable_mcp = false
mcp_allowed_remote_ips = 127.0.0.1
[database]
type = sqlite3
db_path = ${databasePath}
[log]
log_path = D:\\fixture\\production.log
[storage]
local_filesystem_path = D:\\fixture\\storage
[security]
secret_key = SENSITIVE-PRODUCTION-SECRET
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
}

function testIni(root) {
  return `; CLAWBOT_LEDGER_PROFILE=test
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
db_path = ${join(root, 'data', 'test.db')}
[log]
log_path = ${join(root, 'log', 'test.log')}
[storage]
local_filesystem_path = ${join(root, 'storage')}
[security]
secret_key = SENSITIVE-TEST-SECRET
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
}

function writeEnvironmentIsolatedScript(sourcePath, destinationPath, providerName, mutexName) {
  const source = readFileSync(sourcePath, 'utf8');
  const escapedProviderName = providerName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const providerPattern = new RegExp(
    `function ${escapedProviderName} \\{\\r?\\n`
      + '    param\\(\\[Parameter\\(Mandatory = \\$true\\)\\]\\[EnvironmentVariableTarget\\]\\$Target\\)\\r?\\n'
      + '\\r?\\n'
      + '    return \\[Environment\\]::GetEnvironmentVariables\\(\\$Target\\)\\r?\\n'
      + '\\}',
    'gu',
  );
  assert.equal(source.match(providerPattern)?.length, 1, `expected one ${providerName} production provider`);
  const isolatedProvider = `function ${providerName} {
    param([Parameter(Mandatory = $true)][EnvironmentVariableTarget]$Target)

    $requestedScope = [string]$env:CLAWBOT_TUNNEL_TEST_ENVIRONMENT_SCOPE
    if (-not [string]::IsNullOrWhiteSpace($requestedScope) -and
        [string]::Equals($requestedScope, [string]$Target, [StringComparison]::OrdinalIgnoreCase)) {
        $requestedName = [string]$env:CLAWBOT_TUNNEL_TEST_ENVIRONMENT_NAME
        if ([string]::IsNullOrWhiteSpace($requestedName)) { throw 'Test environment provider requires a variable name.' }
        $injected = @{}
        $injected[$requestedName] = 'FIXTURE-NON-SECRET'
        return $injected
    }
    if ($Target -eq [EnvironmentVariableTarget]::Process) {
        return [Environment]::GetEnvironmentVariables($Target)
    }
    return @{}
}`;
  let isolatedSource = source.replace(providerPattern, isolatedProvider);
  if (sourcePath === supervisorScript) {
    const productionMutex = "'Global\\ClawbotLedgerTunnelSupervisor'";
    assert.equal(isolatedSource.split(productionMutex).length - 1, 1, 'expected one production supervisor mutex');
    assert.match(mutexName, /^Local\\ClawbotLedgerTunnelTest-[0-9a-f]{64}$/u);
    isolatedSource = isolatedSource.replace(productionMutex, `'${mutexName}'`);
  }
  write(destinationPath, isolatedSource);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'clawbot-ledger-tunnel-'));
  const supervisorMutexName = `Local\\ClawbotLedgerTunnelTest-${createHash('sha256').update(root).digest('hex')}`;
  const local = join(root, 'local');
  const cloudflaredPath = join(local, 'cloudflared.exe');
  const credentialPath = join(local, '11111111-2222-4333-8444-555555555555.json');
  const tunnelConfigPath = join(local, 'ledger.yml');
  const ezbookkeepingPath = join(local, 'ezbookkeeping.exe');
  const productionConfigPath = join(local, 'ezbookkeeping.ini');
  const logPath = join(local, 'logs', 'ledger-tunnel-supervisor.log');
  const tracePath = join(root, 'trace.txt');
  const runtimeDirectory = join(local, 'runtime');
  const testRoot = join(local, 'ezbookkeeping-test');
  const testConfigPath = join(testRoot, 'conf', 'ezbookkeeping.ini');
  const releasePath = join(local, 'release');
  const releaseVerifierPath = join(root, 'verify-release-fixture.ps1');
  const isolatedScriptsDirectory = join(root, 'isolated-scripts');
  const isolatedSupervisorPath = join(isolatedScriptsDirectory, 'ledger-tunnel-supervisor.ps1');
  const isolatedLocalTestPath = join(isolatedScriptsDirectory, 'test-ledger-local.ps1');

  write(cloudflaredPath);
  write(credentialPath, '{"fixture":"credential-content-must-not-be-read"}\n');
  write(tunnelConfigPath, tunnelYaml(credentialPath));
  write(ezbookkeepingPath);
  write(productionConfigPath, productionIni(join(local, 'production.db')));
  write(testConfigPath, testIni(testRoot));
  mkdirSync(releasePath, { recursive: true });
  write(releaseVerifierPath, "param([string]$ReleasePath)\nWrite-Output 'OPENCLAW_RELEASE_VERIFIED'\n");
  writeEnvironmentIsolatedScript(supervisorScript, isolatedSupervisorPath, 'Get-TunnelEnvironmentVariables', supervisorMutexName);
  writeEnvironmentIsolatedScript(localTestScript, isolatedLocalTestPath, 'Get-LocalEnvironmentVariables');
  write(join(isolatedScriptsDirectory, 'ledger-runtime-common.ps1'), readFileSync(commonScript, 'utf8'));
  write(
    join(isolatedScriptsDirectory, 'verify-openclaw-release.ps1'),
    readFileSync(releaseVerifierPath, 'utf8'),
  );

  return {
    root,
    supervisorMutexName,
    local,
    cloudflaredPath,
    credentialPath,
    tunnelConfigPath,
    ezbookkeepingPath,
    productionConfigPath,
    logPath,
    tracePath,
    runtimeDirectory,
    testRoot,
    testConfigPath,
    releasePath,
    releaseVerifierPath,
    isolatedSupervisorPath,
    isolatedLocalTestPath,
  };
}

function fixtureEnv(fixture, extra = {}) {
  const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(
    ([name]) => !/^(?:TUNNEL_|EBK_|EBKCFP_)/iu.test(name) && name.toUpperCase() !== 'NO_AUTOUPDATE',
  ));
  return {
    ...cleanEnvironment,
    CLAWBOT_TUNNEL_TEST_COMMON: commonScript,
    CLAWBOT_TUNNEL_TEST_SUPERVISOR: fixture.isolatedSupervisorPath,
    CLAWBOT_TUNNEL_TEST_INSTALLER: installerScript,
    CLAWBOT_TUNNEL_TEST_LOCAL: fixture.isolatedLocalTestPath,
    CLAWBOT_TUNNEL_TEST_CLOUDFLARED: fixture.cloudflaredPath,
    CLAWBOT_TUNNEL_TEST_CREDENTIAL: fixture.credentialPath,
    CLAWBOT_TUNNEL_TEST_CONFIG: fixture.tunnelConfigPath,
    CLAWBOT_TUNNEL_TEST_EZBOOKKEEPING: fixture.ezbookkeepingPath,
    CLAWBOT_TUNNEL_TEST_PRODUCTION_CONFIG: fixture.productionConfigPath,
    CLAWBOT_TUNNEL_TEST_LOG: fixture.logPath,
    CLAWBOT_TUNNEL_TEST_TRACE: fixture.tracePath,
    CLAWBOT_TUNNEL_TEST_RUNTIME: fixture.runtimeDirectory,
    CLAWBOT_TUNNEL_TEST_TEST_ROOT: fixture.testRoot,
    CLAWBOT_TUNNEL_TEST_TEST_CONFIG: fixture.testConfigPath,
    CLAWBOT_TUNNEL_TEST_RELEASE: fixture.releasePath,
    CLAWBOT_TUNNEL_TEST_RELEASE_VERIFIER: fixture.releaseVerifierPath,
    CLAWBOT_TUNNEL_TEST_CLOUDFLARED_SHA256: createHash('sha256')
      .update(readFileSync(fixture.cloudflaredPath))
      .digest('hex')
      .toUpperCase(),
    ...extra,
  };
}

function prepareOwnedTunnelDirectories(fixture) {
  mkdirSync(fixture.runtimeDirectory, { recursive: true });
  mkdirSync(dirname(fixture.logPath), { recursive: true });
  write(join(fixture.runtimeDirectory, runtimeMarkerName), 'CLAWBOT_LEDGER_TUNNEL_RUNTIME_V1\n');
  write(
    join(dirname(fixture.logPath), logMarkerName),
    'CLAWBOT_LEDGER_TUNNEL_LOG_V1 ledger-tunnel-supervisor.log\n',
  );
}

function prepareLocalRuntimeFixture(fixture) {
  prepareOwnedTunnelDirectories(fixture);
  write(
    join(fixture.runtimeDirectory, 'ledger-tunnel-supervisor.ps1'),
    readFileSync(fixture.isolatedSupervisorPath, 'utf8'),
  );
  write(join(fixture.runtimeDirectory, 'ledger-runtime-common.ps1'), readFileSync(commonScript, 'utf8'));
}

function protectedAclPowerShell() {
  return `
function New-ProtectedAcl([switch]$OwnerOnly) {
  $owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $rules = @(
    [pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = $owner }; AccessControlType = 'Allow'; FileSystemRights = 'FullControl'; IsInherited = $false }
  )
  if (-not $OwnerOnly) {
    $rules += [pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = 'NT AUTHORITY\\SYSTEM' }; AccessControlType = 'Allow'; FileSystemRights = 'ReadAndExecute, Synchronize'; IsInherited = $false }
  }
  [pscustomobject]@{
    Owner = $owner
    AreAccessRulesProtected = $true
    Access = $rules
  }
}
function Get-Acl {
  [CmdletBinding()]
  param([string]$LiteralPath)
  $isProductionConfig = -not [string]::IsNullOrWhiteSpace($env:CLAWBOT_TUNNEL_TEST_PRODUCTION_CONFIG) -and
    [string]::Equals([IO.Path]::GetFullPath($LiteralPath), [IO.Path]::GetFullPath($env:CLAWBOT_TUNNEL_TEST_PRODUCTION_CONFIG), [StringComparison]::OrdinalIgnoreCase)
  $ownerOnly = $isProductionConfig -and $global:scenario -ne 'production-config-system-acl'
  New-ProtectedAcl -OwnerOnly:$ownerOnly
}
`;
}

function createSupervisorWrapper(fixture) {
  prepareOwnedTunnelDirectories(fixture);
  const path = join(fixture.root, 'run-supervisor-shim.ps1');
  write(path, `
param([string]$Scenario = 'healthy', [int]$Cycles = 1, [int]$MaxBytes = 1048576)
$ErrorActionPreference = 'Stop'
$global:scenario = $Scenario
$global:trace = $env:CLAWBOT_TUNNEL_TEST_TRACE
$global:taskChecks = 0
$global:ownerChecks = 0
$global:healthChecks = 0
$global:childStarted = $false
$global:originCreation = '20260905010101.000000+000'
$global:childCreation = '20260905010202.000000+000'
function Add-Trace([string]$Line) { [IO.File]::AppendAllText($global:trace, $Line + [Environment]::NewLine) }
${protectedAclPowerShell()}
function Get-NetTCPConnection {
  [CmdletBinding()]
  param([string]$State, [int]$LocalPort)
  $global:ownerChecks += 1
  Add-Trace ('OWNER ' + $global:ownerChecks)
  if ($global:scenario -eq 'absent' -or $global:scenario -eq 'native-containment') { return @() }
  if ($global:scenario -eq 'wildcard') { return ,([pscustomobject]@{ LocalAddress = '0.0.0.0'; OwningProcess = 500 }) }
  if ($global:scenario -eq 'multiple') { return @([pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 500 }, [pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 501 }) }
  if ($global:scenario -eq 'race' -and $global:ownerChecks -gt 1) { return ,([pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 501 }) }
  if ($global:scenario -eq 'late-absent' -and $global:ownerChecks -ge 3) { return @() }
  if ($global:scenario -eq 'late-wildcard' -and $global:ownerChecks -ge 3) { return ,([pscustomobject]@{ LocalAddress = '0.0.0.0'; OwningProcess = 500 }) }
  if ($global:scenario -eq 'late-multiple' -and $global:ownerChecks -ge 3) { return @([pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 500 }, [pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 501 }) }
  if ($global:scenario -eq 'late-race' -and $global:ownerChecks -ge 3) {
    $latePid = if (($global:ownerChecks % 2) -eq 0) { 501 } else { 500 }
    return ,([pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = $latePid })
  }
  return ,([pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 500 })
}
function Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName, [string]$Filter)
  if ($ClassName -ne 'Win32_Process') { return @() }
  if ($Filter -like '*Name=*cloudflared.exe*') {
    if ($global:scenario -eq 'unknown-cloudflared') {
      return ,([pscustomobject]@{ ProcessId = 900; CreationDate = 'unknown'; ExecutablePath = $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED; CommandLine = 'unrelated tunnel' })
    }
    if ($global:childStarted) {
      $own = [pscustomobject]@{ ProcessId = 700; CreationDate = $global:childCreation; ExecutablePath = $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED; CommandLine = ('"' + $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED + '" tunnel --config "' + $env:CLAWBOT_TUNNEL_TEST_CONFIG + '" run') }
      if ($global:scenario -eq 'cloudflared-race') {
        return @($own, [pscustomobject]@{ ProcessId = 900; CreationDate = 'unknown'; ExecutablePath = $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED; CommandLine = 'unrelated tunnel' })
      }
      return ,$own
    }
    return @()
  }
  if ($Filter -like '*700*') {
    if ($global:scenario -eq 'startup-identity-mismatch') { return @() }
    $path = if ($global:scenario -eq 'child-identity-change' -and $global:healthChecks -ge 3) { Join-Path ([IO.Path]::GetDirectoryName($env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED)) 'other.exe' } else { $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED }
    $creation = if ($global:scenario -eq 'pid-reused' -and $global:healthChecks -ge 3) { '20260905090909.000000+000' } else { $global:childCreation }
    return ,([pscustomobject]@{ ProcessId = 700; CreationDate = $creation; ExecutablePath = $path; CommandLine = ('"' + $path + '" tunnel --config "' + $env:CLAWBOT_TUNNEL_TEST_CONFIG + '" run') })
  }
  $pidValue = if ($Filter -like '*501*') { 501 } else { 500 }
  $lateOwnerMismatch = $global:ownerChecks -ge 3
  $path = if ($global:scenario -eq 'wrong-executable' -or ($global:scenario -eq 'late-wrong-executable' -and $lateOwnerMismatch)) { Join-Path ([IO.Path]::GetDirectoryName($env:CLAWBOT_TUNNEL_TEST_EZBOOKKEEPING)) 'other.exe' } else { $env:CLAWBOT_TUNNEL_TEST_EZBOOKKEEPING }
  $config = if ($global:scenario -eq 'wrong-config' -or ($global:scenario -eq 'late-wrong-config' -and $lateOwnerMismatch)) { Join-Path ([IO.Path]::GetDirectoryName($env:CLAWBOT_TUNNEL_TEST_PRODUCTION_CONFIG)) 'other.ini' } else { $env:CLAWBOT_TUNNEL_TEST_PRODUCTION_CONFIG }
  $creation = if ($pidValue -eq 501) { '20260905010102.000000+000' } else { $global:originCreation }
  return ,([pscustomobject]@{ ProcessId = $pidValue; CreationDate = $creation; ExecutablePath = $path; CommandLine = ('"' + $path + '" --conf-path "' + $config + '" server run') })
}
function Invoke-RestMethod {
  [CmdletBinding()]
  param([string]$Uri, [int]$MaximumRedirection, [int]$TimeoutSec)
  $global:healthChecks += 1
  Add-Trace ('HEALTH ' + $global:healthChecks)
  if ($global:scenario -eq 'unhealthy' -or (($global:scenario -eq 'degrade' -or $global:scenario -eq 'late-unhealthy' -or $global:scenario -eq 'child-identity-change') -and $global:healthChecks -ge 3)) {
    throw 'SENSITIVE-TOKEN user=fixture&transaction=secret'
  }
  [pscustomobject]@{ success = $true }
}
function Invoke-WebRequest {
  [CmdletBinding()]
  param([string]$Uri, [switch]$UseBasicParsing, [int]$MaximumRedirection, [int]$TimeoutSec)
  if ($global:scenario -eq 'wrong-page' -or ($global:scenario -eq 'late-wrong-page' -and $global:healthChecks -ge 3)) { return [pscustomobject]@{ Content = '<html>other application</html>' } }
  [pscustomobject]@{ Content = '<html><title>ezBookkeeping</title></html>' }
}
function Start-Process {
  [CmdletBinding()]
  param([string]$FilePath, [object[]]$ArgumentList, [string]$RedirectStandardOutput, [string]$RedirectStandardError, [switch]$PassThru, [string]$WindowStyle)
  throw 'The supervisor must not use Start-Process for a Tunnel child.'
}
function Get-AuthenticodeSignature {
  [CmdletBinding()]
  param([string]$FilePath)
  if ($global:scenario -eq 'invalid-signature') {
    return [pscustomobject]@{ Status = 'NotSigned'; SignerCertificate = $null }
  }
  [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = 'CN="Cloudflare, Inc.", O="Cloudflare, Inc.", C=US' } }
}
function Stop-Process {
  [CmdletBinding()]
  param([int]$Id, [switch]$Force)
  if ($Id -ne 700) { throw 'Attempted to stop an unknown process.' }
  Add-Trace ('STOP ' + $Id)
  $global:childStarted = $false
}
function Start-Sleep {
  [CmdletBinding()]
  param([int]$Seconds, [int]$Milliseconds)
  Add-Trace 'SLEEP'
  if ($global:scenario -eq 'config-drift' -and $global:healthChecks -eq 3) {
    $text = [IO.File]::ReadAllText($env:CLAWBOT_TUNNEL_TEST_CONFIG)
    $text = $text.Replace('11111111-2222-4333-8444-555555555555', '66666666-7777-4888-8999-aaaaaaaaaaaa')
    [IO.File]::WriteAllText($env:CLAWBOT_TUNNEL_TEST_CONFIG, $text, (New-Object Text.UTF8Encoding($false)))
  }
}
$supervisorArguments = @{
  CommonScriptPath = $env:CLAWBOT_TUNNEL_TEST_COMMON
  RuntimeDirectory = $env:CLAWBOT_TUNNEL_TEST_RUNTIME
  CloudflaredPath = $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED
  ExpectedCloudflaredSha256 = $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED_SHA256
  TunnelConfigPath = $env:CLAWBOT_TUNNEL_TEST_CONFIG
  EzBookkeepingExecutable = $env:CLAWBOT_TUNNEL_TEST_EZBOOKKEEPING
  EzBookkeepingConfigPath = $env:CLAWBOT_TUNNEL_TEST_PRODUCTION_CONFIG
  LogPath = $env:CLAWBOT_TUNNEL_TEST_LOG
  PollSeconds = 1
  StabilityDelayMilliseconds = 1
  MaxLogBytes = $MaxBytes
  MaxCycles = $Cycles
  ContainedProcessLauncher = {
    param($Executable, $CommandLine)
    Add-Trace 'CREATE_SUSPENDED 700'
    if ($global:scenario -eq 'containment-assign-failure') {
      Add-Trace 'TERMINATE 700'
      throw 'Injected containment failure.'
    }
    Add-Trace 'CONTAIN 700'
    if ($global:scenario -eq 'containment-resume-failure') {
      Add-Trace 'TERMINATE 700'
      throw 'Injected resume failure.'
    }
    Add-Trace 'RESUME 700'
    $global:childStarted = $true
    Add-Trace ('START ' + $CommandLine)
    [pscustomobject]@{ Id = 700; HasExited = $false; ExitCode = 0 }
  }
  ContainedProcessStopper = { param($Process) if ($Process.Id -ne 700) { throw 'Attempted to stop an unknown process.' }; Add-Trace ('STOP ' + $Process.Id); $global:childStarted = $false }
}
if ($Scenario -eq 'default-common') { $supervisorArguments.Remove('CommonScriptPath') }
if ($Scenario -eq 'native-containment') { $supervisorArguments.Remove('ContainedProcessLauncher'); $supervisorArguments.Remove('ContainedProcessStopper') }
& $env:CLAWBOT_TUNNEL_TEST_SUPERVISOR @supervisorArguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`);
  return path;
}

function createInstallerWrapper(fixture) {
  const path = join(fixture.root, 'run-installer-shim.ps1');
  write(path, `
param([string]$Scenario = 'whatif')
$ErrorActionPreference = 'Stop'
$global:scenario = $Scenario
$global:trace = $env:CLAWBOT_TUNNEL_TEST_TRACE
$global:taskChecks = 0
$global:registered = $false
function Add-Trace([string]$Line) { [IO.File]::AppendAllText($global:trace, $Line + [Environment]::NewLine) }
${protectedAclPowerShell()}
if ($Scenario -eq 'unsafe-acl') {
  function Get-Acl { [CmdletBinding()] param([string]$LiteralPath) [pscustomobject]@{ AreAccessRulesProtected = $false; Access = @([pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = 'Everyone' }; AccessControlType = 'Allow'; FileSystemRights = 'FullControl'; IsInherited = $true }) } }
}
if ($Scenario -eq 'wrong-owner') {
  function Get-Acl {
    [CmdletBinding()]
    param([string]$LiteralPath)
    $acl = New-ProtectedAcl
    $acl.Owner = 'OTHER\\User'
    $acl
  }
}
function Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName, [string]$Filter)
  if ($global:scenario -eq 'service-conflict' -and $ClassName -eq 'Win32_Service') {
    return ,([pscustomobject]@{ Name = 'cloudflared'; DisplayName = 'Cloudflared'; PathName = $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED })
  }
  @()
}
function New-ExactInstallerTask([switch]$WrongPrincipal, [switch]$DifferentSidPrincipal, [switch]$SidPrincipal, [switch]$ShortPrincipal) {
  $runtime = [IO.Path]::GetFullPath($env:CLAWBOT_TUNNEL_TEST_RUNTIME).TrimEnd('\\')
  $installedSupervisor = Join-Path $runtime 'ledger-tunnel-supervisor.ps1'
  $installedCommon = Join-Path $runtime 'ledger-runtime-common.ps1'
  $launcher = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass' +
    ' -File "' + $installedSupervisor + '"' +
    ' -CommonScriptPath "' + $installedCommon + '"' +
    ' -RuntimeDirectory "' + $runtime + '"' +
    ' -CloudflaredPath "' + $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED + '"' +
    ' -ExpectedCloudflaredSha256 ' + $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED_SHA256 +
    ' -TunnelConfigPath "' + $env:CLAWBOT_TUNNEL_TEST_CONFIG + '"' +
    ' -EzBookkeepingExecutable "' + $env:CLAWBOT_TUNNEL_TEST_EZBOOKKEEPING + '"' +
    ' -EzBookkeepingConfigPath "' + $env:CLAWBOT_TUNNEL_TEST_PRODUCTION_CONFIG + '"' +
    ' -LogPath "' + $env:CLAWBOT_TUNNEL_TEST_LOG + '"'
  [pscustomobject]@{
    TaskName = 'Clawbot Ledger Tunnel'
    TaskPath = '\\'
    Actions = @([pscustomobject]@{ Execute = $launcher; Arguments = $arguments; WorkingDirectory = $runtime })
    Principal = [pscustomobject]@{ UserId = $(if ($WrongPrincipal) { 'OTHER\\User' } elseif ($DifferentSidPrincipal) { 'S-1-5-18' } elseif ($SidPrincipal) { [Security.Principal.WindowsIdentity]::GetCurrent().User.Value } elseif ($ShortPrincipal) { $user.Split('\\')[-1] } else { $user }); LogonType = 'Interactive'; RunLevel = 'Limited' }
    Triggers = @([pscustomobject]@{ CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' }; UserId = $(if ($SidPrincipal) { [Security.Principal.WindowsIdentity]::GetCurrent().User.Value } elseif ($ShortPrincipal) { $user.Split('\\')[-1] } else { $user }); Enabled = $true })
    Settings = [pscustomobject]@{ Enabled = $true; MultipleInstances = 'IgnoreNew'; RestartCount = 999; RestartInterval = 'PT1M'; ExecutionTimeLimit = 'PT0S'; StartWhenAvailable = $true; DisallowStartIfOnBatteries = $false; StopIfGoingOnBatteries = $false }
  }
}
function Get-ScheduledTask {
  [CmdletBinding()]
  param()
  $global:taskChecks += 1
  if ($global:scenario -eq 'task-conflict') {
    return ,([pscustomobject]@{ TaskName = 'Foreign tunnel'; TaskPath = '\\'; Actions = @([pscustomobject]@{ Execute = $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED; Arguments = 'tunnel run'; WorkingDirectory = $env:CLAWBOT_TUNNEL_TEST_RUNTIME }) })
  }
  if ($global:scenario -eq 'task-case-conflict') {
    return ,([pscustomobject]@{ TaskName = 'clawbot ledger tunnel'; TaskPath = '\\'; Actions = @([pscustomobject]@{ Execute = 'foreign.exe'; Arguments = 'foreign'; WorkingDirectory = $env:CLAWBOT_TUNNEL_TEST_RUNTIME }) })
  }
  if ($global:scenario -eq 'whatif-unrelated-non-exec-task') {
    return ,([pscustomobject]@{ TaskName = 'Unrelated COM task'; TaskPath = '\\'; Actions = @([pscustomobject]@{ ClassId = '{00000000-0000-0000-0000-000000000000}'; Data = 'fixture' }) })
  }
  if ($global:scenario -eq 'task-non-exec-name-conflict') {
    return ,([pscustomobject]@{ TaskName = 'Clawbot Ledger Tunnel'; TaskPath = '\\'; Actions = @([pscustomobject]@{ ClassId = '{00000000-0000-0000-0000-000000000000}'; Data = 'fixture' }) })
  }
  if ($global:scenario -eq 'task-race' -and $global:taskChecks -gt 1) {
    return ,([pscustomobject]@{ TaskName = 'Clawbot Ledger Tunnel'; TaskPath = '\\'; Actions = @([pscustomobject]@{ Execute = 'foreign.exe'; Arguments = 'foreign'; WorkingDirectory = $env:CLAWBOT_TUNNEL_TEST_RUNTIME }) })
  }
  if ($global:scenario -eq 'task-principal-conflict') { return ,(New-ExactInstallerTask -WrongPrincipal) }
  if ($global:scenario -eq 'task-principal-sid-conflict') { return ,(New-ExactInstallerTask -DifferentSidPrincipal) }
  if ($global:scenario -eq 'exact-task') { return ,(New-ExactInstallerTask) }
  if ($global:scenario -eq 'exact-task-principal-sid') { return ,(New-ExactInstallerTask -SidPrincipal) }
  if ($global:scenario -eq 'exact-task-principal-short-name') { return ,(New-ExactInstallerTask -ShortPrincipal) }
  if ($global:registered) {
    Add-Trace 'TASK_REVALIDATE'
    if ($global:scenario -eq 'post-register-task-race') {
      return ,([pscustomobject]@{ TaskName = 'Clawbot Ledger Tunnel'; TaskPath = '\\'; Actions = @([pscustomobject]@{ Execute = 'foreign.exe'; Arguments = 'foreign'; WorkingDirectory = $env:CLAWBOT_TUNNEL_TEST_RUNTIME }) })
    }
    return ,(New-ExactInstallerTask)
  }
  @()
}
function Get-AuthenticodeSignature {
  [CmdletBinding()]
  param([string]$FilePath)
  if ($global:scenario -eq 'invalid-signature') { return [pscustomobject]@{ Status = 'NotSigned'; SignerCertificate = $null } }
  [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = 'CN="Cloudflare, Inc.", O="Cloudflare, Inc.", C=US' } }
}
function Start-Process {
  [CmdletBinding()]
  param([string]$FilePath, [object[]]$ArgumentList, [switch]$Wait, [switch]$PassThru, [string]$WindowStyle)
  Add-Trace ('VALIDATE ' + ([string[]]$ArgumentList -join '|'))
  [pscustomobject]@{ ExitCode = $(if ($global:scenario -eq 'validator-failure') { 9 } else { 0 }) }
}
function New-ScheduledTaskAction {
  [CmdletBinding()]
  param([string]$Execute, [string]$Argument, [string]$WorkingDirectory)
  Add-Trace ('ACTION ' + $Execute + ' ' + $Argument + ' WORKDIR=' + $WorkingDirectory)
  [pscustomobject]@{ Execute = $Execute; Arguments = $Argument; WorkingDirectory = $WorkingDirectory }
}
function New-ScheduledTaskTrigger { [CmdletBinding()] param([switch]$AtLogOn, [string]$User) Add-Trace ('TRIGGER ' + $AtLogOn + ' ' + $User); [pscustomobject]@{} }
function New-ScheduledTaskSettingsSet { [CmdletBinding()] param([int]$RestartCount, [TimeSpan]$RestartInterval, [TimeSpan]$ExecutionTimeLimit, [string]$MultipleInstances, [switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries) Add-Trace ('SETTINGS ' + $RestartCount + ' ' + $MultipleInstances); [pscustomobject]@{} }
function New-ScheduledTaskPrincipal { [CmdletBinding()] param([string]$UserId, [string]$LogonType, [string]$RunLevel) Add-Trace ('PRINCIPAL ' + $LogonType + ' ' + $RunLevel); [pscustomobject]@{} }
function Register-ScheduledTask { [CmdletBinding()] param([string]$TaskName, [object]$Action, [object]$Trigger, [object]$Settings, [object]$Principal, [switch]$Force) Add-Trace ('REGISTER ' + $TaskName + ' FORCE=' + [bool]$Force); $global:registered = $true }
function Start-ScheduledTask { [CmdletBinding()] param([object]$InputObject) Add-Trace ('START_TASK ' + $InputObject.TaskName) }
function Set-Acl {
  [CmdletBinding()]
  param([string]$LiteralPath, [object]$AclObject)
  $ownerMatches = $false
  try {
    $actualOwner = $AclObject.GetOwner([Security.Principal.SecurityIdentifier])
    $ownerMatches = $actualOwner.Equals([Security.Principal.WindowsIdentity]::GetCurrent().User)
  } catch {}
  Add-Trace ('ACL ' + [IO.Path]::GetFileName($LiteralPath) + ' OWNER_CURRENT=' + $ownerMatches)
}
if ($Scenario -eq 'whatif') {
  function Start-Process { throw 'WhatIf launched cloudflared.' }
  function New-ScheduledTaskAction { throw 'WhatIf constructed a task.' }
  function New-ScheduledTaskTrigger { throw 'WhatIf constructed a task.' }
  function New-ScheduledTaskSettingsSet { throw 'WhatIf constructed a task.' }
  function New-ScheduledTaskPrincipal { throw 'WhatIf constructed a task.' }
  function Register-ScheduledTask { throw 'WhatIf registered a task.' }
  function Start-ScheduledTask { throw 'WhatIf started a task.' }
  function Set-Acl { throw 'WhatIf changed an ACL.' }
}
$requestedTaskName = if ($Scenario -eq 'bad-task-name') { 'Other Tunnel Task' } else { 'Clawbot Ledger Tunnel' }
$requestedLogPath = if ($Scenario -eq 'log-collision') { $env:CLAWBOT_TUNNEL_TEST_CREDENTIAL } else { $env:CLAWBOT_TUNNEL_TEST_LOG }
$arguments = @{
  CloudflaredPath = $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED
  ExpectedCloudflaredSha256 = $(if ($Scenario -eq 'hash-mismatch') { 'F' * 64 } else { $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED_SHA256 })
  TunnelConfigPath = $env:CLAWBOT_TUNNEL_TEST_CONFIG
  CredentialPath = $env:CLAWBOT_TUNNEL_TEST_CREDENTIAL
  EzBookkeepingExecutable = $env:CLAWBOT_TUNNEL_TEST_EZBOOKKEEPING
  EzBookkeepingConfigPath = $env:CLAWBOT_TUNNEL_TEST_PRODUCTION_CONFIG
  RuntimeDirectory = $env:CLAWBOT_TUNNEL_TEST_RUNTIME
  LogPath = $requestedLogPath
  TaskName = $requestedTaskName
  Confirm = $false
}
if ($Scenario -in @('whatif', 'whatif-unrelated-non-exec-task')) { $arguments.WhatIf = $true }
if ($Scenario -in @('whatif', 'whatif-unrelated-non-exec-task', 'install-start', 'post-register-task-race')) { $arguments.StartAfterInstall = $true }
& $env:CLAWBOT_TUNNEL_TEST_INSTALLER @arguments
`);
  return path;
}

function createLocalCheckWrapper(fixture) {
  const path = join(fixture.root, 'run-local-check-shim.ps1');
  write(path, `
param([string]$Scenario = 'healthy')
$ErrorActionPreference = 'Stop'
$global:scenario = $Scenario
${protectedAclPowerShell()}
function Get-NetTCPConnection {
  [CmdletBinding()]
  param([string]$State, [int]$LocalPort)
  if ($LocalPort -eq 8888) {
    $address = if ($global:scenario -eq 'production-wildcard') { '0.0.0.0' } else { '127.0.0.1' }
    return ,([pscustomobject]@{ LocalAddress = $address; OwningProcess = 500 })
  }
  if ($LocalPort -eq 18888) { return ,([pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 501 }) }
  @()
}
function Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName, [string]$Filter)
  if ($ClassName -ne 'Win32_Process') { return @() }
  if ($Filter -like '*Name=*cloudflared.exe*') {
    return ,([pscustomobject]@{
      ProcessId = 700
      CreationDate = '20260905010202.000000+000'
      ExecutablePath = $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED
      CommandLine = ('"' + $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED + '" tunnel --config "' + $env:CLAWBOT_TUNNEL_TEST_CONFIG + '" run')
    })
  }
  if ($Filter -like '*501*') {
    $testExecutable = Join-Path $env:CLAWBOT_TUNNEL_TEST_TEST_ROOT 'ezbookkeeping.exe'
    return ,([pscustomobject]@{
      ProcessId = 501
      CreationDate = '20260905010102.000000+000'
      ExecutablePath = $testExecutable
      CommandLine = ('"' + $testExecutable + '" --conf-path "' + $env:CLAWBOT_TUNNEL_TEST_TEST_CONFIG + '" server run')
    })
  }
  return ,([pscustomobject]@{
    ProcessId = 500
    CreationDate = '20260905010101.000000+000'
    ExecutablePath = $env:CLAWBOT_TUNNEL_TEST_EZBOOKKEEPING
    CommandLine = ('"' + $env:CLAWBOT_TUNNEL_TEST_EZBOOKKEEPING + '" --conf-path "' + $env:CLAWBOT_TUNNEL_TEST_PRODUCTION_CONFIG + '" server run')
  })
}
function Invoke-RestMethod {
  [CmdletBinding()]
  param([string]$Uri, [int]$MaximumRedirection, [int]$TimeoutSec)
  [pscustomobject]@{ success = $true }
}
function Invoke-WebRequest {
  [CmdletBinding()]
  param([string]$Uri, [switch]$UseBasicParsing, [int]$MaximumRedirection, [int]$TimeoutSec)
  [pscustomobject]@{ Content = '<html><title>ezBookkeeping</title></html>' }
}
function Get-AuthenticodeSignature {
  [CmdletBinding()]
  param([string]$FilePath)
  [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = 'CN="Cloudflare, Inc.", O="Cloudflare, Inc.", C=US' } }
}
function Get-ScheduledTask {
  [CmdletBinding()]
  param()
  $runtime = [IO.Path]::GetFullPath($env:CLAWBOT_TUNNEL_TEST_RUNTIME).TrimEnd('\\')
  $installedSupervisor = Join-Path $runtime 'ledger-tunnel-supervisor.ps1'
  $installedCommon = Join-Path $runtime 'ledger-runtime-common.ps1'
  $launcher = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass' +
    ' -File "' + $installedSupervisor + '"' +
    ' -CommonScriptPath "' + $installedCommon + '"' +
    ' -RuntimeDirectory "' + $runtime + '"' +
    ' -CloudflaredPath "' + $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED + '"' +
    ' -ExpectedCloudflaredSha256 ' + $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED_SHA256 +
    ' -TunnelConfigPath "' + $env:CLAWBOT_TUNNEL_TEST_CONFIG + '"' +
    ' -EzBookkeepingExecutable "' + $env:CLAWBOT_TUNNEL_TEST_EZBOOKKEEPING + '"' +
    ' -EzBookkeepingConfigPath "' + $env:CLAWBOT_TUNNEL_TEST_PRODUCTION_CONFIG + '"' +
    ' -LogPath "' + $env:CLAWBOT_TUNNEL_TEST_LOG + '"'
  if ($global:scenario -eq 'wrong-task') { $arguments = '-File "foreign.ps1"' }
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $productionArguments = '--conf-path "' + $env:CLAWBOT_TUNNEL_TEST_PRODUCTION_CONFIG + '" server run'
  if ($global:scenario -eq 'wrong-production-task') { $productionArguments = 'server run' }
  $productionTask = [pscustomobject]@{
    TaskName = 'Clawbot ezBookkeeping'
    TaskPath = '\\'
    Actions = @([pscustomobject]@{
      Execute = $env:CLAWBOT_TUNNEL_TEST_EZBOOKKEEPING
      Arguments = $productionArguments
      WorkingDirectory = [IO.Path]::GetDirectoryName($env:CLAWBOT_TUNNEL_TEST_EZBOOKKEEPING)
    })
    Principal = [pscustomobject]@{ UserId = $currentUser; LogonType = 'Interactive'; RunLevel = 'Limited' }
    Triggers = @([pscustomobject]@{
      CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' }
      UserId = $currentUser
      Enabled = $true
    })
    Settings = [pscustomobject]@{
      Enabled = $true
      MultipleInstances = 'IgnoreNew'
      RestartCount = 3
      RestartInterval = 'PT1M'
      ExecutionTimeLimit = 'PT0S'
      StartWhenAvailable = $true
      DisallowStartIfOnBatteries = $false
      StopIfGoingOnBatteries = $false
    }
  }
  $tunnelTask = [pscustomobject]@{
    TaskName = 'Clawbot Ledger Tunnel'
    TaskPath = '\\'
    Actions = @([pscustomobject]@{ Execute = $launcher; Arguments = $arguments; WorkingDirectory = $runtime })
    Principal = [pscustomobject]@{
      UserId = $currentUser
      LogonType = 'Interactive'
      RunLevel = 'Limited'
    }
    Triggers = @([pscustomobject]@{
      CimClass = [pscustomobject]@{ CimClassName = 'MSFT_TaskLogonTrigger' }
      UserId = $currentUser
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
  if ($global:scenario -eq 'principal-sid') {
    $tunnelTask.Principal.UserId = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $tunnelTask.Triggers[0].UserId = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  }
  if ($global:scenario -eq 'principal-short-name') {
    $tunnelTask.Principal.UserId = $currentUser.Split('\\')[-1]
    $tunnelTask.Triggers[0].UserId = $currentUser.Split('\\')[-1]
  }
  return @($productionTask, $tunnelTask)
}
$localArguments = @{
  ReleasePath = $env:CLAWBOT_TUNNEL_TEST_RELEASE
  CommonScriptPath = $env:CLAWBOT_TUNNEL_TEST_COMMON
  ReleaseVerifierPath = $env:CLAWBOT_TUNNEL_TEST_RELEASE_VERIFIER
  CloudflaredPath = $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED
  ExpectedCloudflaredSha256 = $env:CLAWBOT_TUNNEL_TEST_CLOUDFLARED_SHA256
  TunnelConfigPath = $env:CLAWBOT_TUNNEL_TEST_CONFIG
  CredentialPath = $env:CLAWBOT_TUNNEL_TEST_CREDENTIAL
  EzBookkeepingExecutable = $env:CLAWBOT_TUNNEL_TEST_EZBOOKKEEPING
  EzBookkeepingConfigPath = $env:CLAWBOT_TUNNEL_TEST_PRODUCTION_CONFIG
  TestInstallDirectory = $env:CLAWBOT_TUNNEL_TEST_TEST_ROOT
  TestConfigPath = $env:CLAWBOT_TUNNEL_TEST_TEST_CONFIG
  TunnelRuntimeDirectory = $env:CLAWBOT_TUNNEL_TEST_RUNTIME
  TunnelLogPath = $env:CLAWBOT_TUNNEL_TEST_LOG
  TunnelTaskName = 'Clawbot Ledger Tunnel'
}
if ($Scenario -eq 'default-helpers') {
  $localArguments.Remove('CommonScriptPath')
  $localArguments.Remove('ReleaseVerifierPath')
}
& $env:CLAWBOT_TUNNEL_TEST_LOCAL @localArguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`);
  return path;
}

test('copied supervisor fixtures use unique test mutexes instead of the production mutex', () => {
  const first = createFixture();
  const second = createFixture();
  try {
    const bundledSupervisor = join(first.root, 'bundle', 'ledger-tunnel-supervisor.ps1');
    writeEnvironmentIsolatedScript(supervisorScript, bundledSupervisor, 'Get-TunnelEnvironmentVariables', first.supervisorMutexName);
    const names = [first.isolatedSupervisorPath, second.isolatedSupervisorPath, bundledSupervisor].map((path) => {
      const source = readFileSync(path, 'utf8');
      assert.equal(source.includes('Global\\ClawbotLedgerTunnelSupervisor'), false, 'fixture still contains the production mutex');
      const name = source.match(/New-Object System\.Threading\.Mutex\(\$false, '(Local\\ClawbotLedgerTunnelTest-[0-9a-f]{64})'\)/u)?.[1];
      assert.ok(name, 'fixture must retain a real mutex with a synthetic local name');
      return name;
    });
    assert.notEqual(names[0], names[1]);
    assert.equal(names[0], names[2], 'all supervisor copies within one fixture must share its mutex');
    assert.equal(
      createHash('sha256').update(readFileSync(first.isolatedSupervisorPath)).digest('hex'),
      createHash('sha256').update(readFileSync(bundledSupervisor)).digest('hex'),
      'bundled and installed supervisor copies within one fixture must be byte-identical',
    );
    assert.equal(readFileSync(supervisorScript, 'utf8').includes('Global\\ClawbotLedgerTunnelSupervisor'), true);
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test('fixture mutexes reject a same-fixture contender while different fixtures remain independent', () => {
  const first = createFixture();
  const second = createFixture();
  try {
    const bundledSupervisor = join(first.root, 'bundle', 'ledger-tunnel-supervisor.ps1');
    writeEnvironmentIsolatedScript(supervisorScript, bundledSupervisor, 'Get-TunnelEnvironmentVariables', first.supervisorMutexName);
    // Check every copy before starting any PowerShell process or touching a mutex.
    for (const path of [first.isolatedSupervisorPath, second.isolatedSupervisorPath, bundledSupervisor]) {
      assert.equal(readFileSync(path, 'utf8').includes('Global\\ClawbotLedgerTunnelSupervisor'), false, 'fixture still contains the production mutex');
    }
    const probePath = join(first.root, 'fixture-mutex-probe.ps1');
    write(probePath, String.raw`
param([string]$FirstCopy, [string]$SameFixtureCopy, [string]$SecondCopy, [ValidateSet('Hold', 'Try')][string]$Mode)
$ErrorActionPreference = 'Stop'
$tokens = $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($FirstCopy, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'Fixture source parse failed.' }
foreach ($name in @('Enter-TunnelSupervisorMutex', 'Exit-TunnelSupervisorMutex')) {
  $definitions = @($ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
  }, $true))
  if ($definitions.Count -ne 1) { throw 'Expected exactly one mutex helper.' }
  $definition = $definitions[0].Extent.Text
  if ($name -ceq 'Enter-TunnelSupervisorMutex' -and
      ($definition.Contains('Global\ClawbotLedgerTunnelSupervisor') -or
       $definition -notmatch "'Local\\ClawbotLedgerTunnelTest-[0-9a-f]{64}'")) {
    throw 'Refusing a mutex outside the synthetic fixture namespace.'
  }
  . ([scriptblock]::Create($definition))
}
$script:TunnelMutex = $null
$script:TunnelMutexOwned = $false
try {
  Enter-TunnelSupervisorMutex
  if ($Mode -ceq 'Try') {
    Write-Output 'acquired'
  } else {
    $powershell = Join-Path $PSHOME 'powershell.exe'
    $same = & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath -FirstCopy $SameFixtureCopy -Mode Try
    if ($LASTEXITCODE -ne 0) { throw 'Same-fixture mutex probe failed.' }
    $different = & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath -FirstCopy $SecondCopy -Mode Try
    if ($LASTEXITCODE -ne 0) { throw 'Different-fixture mutex probe failed.' }
    [ordered]@{ sameFixture = $same; differentFixture = $different } | ConvertTo-Json -Compress
  }
} catch {
  if ($Mode -ceq 'Try' -and $_.Exception.Message -ceq 'Another Ledger Tunnel supervisor already owns the runtime.') {
    Write-Output 'refused_existing_owner'
  } else { throw 'Synthetic mutex probe failed.' }
} finally {
  Exit-TunnelSupervisorMutex
}
`);
    const result = runPowerShell(probePath, [
      '-FirstCopy', first.isolatedSupervisorPath,
      '-SameFixtureCopy', bundledSupervisor,
      '-SecondCopy', second.isolatedSupervisorPath,
      '-Mode', 'Hold',
    ]);
    assertSucceeded(result);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      sameFixture: 'refused_existing_owner',
      differentFixture: 'acquired',
    });
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test('ships only the exact sanitized locally managed Ledger ingress', () => {
  const text = readFileSync(exampleConfig, 'utf8');
  assert.match(text, /^tunnel: __LOCAL_TUNNEL_UUID__$/mu);
  assert.match(text, /^credentials-file: '__LOCAL_TUNNEL_CREDENTIAL_JSON__'$/mu);
  assert.match(text, /^no-autoupdate: true$/mu);
  assert.match(text, /^\s+- hostname: ledger\.66ccff-labs\.com$/mu);
  assert.match(text, /^\s+service: http:\/\/127\.0\.0\.1:8888$/mu);
  assert.match(text, /^\s+- service: http_status:404$/mu);
  assert.equal((text.match(/^\s+- (?:hostname|service):/gmu) ?? []).length, 2);
  assert.doesNotMatch(text, /(?:token|account|zone|cert|[0-9a-f]{8}-[0-9a-f-]{27,})/iu);
  assert.doesNotMatch(text, /(?:localhost|0\.0\.0\.0|www\.|^\s*- hostname:\s*66ccff-labs\.com\s*$)/imu);
});

test('all tunnel scripts parse in Windows PowerShell 5.1 and retain narrow source contracts', () => {
  for (const scriptPath of [supervisorScript, installerScript, localTestScript]) {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$tokens = $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object Message; exit 1 }`,
    ], { encoding: 'utf8', windowsHide: true });
    assertSucceeded(result);
  }

  const supervisor = readFileSync(supervisorScript, 'utf8');
  const installer = readFileSync(installerScript, 'utf8');
  const local = readFileSync(localTestScript, 'utf8');
  for (const source of [supervisor, installer, local]) {
    const parameterBlock = source.match(/^param\(([\s\S]*?)^\)$/mu)?.[1] ?? '';
    assert.notEqual(parameterBlock, '');
    assert.doesNotMatch(parameterBlock, /Join-Path\s+\$PSScriptRoot/iu);
  }
  assert.match(supervisor, /Get-LedgerListenerOwner/);
  assert.match(supervisor, /Test-LedgerOrigin/);
  assert.match(supervisor, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(supervisor, /ClawbotLedgerTunnelSupervisor/);
  assert.match(supervisor, /tunnel.+--config.+run/su);
  assert.match(supervisor, /CREATE_SUSPENDED\s*\|\s*CREATE_NO_WINDOW/u);
  assert.match(supervisor, /CreateProcessW\([\s\S]*?false,[\s\S]*?CREATE_SUSPENDED\s*\|\s*CREATE_NO_WINDOW/u);
  assert.doesNotMatch(supervisor, /CREATE_BREAKAWAY_FROM_JOB/u);
  assert.doesNotMatch(supervisor, /--token|service\s+install/iu);
  assert.doesNotMatch(supervisor, /Stop-(?:Service|ScheduledTask)/u);
  assert.match(installer, /CmdletBinding\s*\(\s*SupportsShouldProcess/iu);
  assert.doesNotMatch(installer, /cloudflared(?:\.exe)?[^\r\n]*(?:service\s+install|--token)/iu);
  assert.doesNotMatch(local, /(?:Set-|New-|Remove-|Stop-|Start-)(?:ScheduledTask|Service|Process|Item)|Register-ScheduledTask/u);
  assert.match(
    supervisor,
    /function Get-TunnelEnvironmentVariables[\s\S]+?\[Environment\]::GetEnvironmentVariables\(\$Target\)/u,
  );
  assert.match(
    local,
    /function Get-LocalEnvironmentVariables[\s\S]+?\[Environment\]::GetEnvironmentVariables\(\$Target\)/u,
  );
  for (const source of [supervisor, local]) {
    const parameterBlock = source.match(/^param\(([\s\S]*?)^\)$/mu)?.[1] ?? '';
    assert.doesNotMatch(parameterBlock, /environment(?:variable)?provider|environmentaudit|testenvironment|bypass/iu);
    assert.doesNotMatch(source, /CLAWBOT_[A-Z0-9_]*(?:ENVIRONMENT|OVERRIDE|BYPASS)/u);
  }
});

test('tunnel runtime pins its binary, rejects environment overrides, owns dedicated paths, and never stops by PID', () => {
  const supervisor = readFileSync(supervisorScript, 'utf8');
  const installer = readFileSync(installerScript, 'utf8');
  const local = readFileSync(localTestScript, 'utf8');
  const combined = `${supervisor}\n${installer}\n${local}`;

  for (const source of [supervisor, installer, local]) {
    assert.match(source, /ExpectedCloudflaredSha256/u);
    assert.match(source, /Get-AuthenticodeSignature/u);
    assert.match(source, /Cloudflare, Inc\./u);
  }
  assert.match(combined, /TUNNEL_/u);
  assert.match(combined, /NO_AUTOUPDATE/u);
  assert.match(combined, /ReparsePoint/u);
  assert.match(combined, /CLAWBOT_LEDGER_TUNNEL_RUNTIME_V1/u);
  assert.match(combined, /CLAWBOT_LEDGER_TUNNEL_LOG_V1/u);
  assert.doesNotMatch(supervisor, /\bStop-Process\b/u);
  assert.doesNotMatch(installer, /Register-ScheduledTask[^\r\n]*-Force/u);
  assert.match(installer, /StringComparison\]::OrdinalIgnoreCase/u);
});

test('PowerShell 5.1 resolves adjacent helper defaults after parameter binding', () => {
  const fixture = createFixture();
  const bundleRoot = mkdtempSync(join(tmpdir(), 'clawbot-ledger-bundle-'));
  const bundle = join(bundleRoot, 'scripts');
  try {
    const bundledSupervisor = join(bundle, 'ledger-tunnel-supervisor.ps1');
    const bundledInstaller = join(bundle, 'install-ledger-tunnel-task.ps1');
    const bundledLocal = join(bundle, 'test-ledger-local.ps1');
    writeEnvironmentIsolatedScript(
      supervisorScript,
      bundledSupervisor,
      'Get-TunnelEnvironmentVariables',
      fixture.supervisorMutexName,
    );
    write(bundledInstaller, readFileSync(installerScript, 'utf8'));
    writeEnvironmentIsolatedScript(localTestScript, bundledLocal, 'Get-LocalEnvironmentVariables');
    write(join(bundle, 'ledger-runtime-common.ps1'), readFileSync(commonScript, 'utf8'));
    write(join(bundle, 'verify-openclaw-release.ps1'), readFileSync(fixture.releaseVerifierPath, 'utf8'));

    const supervisorWrapper = createSupervisorWrapper(fixture);
    assertSucceeded(runPowerShell(supervisorWrapper, ['default-common', '1'], fixtureEnv(fixture, {
      CLAWBOT_TUNNEL_TEST_SUPERVISOR: bundledSupervisor,
    })));

    const installerWrapper = createInstallerWrapper(fixture);
    assertSucceeded(runPowerShell(installerWrapper, ['whatif'], fixtureEnv(fixture, {
      CLAWBOT_TUNNEL_TEST_INSTALLER: bundledInstaller,
    })));

    const localWrapper = createLocalCheckWrapper(fixture);
    prepareLocalRuntimeFixture(fixture);
    const localResult = runPowerShell(localWrapper, ['default-helpers'], fixtureEnv(fixture, {
      CLAWBOT_TUNNEL_TEST_LOCAL: bundledLocal,
    }));
    assertSucceeded(localResult);
    assert.equal(Object.values(JSON.parse(localResult.stdout.trim())).every((value) => value === 'pass'), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(bundleRoot, { recursive: true, force: true });
  }
});

test('supervisor double-checks before and after start and passes no credential argument', () => {
  const fixture = createFixture();
  try {
    const wrapper = createSupervisorWrapper(fixture);
    const result = runPowerShell(wrapper, ['healthy', '1'], fixtureEnv(fixture));
    assert.equal(
      result.status,
      0,
      `${result.stderr || result.stdout}\nTRACE:\n${existsSync(fixture.tracePath) ? readFileSync(fixture.tracePath, 'utf8') : ''}\nLOG:\n${existsSync(fixture.logPath) ? readFileSync(fixture.logPath, 'utf8') : ''}`,
    );
    const trace = readFileSync(fixture.tracePath, 'utf8').trim().split(/\r?\n/u);
    assert.equal(trace.filter((line) => line.startsWith('OWNER ')).length >= 4, true);
    assert.equal(trace.filter((line) => line.startsWith('HEALTH ')).length >= 4, true);
    const createIndex = trace.indexOf('CREATE_SUSPENDED 700');
    const containIndex = trace.indexOf('CONTAIN 700');
    const resumeIndex = trace.indexOf('RESUME 700');
    const start = trace.find((line) => line.startsWith('START '));
    assert.ok(start);
    assert.ok(createIndex >= 0);
    assert.ok(containIndex > createIndex);
    assert.ok(resumeIndex > containIndex);
    assert.ok(trace.indexOf(start) > resumeIndex);
    assert.ok(trace.some((line) => line === 'CONTAIN 700'));
    assert.match(start, /" tunnel --config ".*ledger\.yml" run$/u);
    assert.equal(start.includes(fixture.credentialPath), false);
    assert.doesNotMatch(start, /token/iu);
    assert.deepEqual(trace.filter((line) => line.startsWith('STOP ')), ['STOP 700']);
    for (const line of readFileSync(fixture.logPath, 'utf8').trim().split(/\r?\n/u)) {
      assert.match(line, /^timestamp=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z event=[A-Z][A-Z0-9_]{2,40}(?: pid=\d+)?(?: exit=[A-Za-z0-9_-]{1,24})?$/u);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('supervisor requires the production config to remain owner-only', () => {
  const fixture = createFixture();
  try {
    const wrapper = createSupervisorWrapper(fixture);
    const result = runPowerShell(wrapper, ['production-config-system-acl'], fixtureEnv(fixture));
    assertFailed(result, /failed safely|ACL/iu);
    const trace = existsSync(fixture.tracePath) ? readFileSync(fixture.tracePath, 'utf8') : '';
    assert.equal(trace.includes('START '), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('production launches cloudflared suspended into containment and cleans every startup failure', () => {
  const supervisor = readFileSync(supervisorScript, 'utf8');
  const nativeStart = supervisor.indexOf('CreateProcessW(');
  const nativeAssign = supervisor.indexOf('AssignProcessToJobObject(', nativeStart);
  const nativeResume = supervisor.indexOf('ResumeThread(', nativeAssign);
  assert.ok(nativeStart >= 0);
  assert.ok(nativeAssign > nativeStart);
  assert.ok(nativeResume > nativeAssign);
  assert.match(supervisor, /CREATE_SUSPENDED/u);
  assert.match(supervisor, /CREATE_NO_WINDOW/u);
  assert.match(supervisor, /CreateProcessW\([\s\S]*?false,[\s\S]*?CREATE_SUSPENDED\s*\|\s*CREATE_NO_WINDOW/u);
  assert.match(supervisor, /StartContained\(\$script:TunnelJobHandle/u);

  for (const scenario of ['containment-assign-failure', 'containment-resume-failure']) {
    const fixture = createFixture();
    try {
      const wrapper = createSupervisorWrapper(fixture);
      const result = runPowerShell(wrapper, [scenario, '1'], fixtureEnv(fixture));
      assertFailed(result, /failed safely/iu);
      const trace = readFileSync(fixture.tracePath, 'utf8').trim().split(/\r?\n/u);
      assert.deepEqual(trace.filter((line) => line === 'CREATE_SUSPENDED 700'), ['CREATE_SUSPENDED 700']);
      assert.deepEqual(trace.filter((line) => line === 'TERMINATE 700'), ['TERMINATE 700']);
      assert.equal(trace.includes('RESUME 700'), false);
      assert.equal(trace.some((line) => /(?:STOP|TERMINATE) 900$/u.test(line)), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  const identityFixture = createFixture();
  try {
    const wrapper = createSupervisorWrapper(identityFixture);
    const result = runPowerShell(wrapper, ['startup-identity-mismatch', '1'], fixtureEnv(identityFixture));
    assertFailed(result, /failed safely/iu);
    const trace = readFileSync(identityFixture.tracePath, 'utf8').trim().split(/\r?\n/u);
    assert.deepEqual(trace.filter((line) => line === 'RESUME 700'), ['RESUME 700']);
    assert.deepEqual(trace.filter((line) => line === 'STOP 700'), ['STOP 700']);
  } finally {
    rmSync(identityFixture.root, { recursive: true, force: true });
  }
});

test('supervisor accepts either preserved MCP enable state while keeping its allowlist loopback-only', () => {
  const fixture = createFixture();
  try {
    write(
      fixture.productionConfigPath,
      readFileSync(fixture.productionConfigPath, 'utf8').replace('enable_mcp = false', 'enable_mcp = true'),
    );
    const wrapper = createSupervisorWrapper(fixture);
    const result = runPowerShell(wrapper, ['healthy', '1'], fixtureEnv(fixture));
    assertSucceeded(result);
    assert.match(readFileSync(fixture.tracePath, 'utf8'), /^START /mu);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('supervisor rejects a placeholder production signing secret before spawning cloudflared', () => {
  const fixture = createFixture();
  try {
    write(
      fixture.productionConfigPath,
      readFileSync(fixture.productionConfigPath, 'utf8')
        .replace('SENSITIVE-PRODUCTION-SECRET', '__PRESERVE_EXISTING_LOCAL_SECRET__'),
    );
    const wrapper = createSupervisorWrapper(fixture);
    const result = runPowerShell(wrapper, ['healthy', '1'], fixtureEnv(fixture));
    assertFailed(result, /failed safely/iu);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /PRESERVE_EXISTING_LOCAL_SECRET/iu);
    const trace = existsSync(fixture.tracePath) ? readFileSync(fixture.tracePath, 'utf8') : '';
    assert.equal(trace.includes('START '), false);
    assert.equal(trace.includes('STOP '), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('native kill-on-close containment initializes in Windows PowerShell 5.1 without starting a tunnel', () => {
  const fixture = createFixture();
  try {
    const wrapper = createSupervisorWrapper(fixture);
    const result = runPowerShell(wrapper, ['native-containment', '1'], fixtureEnv(fixture));
    assertSucceeded(result);
    const trace = existsSync(fixture.tracePath) ? readFileSync(fixture.tracePath, 'utf8') : '';
    assert.equal(trace.includes('START '), false);
    assert.match(readFileSync(fixture.logPath, 'utf8'), /ORIGIN_INVALID/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('native contained launcher assigns a suspended child before it can run', () => {
  const source = readFileSync(supervisorScript, 'utf8');
  const typeDefinition = source.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/u)?.[1];
  assert.ok(typeDefinition);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'clawbot-native-containment-'));
  try {
    const smokeScript = join(temporaryDirectory, 'native-containment-smoke.ps1');
    write(smokeScript, `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${typeDefinition}
'@
$job = $null
$process = $null
try {
  $job = [Clawbot.LedgerTunnelJob]::CreateKillOnClose()
  $commandLine = '"' + $env:ComSpec + '" /d /c exit 0'
  $process = [Clawbot.LedgerTunnelJob]::StartContained($job, $env:ComSpec, $commandLine, $env:TEMP)
  if (-not $process.WaitForExit(5000)) { throw 'Contained smoke child did not exit.' }
  if ($process.ExitCode -ne 0) { throw 'Contained smoke child returned a nonzero status.' }
} finally {
  if ($null -ne $process) { $process.Dispose() }
  if ($null -ne $job) { $job.Dispose() }
}
`);
    assertSucceeded(runPowerShell(smokeScript));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('supervisor refuses every invalid origin and an owner race without spawning cloudflared', () => {
  for (const scenario of ['absent', 'wildcard', 'multiple', 'wrong-executable', 'wrong-config', 'unhealthy', 'wrong-page', 'race']) {
    const fixture = createFixture();
    try {
      const wrapper = createSupervisorWrapper(fixture);
      const result = runPowerShell(wrapper, [scenario, '1'], fixtureEnv(fixture));
      assertSucceeded(result);
      const trace = existsSync(fixture.tracePath) ? readFileSync(fixture.tracePath, 'utf8') : '';
      assert.equal(trace.includes('START '), false, scenario);
      assert.equal(trace.includes('STOP '), false, scenario);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('supervisor never adopts or terminates an unknown pre-existing cloudflared process', () => {
  const fixture = createFixture();
  try {
    const wrapper = createSupervisorWrapper(fixture);
    const result = runPowerShell(wrapper, ['unknown-cloudflared', '1'], fixtureEnv(fixture));
    assertSucceeded(result);
    const trace = existsSync(fixture.tracePath) ? readFileSync(fixture.tracePath, 'utf8') : '';
    assert.equal(trace.includes('START '), false);
    assert.equal(trace.includes('STOP '), false);
    assert.match(readFileSync(fixture.logPath, 'utf8'), /TUNNEL_CONFLICT/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('supervisor rejects a log path collision before touching a protected credential', () => {
  const fixture = createFixture();
  try {
    const before = readFileSync(fixture.credentialPath);
    const wrapper = createSupervisorWrapper(fixture);
    const result = runPowerShell(wrapper, ['healthy', '1'], fixtureEnv(fixture, {
      CLAWBOT_TUNNEL_TEST_LOG: fixture.credentialPath,
    }));
    assertFailed(result, /failed safely/iu);
    assert.deepEqual(readFileSync(fixture.credentialPath), before);
    const trace = existsSync(fixture.tracePath) ? readFileSync(fixture.tracePath, 'utf8') : '';
    assert.equal(trace.includes('START '), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('supervisor rejects Process/User/Machine environment overrides and untrusted binaries without exposing values', () => {
  for (const [scenario, extraEnvironment] of [
    ['healthy', { TUNNEL_TOKEN: 'SENSITIVE-TUNNEL-TOKEN' }],
    ['healthy', { EBK_SERVER_DOMAIN: 'SENSITIVE-EBK-VALUE' }],
    ['healthy', {
      CLAWBOT_TUNNEL_TEST_ENVIRONMENT_SCOPE: 'User',
      CLAWBOT_TUNNEL_TEST_ENVIRONMENT_NAME: 'EBKCFP_SERVER_HTTP_ADDR',
    }],
    ['healthy', {
      CLAWBOT_TUNNEL_TEST_ENVIRONMENT_SCOPE: 'Machine',
      CLAWBOT_TUNNEL_TEST_ENVIRONMENT_NAME: 'EBK_SECURITY_SECRET_KEY',
    }],
    ['invalid-signature', {}],
  ]) {
    const fixture = createFixture();
    try {
      const wrapper = createSupervisorWrapper(fixture);
      const result = runPowerShell(wrapper, [scenario, '1'], fixtureEnv(fixture, extraEnvironment));
      assertFailed(result, /failed safely/iu);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.doesNotMatch(
        output,
        /SENSITIVE-(?:TUNNEL-TOKEN|EBK-VALUE)|EBK(?:CFP)?_(?:SERVER_HTTP_ADDR|SECURITY_SECRET_KEY)/iu,
      );
      const trace = existsSync(fixture.tracePath) ? readFileSync(fixture.tracePath, 'utf8') : '';
      assert.equal(trace.includes('START '), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('supervisor preserves an unmarked pre-existing log and fails closed', () => {
  const fixture = createFixture();
  try {
    const wrapper = createSupervisorWrapper(fixture);
    const markerPath = join(dirname(fixture.logPath), logMarkerName);
    rmSync(markerPath, { force: true });
    const original = Buffer.from('UNKNOWN-LOG-MUST-SURVIVE\n', 'utf8');
    writeFileSync(fixture.logPath, original);
    const result = runPowerShell(wrapper, ['healthy', '1'], fixtureEnv(fixture));
    assertFailed(result, /failed safely/iu);
    assert.deepEqual(readFileSync(fixture.logPath), original);
    assert.equal(existsSync(markerPath), false);
    const trace = existsSync(fixture.tracePath) ? readFileSync(fixture.tracePath, 'utf8') : '';
    assert.equal(trace.includes('START '), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a cloudflared process racing startup closes only the supervisor child', () => {
  const fixture = createFixture();
  try {
    const wrapper = createSupervisorWrapper(fixture);
    const result = runPowerShell(wrapper, ['cloudflared-race', '1'], fixtureEnv(fixture));
    assertSucceeded(result);
    const trace = readFileSync(fixture.tracePath, 'utf8');
    assert.equal((trace.match(/^STOP 700$/gmu) ?? []).length, 1);
    assert.doesNotMatch(trace, /^STOP 900$/mu);
    assert.match(readFileSync(fixture.logPath, 'utf8'), /TUNNEL_CONFLICT/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('continuous supervision fails closed for every post-start origin regression', () => {
  for (const scenario of ['late-absent', 'late-wildcard', 'late-multiple', 'late-wrong-executable', 'late-wrong-config', 'late-unhealthy', 'late-wrong-page', 'late-race']) {
    const fixture = createFixture();
    try {
      const wrapper = createSupervisorWrapper(fixture);
      const result = runPowerShell(wrapper, [scenario, '2'], fixtureEnv(fixture));
      assert.equal(
        result.status,
        0,
        `${scenario}: ${result.stderr || result.stdout}\nTRACE:\n${existsSync(fixture.tracePath) ? readFileSync(fixture.tracePath, 'utf8') : ''}\nLOG:\n${existsSync(fixture.logPath) ? readFileSync(fixture.logPath, 'utf8') : ''}`,
      );
      const trace = readFileSync(fixture.tracePath, 'utf8');
      assert.match(trace, /^START /mu, scenario);
      assert.equal((trace.match(/^STOP 700$/gmu) ?? []).length, 1, scenario);
      assert.match(readFileSync(fixture.logPath, 'utf8'), /ORIGIN_INVALID/u, scenario);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('changed or reused child identity is never killed and failures cannot inject secrets into bounded logs', () => {
  for (const scenario of ['child-identity-change', 'pid-reused']) {
  const fixture = createFixture();
  try {
    const wrapper = createSupervisorWrapper(fixture);
    const result = runPowerShell(wrapper, [scenario, '2', '4096'], fixtureEnv(fixture));
    assertFailed(result, /failed safely/iu);
    const trace = readFileSync(fixture.tracePath, 'utf8');
    assert.equal(trace.includes('STOP '), false);
    if (scenario === 'pid-reused') {
      assert.equal((trace.match(/^HEALTH /gmu) ?? []).length, 4, 'PID reuse must abort before another origin cycle');
    }
    const logPaths = [fixture.logPath, `${fixture.logPath}.1`].filter((path) => existsSync(path));
    const allOutput = `${result.stdout}\n${result.stderr}\n${logPaths.map((path) => readFileSync(path, 'utf8')).join('\n')}`;
    assert.doesNotMatch(allOutput, /credential-content/iu);
    assert.match(allOutput, /CHILD_IDENTITY_CHANGED|failed safely/iu);
    for (const path of logPaths) {
      assert.ok(readFileSync(path).length <= 4096);
      for (const line of readFileSync(path, 'utf8').trim().split(/\r?\n/u)) {
        assert.match(line, /^timestamp=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z event=[A-Z][A-Z0-9_]{2,40}(?: pid=\d+)?(?: exit=[A-Za-z0-9_-]{1,24})?$/u);
      }
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
  }
});

test('supervisor stops its child when the protected tunnel identity changes at runtime', () => {
  const fixture = createFixture();
  try {
    const wrapper = createSupervisorWrapper(fixture);
    const result = runPowerShell(wrapper, ['config-drift', '2'], fixtureEnv(fixture));
    assertFailed(result, /failed safely/iu);
    assert.equal((readFileSync(fixture.tracePath, 'utf8').match(/^STOP 700$/gmu) ?? []).length, 1);
    assert.match(readFileSync(fixture.logPath, 'utf8'), /TUNNEL_CONFIG_CHANGED/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('installer WhatIf performs no validation process, write, ACL, or task mutation', () => {
  const fixture = createFixture();
  try {
    const wrapper = createInstallerWrapper(fixture);
    const beforeConfig = readFileSync(fixture.tunnelConfigPath);
    const beforeCredential = readFileSync(fixture.credentialPath);
    const result = runPowerShell(wrapper, ['whatif'], fixtureEnv(fixture));
    assertSucceeded(result);
    assert.equal(existsSync(fixture.runtimeDirectory), false);
    assert.deepEqual(readFileSync(fixture.tunnelConfigPath), beforeConfig);
    assert.deepEqual(readFileSync(fixture.credentialPath), beforeCredential);
    assert.equal(existsSync(fixture.tracePath), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('installer ignores unrelated scheduled-task actions without executable fields', () => {
  const fixture = createFixture();
  try {
    const wrapper = createInstallerWrapper(fixture);
    const beforeConfig = readFileSync(fixture.tunnelConfigPath);
    const beforeCredential = readFileSync(fixture.credentialPath);
    const result = runPowerShell(wrapper, ['whatif-unrelated-non-exec-task'], fixtureEnv(fixture));
    assertSucceeded(result);
    assert.equal(existsSync(fixture.runtimeDirectory), false);
    assert.deepEqual(readFileSync(fixture.tunnelConfigPath), beforeConfig);
    assert.deepEqual(readFileSync(fixture.credentialPath), beforeCredential);
    assert.equal(existsSync(fixture.tracePath), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('installer validates ingress then creates an exact supervisor-only least-privilege task', () => {
  const fixture = createFixture();
  try {
    const wrapper = createInstallerWrapper(fixture);
    const result = runPowerShell(wrapper, ['install'], fixtureEnv(fixture));
    assertSucceeded(result);
    assert.equal(existsSync(join(fixture.runtimeDirectory, 'ledger-tunnel-supervisor.ps1')), true);
    assert.equal(existsSync(join(fixture.runtimeDirectory, 'ledger-runtime-common.ps1')), true);
    const trace = readFileSync(fixture.tracePath, 'utf8').trim().split(/\r?\n/u);
    assert.match(trace[0], /^VALIDATE tunnel\|--config\|.*ledger\.yml\|ingress\|validate$/u);
    const action = trace.find((line) => line.startsWith('ACTION '));
    assert.ok(action);
    assert.match(action, /powershell\.exe/iu);
    assert.match(action, /ledger-tunnel-supervisor\.ps1/iu);
    assert.equal(action.includes(fixture.credentialPath), false);
    assert.match(action, /^ACTION\s+[^\r\n]*powershell\.exe\s+/iu);
    assert.doesNotMatch(action, /--token|service\s+install/iu);
    assert.ok(trace.some((line) => line === 'PRINCIPAL S4U Limited'));
    assert.ok(trace.some((line) => line === 'REGISTER Clawbot Ledger Tunnel FORCE=False'));
    const aclWrites = trace.filter((line) => line.startsWith('ACL '));
    assert.equal(aclWrites.length, 9);
    assert.ok(aclWrites.every((line) => line.endsWith('OWNER_CURRENT=True')), aclWrites.join('\n'));
    assert.ok(aclWrites.some((line) => /^ACL runtime /u.test(line)));
    assert.ok(aclWrites.some((line) => /^ACL logs /u.test(line)));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('installer starts only the exact task after a post-registration identity recheck', () => {
  const fixture = createFixture();
  try {
    const wrapper = createInstallerWrapper(fixture);
    const result = runPowerShell(wrapper, ['install-start'], fixtureEnv(fixture));
    assertSucceeded(result);
    assert.match(result.stdout, /LEDGER_TUNNEL_TASK_STARTED/u);
    const trace = readFileSync(fixture.tracePath, 'utf8').trim().split(/\r?\n/u);
    const registered = trace.indexOf('REGISTER Clawbot Ledger Tunnel FORCE=False');
    const revalidated = trace.indexOf('TASK_REVALIDATE');
    const started = trace.indexOf('START_TASK Clawbot Ledger Tunnel');
    assert.ok(registered >= 0 && revalidated > registered && started > revalidated, trace.join('\n'));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('installer refuses to start a task replaced after registration', () => {
  const fixture = createFixture();
  try {
    const wrapper = createInstallerWrapper(fixture);
    const result = runPowerShell(wrapper, ['post-register-task-race'], fixtureEnv(fixture));
    assertFailed(result, /refus|unsafe|conflict/iu);
    const trace = readFileSync(fixture.tracePath, 'utf8');
    assert.match(trace, /REGISTER Clawbot Ledger Tunnel FORCE=False/u);
    assert.match(trace, /TASK_REVALIDATE/u);
    assert.equal(trace.includes('START_TASK '), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('installer rejects environment overrides, untrusted binaries, case collisions, and a task race', () => {
  for (const [scenario, extraEnvironment] of [
    ['install', { TUNNEL_CRED_CONTENTS: 'SENSITIVE-CREDENTIAL-CONTENTS' }],
    ['invalid-signature', {}],
    ['hash-mismatch', {}],
    ['task-case-conflict', {}],
    ['task-principal-conflict', {}],
    ['task-principal-sid-conflict', {}],
    ['task-race', {}],
  ]) {
    const fixture = createFixture();
    try {
      const wrapper = createInstallerWrapper(fixture);
      const result = runPowerShell(wrapper, [scenario], fixtureEnv(fixture, extraEnvironment));
      assertFailed(result, /refus|unsafe|conflict|signature|hash/iu);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.doesNotMatch(output, /SENSITIVE-CREDENTIAL-CONTENTS/iu);
      const trace = existsSync(fixture.tracePath) ? readFileSync(fixture.tracePath, 'utf8') : '';
      assert.equal(trace.includes('REGISTER '), false, scenario);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('installer leaves an already exact full-identity task untouched', () => {
  const fixture = createFixture();
  try {
    const wrapper = createInstallerWrapper(fixture);
    const result = runPowerShell(wrapper, ['exact-task'], fixtureEnv(fixture));
    assertSucceeded(result);
    assert.match(result.stdout, /LEDGER_TUNNEL_TASK_ALREADY_INSTALLED/u);
    const trace = readFileSync(fixture.tracePath, 'utf8');
    assert.equal(trace.includes('REGISTER '), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('installer recognizes equivalent Task Scheduler principal identity forms', () => {
  for (const scenario of ['exact-task-principal-short-name', 'exact-task-principal-sid']) {
    const fixture = createFixture();
    try {
      const wrapper = createInstallerWrapper(fixture);
      const result = runPowerShell(wrapper, [scenario], fixtureEnv(fixture));
      assertSucceeded(result);
      assert.match(result.stdout, /LEDGER_TUNNEL_TASK_ALREADY_INSTALLED/u);
      const trace = readFileSync(fixture.tracePath, 'utf8');
      assert.equal(trace.includes('REGISTER '), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('installer refuses relative credentials and never adopts unmarked runtime or log paths', () => {
  {
    const fixture = createFixture();
    try {
      write(
        fixture.tunnelConfigPath,
        tunnelYaml('11111111-2222-4333-8444-555555555555.json'),
      );
      const wrapper = createInstallerWrapper(fixture);
      const result = runPowerShell(wrapper, ['install'], fixtureEnv(fixture));
      assertFailed(result, /absolute|credential|refus|unsafe/iu);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  for (const target of ['runtime', 'log']) {
    const fixture = createFixture();
    try {
      if (target === 'runtime') mkdirSync(fixture.runtimeDirectory, { recursive: true });
      else {
        mkdirSync(dirname(fixture.logPath), { recursive: true });
        write(fixture.logPath, 'UNKNOWN-LOG-MUST-SURVIVE\n');
      }
      const wrapper = createInstallerWrapper(fixture);
      const result = runPowerShell(wrapper, ['install'], fixtureEnv(fixture));
      assertFailed(result, /marker|dedicated|refus|unsafe|owned/iu);
      const trace = existsSync(fixture.tracePath) ? readFileSync(fixture.tracePath, 'utf8') : '';
      assert.equal(trace.includes('ACL '), false, target);
      assert.equal(trace.includes('REGISTER '), false, target);
      if (target === 'log') assert.equal(readFileSync(fixture.logPath, 'utf8'), 'UNKNOWN-LOG-MUST-SURVIVE\n');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('installer rejects unsafe ACLs, validator failures, foreign tasks, services, and non-exact ingress', () => {
  for (const scenario of ['unsafe-acl', 'wrong-owner', 'validator-failure', 'task-conflict', 'task-non-exec-name-conflict', 'service-conflict', 'bad-task-name', 'log-collision']) {
    const fixture = createFixture();
    try {
      const wrapper = createInstallerWrapper(fixture);
      const result = runPowerShell(wrapper, [scenario], fixtureEnv(fixture));
      assertFailed(result, /refus|unsafe|conflict|validation|protected|argument/iu);
      const trace = existsSync(fixture.tracePath) ? readFileSync(fixture.tracePath, 'utf8') : '';
      assert.equal(trace.includes('REGISTER '), false, scenario);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  {
    const fixture = createFixture();
    try {
      const wrongExecutable = join(fixture.local, 'cloudflared-copy.exe');
      write(wrongExecutable);
      const wrapper = createInstallerWrapper(fixture);
      const result = runPowerShell(wrapper, ['install'], fixtureEnv(fixture, { CLAWBOT_TUNNEL_TEST_CLOUDFLARED: wrongExecutable }));
      assertFailed(result, /exact|required|refus|unsafe/iu);
      assert.equal(existsSync(fixture.tracePath), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  {
    const fixture = createFixture();
    try {
      const mismatchedCredential = join(fixture.local, 'different-tunnel.json');
      write(mismatchedCredential, '{"fixture":"credential-content-must-not-be-read"}\n');
      write(fixture.tunnelConfigPath, tunnelYaml(mismatchedCredential));
      const wrapper = createInstallerWrapper(fixture);
      const result = runPowerShell(wrapper, ['install'], fixtureEnv(fixture, { CLAWBOT_TUNNEL_TEST_CREDENTIAL: mismatchedCredential }));
      assertFailed(result, /config|credential|exact|refus|unsafe/iu);
      assert.equal(existsSync(fixture.tracePath), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  for (const overrides of [
    { noAutoupdate: 'false' },
    { hostname: 'www.66ccff-labs.com' },
    { origin: 'http://localhost:8888' },
    { fallback: 'http_status:200' },
  ]) {
    const fixture = createFixture();
    try {
      write(fixture.tunnelConfigPath, tunnelYaml(fixture.credentialPath, overrides));
      const wrapper = createInstallerWrapper(fixture);
      const result = runPowerShell(wrapper, ['install'], fixtureEnv(fixture));
      assertFailed(result, /config|ingress|Ledger|exact/iu);
      assert.equal(existsSync(fixture.tracePath), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('local acceptance emits only fixed pass/fail evidence and rejects a mismatched task', () => {
  const fixture = createFixture();
  try {
    const wrapper = createLocalCheckWrapper(fixture);
    const missingRuntime = runPowerShell(wrapper, ['healthy'], fixtureEnv(fixture));
    assert.notEqual(missingRuntime.status, 0);
    const missingRuntimeEvidence = JSON.parse(missingRuntime.stdout.trim());
    assert.equal(missingRuntimeEvidence.tunnel_layout, 'fail');
    assert.equal(missingRuntimeEvidence.tunnel_runtime_integrity, 'fail');

    prepareLocalRuntimeFixture(fixture);
    const healthy = runPowerShell(wrapper, ['healthy'], fixtureEnv(fixture));
    assertSucceeded(healthy);
    assert.doesNotMatch(healthy.stdout, /SENSITIVE|credential-content|:\\|https?:\/\//iu);
    assert.deepEqual(JSON.parse(healthy.stdout.trim()), {
      production_listener: 'pass',
      production_configuration: 'pass',
      production_task: 'pass',
      test_isolation: 'pass',
      release: 'pass',
      tunnel_files: 'pass',
      tunnel_layout: 'pass',
      tunnel_binary: 'pass',
      tunnel_runtime_integrity: 'pass',
      tunnel_task_launcher: 'pass',
      tunnel_task_arguments: 'pass',
      tunnel_task_working_directory: 'pass',
      tunnel_task_principal: 'pass',
      tunnel_child: 'pass',
    });

    for (const scenario of ['principal-short-name', 'principal-sid']) {
      const equivalentPrincipal = runPowerShell(wrapper, [scenario], fixtureEnv(fixture));
      assertSucceeded(equivalentPrincipal);
      assert.equal(JSON.parse(equivalentPrincipal.stdout.trim()).tunnel_task_principal, 'pass');
    }

    const broadProductionConfigAcl = runPowerShell(wrapper, ['production-config-system-acl'], fixtureEnv(fixture));
    assert.notEqual(broadProductionConfigAcl.status, 0);
    assert.equal(JSON.parse(broadProductionConfigAcl.stdout.trim()).production_configuration, 'fail');

    const environmentOverride = runPowerShell(wrapper, ['healthy'], fixtureEnv(fixture, {
      CLAWBOT_TUNNEL_TEST_ENVIRONMENT_SCOPE: 'User',
      CLAWBOT_TUNNEL_TEST_ENVIRONMENT_NAME: 'EBK_SERVER_ROOT_URL',
    }));
    assert.notEqual(environmentOverride.status, 0);
    assert.doesNotMatch(`${environmentOverride.stdout}\n${environmentOverride.stderr}`, /EBK_SERVER_ROOT_URL/iu);
    assert.equal(JSON.parse(environmentOverride.stdout.trim()).production_configuration, 'fail');

    write(
      fixture.productionConfigPath,
      readFileSync(fixture.productionConfigPath, 'utf8').replace('enable_mcp = false', 'enable_mcp = true'),
    );
    const enabledMcp = runPowerShell(wrapper, ['healthy'], fixtureEnv(fixture));
    assertSucceeded(enabledMcp);
    assert.equal(JSON.parse(enabledMcp.stdout.trim()).production_configuration, 'pass');

    const wrongTask = runPowerShell(wrapper, ['wrong-task'], fixtureEnv(fixture));
    assert.notEqual(wrongTask.status, 0);
    assert.doesNotMatch(`${wrongTask.stdout}\n${wrongTask.stderr}`, /SENSITIVE|credential-content|:\\|https?:\/\//iu);
    assert.equal(JSON.parse(wrongTask.stdout.trim()).tunnel_task_arguments, 'fail');

    const wrongProductionTask = runPowerShell(wrapper, ['wrong-production-task'], fixtureEnv(fixture));
    assert.notEqual(wrongProductionTask.status, 0);
    assert.equal(JSON.parse(wrongProductionTask.stdout.trim()).production_task, 'fail');

    write(
      fixture.productionConfigPath,
      readFileSync(fixture.productionConfigPath, 'utf8').replace('server_id = 0', 'server_id = 1'),
    );
    const duplicateUuidIdentity = runPowerShell(wrapper, ['healthy'], fixtureEnv(fixture));
    assert.notEqual(duplicateUuidIdentity.status, 0);
    assert.equal(JSON.parse(duplicateUuidIdentity.stdout.trim()).production_configuration, 'fail');
    write(
      fixture.productionConfigPath,
      readFileSync(fixture.productionConfigPath, 'utf8').replace('server_id = 1', 'server_id = 0'),
    );

    write(
      fixture.productionConfigPath,
      readFileSync(fixture.productionConfigPath, 'utf8').replace('max_failures_per_user_per_minute = 5', 'max_failures_per_user_per_minute = 6'),
    );
    const weakRateLimit = runPowerShell(wrapper, ['healthy'], fixtureEnv(fixture));
    assert.notEqual(weakRateLimit.status, 0);
    assert.equal(JSON.parse(weakRateLimit.stdout.trim()).production_configuration, 'fail');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
