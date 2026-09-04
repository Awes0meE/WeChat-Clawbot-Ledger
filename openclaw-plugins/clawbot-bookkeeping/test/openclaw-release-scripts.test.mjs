import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const publishScript = join(projectDirectory, 'scripts', 'publish-openclaw-release.ps1');
const verifyScript = join(projectDirectory, 'scripts', 'verify-openclaw-release.ps1');
const fullCommit = '0123456789abcdef0123456789abcdef01234567';
const nextCommit = '89abcdef0123456789abcdef0123456789abcdef';

function write(path, contents = '') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walkFiles(root) {
  const files = [];
  function visit(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else files.push(relative(root, path).replaceAll('\\', '/'));
    }
  }
  visit(root);
  return files.sort();
}

function writeManifest(releasePath) {
  const manifestPath = join(releasePath, 'release-manifest.json');
  const entries = walkFiles(releasePath)
    .filter((path) => path !== 'release-manifest.json')
    .map((path) => {
      const absolutePath = join(releasePath, ...path.split('/'));
      return {
        path,
        length: readFileSync(absolutePath).length,
        sha256: hash(absolutePath),
      };
    });
  write(manifestPath, `${JSON.stringify(entries, null, 2)}\n`);
}

function runPowerShell(script, arguments_ = [], env = {}) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...arguments_],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ...env },
    },
  );
}

function assertSucceeded(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function assertFailed(result, pattern) {
  assert.notEqual(result.status, 0, 'command unexpectedly succeeded');
  assert.match(`${result.stderr}\n${result.stdout}`, pattern);
}

function createGitShim(root) {
  const path = join(root, 'git-shim.ps1');
  write(path, String.raw`
$joined = $args -join ' '
$safeDirectory = 'safe.directory=' + $env:CLAWBOT_TEST_SOURCE_ROOT
$hasExactSafetyPrefix = $args.Count -ge 6 -and $args[0] -eq '-c' -and $args[1] -ceq $safeDirectory -and $args[2] -eq '-C' -and $args[3] -ceq $env:CLAWBOT_TEST_SOURCE_ROOT
Add-Content -LiteralPath $env:CLAWBOT_TEST_GIT_TRACE -Value $joined -Encoding UTF8
if ($env:CLAWBOT_TEST_REQUIRE_SAFE_DIRECTORY -eq '1' -and -not $hasExactSafetyPrefix) { exit 90 }
if ($joined -match 'status --porcelain$') {
  Add-Content -LiteralPath $env:CLAWBOT_TEST_LIFECYCLE_TRACE -Value 'git-status' -Encoding UTF8
  $statusCount = @(Get-Content -LiteralPath $env:CLAWBOT_TEST_LIFECYCLE_TRACE -Encoding UTF8 | Where-Object { $_ -eq 'git-status' }).Count
  if ($env:CLAWBOT_TEST_GIT_DIRTY -eq '1' -or
      ($env:CLAWBOT_TEST_GIT_DIRTY_AFTER_BUILD -eq '1' -and $statusCount -gt 1) -or
      ($env:CLAWBOT_TEST_GIT_DIRTY_BEFORE_PUBLISH -eq '1' -and $statusCount -gt 2)) { Write-Output ' M fixture-file' }
  exit 0
}
if ($joined -match 'rev-parse --verify HEAD$') {
  Add-Content -LiteralPath $env:CLAWBOT_TEST_LIFECYCLE_TRACE -Value 'git-head' -Encoding UTF8
  $headCount = @(Get-Content -LiteralPath $env:CLAWBOT_TEST_LIFECYCLE_TRACE -Encoding UTF8 | Where-Object { $_ -eq 'git-head' }).Count
  if ($env:CLAWBOT_TEST_GIT_COMMIT_BEFORE_PUBLISH -and $headCount -gt 2) { Write-Output $env:CLAWBOT_TEST_GIT_COMMIT_BEFORE_PUBLISH }
  elseif ($env:CLAWBOT_TEST_GIT_COMMIT_AFTER_BUILD -and $headCount -gt 1) { Write-Output $env:CLAWBOT_TEST_GIT_COMMIT_AFTER_BUILD }
  else { Write-Output $env:CLAWBOT_TEST_GIT_COMMIT }
  exit 0
}
exit 91
`);
  return path;
}

function createNpmShim(root) {
  const path = join(root, 'npm-shim.ps1');
  write(path, String.raw`
$joined = $args -join ' '
if ($joined -eq 'run build') {
  Add-Content -LiteralPath $env:CLAWBOT_TEST_BUILD_TRACE -Value 'stable-id-build' -Encoding UTF8
  Add-Content -LiteralPath $env:CLAWBOT_TEST_LIFECYCLE_TRACE -Value 'stable-id-build' -Encoding UTF8
  $dist = $env:CLAWBOT_TEST_STABLE_DIST
  New-Item -ItemType Directory -Path $dist -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $dist 'build-marker.js'), 'export const built = true;', (New-Object Text.UTF8Encoding($false)))
  exit 0
}
if ($joined -eq 'ci --omit=dev --omit=peer --ignore-scripts') {
  Add-Content -LiteralPath $env:CLAWBOT_TEST_BUILD_TRACE -Value 'bookkeeping-production-dependencies' -Encoding UTF8
  $modules = Join-Path (Get-Location) 'node_modules'
  New-Item -ItemType Directory -Path (Join-Path $modules 'typebox') -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $modules '.package-lock.json'), '{"lockfileVersion":3}', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $modules 'typebox\package.json'), '{"name":"typebox"}', (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText((Join-Path $modules 'typebox\index.js'), 'export const Type = {};', (New-Object Text.UTF8Encoding($false)))
  exit 0
}
if ($joined -eq 'ci --omit=dev --ignore-scripts') {
  Add-Content -LiteralPath $env:CLAWBOT_TEST_BUILD_TRACE -Value 'stable-id-production-dependencies' -Encoding UTF8
  $modules = Join-Path (Get-Location) 'node_modules'
  foreach ($dependency in @('openclaw', 'qrcode-terminal', 'zod')) {
    New-Item -ItemType Directory -Path (Join-Path $modules $dependency) -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $modules "$dependency\package.json"), ('{"name":"' + $dependency + '"}'), (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText((Join-Path $modules "$dependency\index.js"), 'export default {};', (New-Object Text.UTF8Encoding($false)))
  }
  [IO.File]::WriteAllText((Join-Path $modules '.package-lock.json'), '{"lockfileVersion":3}', (New-Object Text.UTF8Encoding($false)))
  if ($env:CLAWBOT_TEST_STAGING_JUNCTION_TARGET) {
    $stagingRoot = Split-Path -Parent (Split-Path -Parent (Get-Location))
    New-Item -ItemType Junction -Path (Join-Path $stagingRoot 'injected-link') -Target $env:CLAWBOT_TEST_STAGING_JUNCTION_TARGET | Out-Null
  }
  exit 0
}
exit 92
`);
  return path;
}

function createNodeShim(root) {
  const path = join(root, 'node-shim.ps1');
  write(path, String.raw`
$componentRoot = $args[$args.Count - 1]
if ($env:CLAWBOT_TEST_NODE_FAIL -eq '1') { exit 102 }
if ($componentRoot -like '*clawbot-bookkeeping') {
  if (-not (Test-Path -LiteralPath (Join-Path $componentRoot 'node_modules\typebox\package.json') -PathType Leaf)) { exit 95 }
  if (Test-Path -LiteralPath (Join-Path $componentRoot 'node_modules\openclaw')) { exit 96 }
  Add-Content -LiteralPath $env:CLAWBOT_TEST_BUILD_TRACE -Value 'bookkeeping-module-resolution' -Encoding UTF8
  exit 0
}
if ($componentRoot -like '*openclaw-weixin-stable-id') {
  foreach ($dependency in @('openclaw', 'qrcode-terminal', 'zod')) {
    if (-not (Test-Path -LiteralPath (Join-Path $componentRoot "node_modules\$dependency\package.json") -PathType Leaf)) { exit 97 }
  }
  Add-Content -LiteralPath $env:CLAWBOT_TEST_BUILD_TRACE -Value 'stable-id-module-resolution' -Encoding UTF8
  exit 0
}
exit 98
`);
  return path;
}

function createAclShim(root) {
  const path = join(root, 'acl-shim.ps1');
  write(path, String.raw`
$operation = 'legacy-protect'
if ($args.Count -eq 2 -and $args[0] -in @('protect', 'verify', 'protect-release', 'verify-release')) { $operation = $args[0] }
elseif ($args.Count -ne 4 -or $args[1] -ne '/inheritance:r' -or $args[2] -ne '/grant:r' -or -not $args[3].EndsWith(':(F)')) { exit 101 }
Add-Content -LiteralPath $env:CLAWBOT_TEST_ACL_TRACE -Value $operation -Encoding UTF8
$callCount = @(Get-Content -LiteralPath $env:CLAWBOT_TEST_ACL_TRACE -Encoding UTF8).Count
if ($env:CLAWBOT_TEST_ACL_FAIL_ON_CALL -and $callCount -eq [int]$env:CLAWBOT_TEST_ACL_FAIL_ON_CALL) { exit 103 }
if ($operation -eq 'verify-release' -and $env:CLAWBOT_TEST_RELEASE_ACL_UNSAFE -eq '1') { exit 105 }
exit 0
`);
  return path;
}

function createOpenClawShim(root) {
  const path = join(root, 'openclaw-shim.ps1');
  write(path, String.raw`
function Merge-PatchObject {
  param($Target, $Patch)
  foreach ($property in $Patch.PSObject.Properties) {
    $existing = $Target.PSObject.Properties[$property.Name]
    if ($null -ne $existing -and $existing.Value -is [PSCustomObject] -and $property.Value -is [PSCustomObject]) {
      Merge-PatchObject -Target $existing.Value -Patch $property.Value
    } elseif ($null -ne $existing) {
      $existing.Value = $property.Value
    } else {
      $Target | Add-Member -MemberType NoteProperty -Name $property.Name -Value $property.Value
    }
  }
}

$joined = $args -join ' '
Add-Content -LiteralPath $env:CLAWBOT_TEST_OPENCLAW_TRACE -Value $joined -Encoding UTF8
if ($env:CLAWBOT_TEST_OPENCLAW_FAIL_ON -and $joined.Contains($env:CLAWBOT_TEST_OPENCLAW_FAIL_ON)) { exit 93 }
if ($args.Count -ge 2 -and $args[0] -eq 'config' -and $args[1] -eq 'patch') {
  $fileIndex = [Array]::IndexOf([object[]]$args, '--file')
  if ($fileIndex -lt 0 -or $fileIndex + 1 -ge $args.Count) { exit 94 }
  $patchPath = $args[$fileIndex + 1]
  $patchText = [IO.File]::ReadAllText($patchPath, [Text.Encoding]::UTF8)
  if ($patchText.Contains('tokenPath') -or $patchText.Contains('fixture-owner') -or $patchText.Contains('SENSITIVE-FIXTURE-VALUE')) { exit 99 }
  $patch = $patchText | ConvertFrom-Json -ErrorAction Stop
  if (-not ($args -contains '--dry-run')) {
    $config = [IO.File]::ReadAllText($env:CLAWBOT_TEST_OPENCLAW_CONFIG, [Text.Encoding]::UTF8) | ConvertFrom-Json -ErrorAction Stop
    Merge-PatchObject -Target $config -Patch $patch
    [IO.File]::WriteAllText(
      $env:CLAWBOT_TEST_OPENCLAW_CONFIG,
      (($config | ConvertTo-Json -Depth 100) + [Environment]::NewLine),
      (New-Object Text.UTF8Encoding($false))
    )
    if ($env:CLAWBOT_TEST_OPENCLAW_FAIL_AFTER_PATCH_WRITE -eq '1') { exit 100 }
    if ($env:CLAWBOT_TEST_OPENCLAW_DELETE_CONFIG_AFTER_PATCH -eq '1') {
      Remove-Item -LiteralPath $env:CLAWBOT_TEST_OPENCLAW_CONFIG -Force
      exit 104
    }
  }
  exit 0
}
if ($args.Count -ge 3 -and $args[0] -eq 'channels' -and $args[1] -eq 'status' -and $args[2] -eq '--probe') {
  if ($env:CLAWBOT_TEST_CHANNEL_STATUS_MODE -eq 'malformed') { Write-Output 'Gateway unavailable; config-only fallback'; exit 0 }
  $account = [ordered]@{
    accountId = 'default'
    enabled = $true
    configured = $true
    running = $true
    restartPending = $false
    lastError = $null
  }
  if ($env:CLAWBOT_TEST_CHANNEL_STATUS_MODE -eq 'running-false') { $account.running = $false }
  if ($env:CLAWBOT_TEST_CHANNEL_STATUS_MODE -eq 'last-error') { $account.lastError = 'SENSITIVE-CHANNEL-ERROR-MUST-NOT-APPEAR' }
  if ($env:CLAWBOT_TEST_CHANNEL_STATUS_MODE -eq 'probe-false') { $account.probe = [ordered]@{ ok = $false } }
  $defaultAccountId = if ($env:CLAWBOT_TEST_CHANNEL_STATUS_MODE -eq 'default-mismatch') { 'other-account' } else { 'default' }
  [ordered]@{
    channelAccounts = [ordered]@{ 'openclaw-weixin' = @($account) }
    channelDefaultAccountId = [ordered]@{ 'openclaw-weixin' = $defaultAccountId }
  } | ConvertTo-Json -Compress -Depth 10
  exit 0
}
exit 0
`);
  return path;
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'clawbot-openclaw-release-'));
  const source = join(root, 'source');
  const releases = join(root, 'releases');
  const backups = join(root, 'backups');
  const configPath = join(root, 'openclaw', 'openclaw.json');
  const tracePath = join(root, 'openclaw-trace.txt');
  const buildTracePath = join(root, 'build-trace.txt');
  const lifecycleTracePath = join(root, 'lifecycle-trace.txt');
  const gitTracePath = join(root, 'git-trace.txt');
  const aclTracePath = join(root, 'acl-trace.txt');
  const bookkeeping = join(source, 'openclaw-plugins', 'clawbot-bookkeeping');
  const stable = join(source, 'openclaw-plugins', 'openclaw-weixin-stable-id');
  const workspace = join(source, 'openclaw-workspace');

  for (const name of [
    'adapter.mjs',
    'bookkeeping-core.mjs',
    'categories.mjs',
    'expense-summary.mjs',
    'index.ts',
    'mcp-connection.mjs',
    'openclaw.plugin.json',
    'package.json',
    'package-lock.json',
  ]) {
    write(join(bookkeeping, name), `bookkeeping:${name}`);
  }
  write(join(bookkeeping, 'test', 'ignored.test.mjs'), 'must not ship');
  write(join(bookkeeping, 'node_modules', 'ignored', 'index.js'), 'must not ship');

  write(join(stable, 'package.json'), '{"name":"stable-fixture"}');
  write(join(stable, 'package-lock.json'), '{"lockfileVersion":3}');
  write(join(stable, 'openclaw.plugin.json'), '{"id":"openclaw-weixin"}');
  write(join(stable, 'dist', 'index.js'), 'export default {};');
  write(join(stable, 'dist', 'index.js.map'), '{}');
  write(join(stable, 'src', 'ignored.ts'), 'must not ship');
  write(join(stable, 'test', 'ignored.test.mjs'), 'must not ship');
  write(join(stable, 'node_modules', 'ignored', 'index.js'), 'must not ship');

  for (const name of ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md']) {
    write(join(workspace, name), `workspace:${name}`);
  }
  write(join(workspace, 'memory', 'ignored.md'), 'must not ship');
  write(join(source, '.git', 'config'), 'must not ship');

  mkdirSync(releases, { recursive: true });
  mkdirSync(backups, { recursive: true });

  const unrelatedPlugin = join(root, 'unrelated-plugin');
  const config = {
    plugins: {
      load: {
        paths: [bookkeeping, stable, unrelatedPlugin],
      },
      entries: {
        'clawbot-bookkeeping': {
          config: {
            serverBaseUrl: 'http://127.0.0.1:8180',
            tokenPath: 'SENSITIVE-FIXTURE-VALUE',
            untouched: { nested: true },
          },
        },
        unrelated: { enabled: true, config: { keep: 'unchanged' } },
      },
    },
    agents: {
      entries: {
        bookkeeper: {
          workspace,
          model: { primary: 'openai/gpt-5.6-sol' },
          models: {
            'openai/gpt-5.6-sol': { agentRuntime: { id: 'codex' } },
          },
        },
      },
    },
    commands: { ownerAllowFrom: ['openclaw-weixin:fixture-owner'] },
    unrelatedTopLevel: { keep: ['all', 'values'] },
  };
  write(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const gitShim = createGitShim(root);
  const npmShim = createNpmShim(root);
  const openclawShim = createOpenClawShim(root);
  const nodeShim = createNodeShim(root);
  const aclShim = createAclShim(root);
  const env = {
    CLAWBOT_TEST_GIT_COMMIT: fullCommit,
    CLAWBOT_TEST_SOURCE_ROOT: source,
    CLAWBOT_TEST_BUILD_TRACE: buildTracePath,
    CLAWBOT_TEST_STABLE_DIST: join(stable, 'dist'),
    CLAWBOT_TEST_OPENCLAW_TRACE: tracePath,
    CLAWBOT_TEST_OPENCLAW_CONFIG: configPath,
    CLAWBOT_TEST_LIFECYCLE_TRACE: lifecycleTracePath,
    CLAWBOT_TEST_GIT_TRACE: gitTracePath,
    CLAWBOT_TEST_ACL_TRACE: aclTracePath,
  };

  return {
    root,
    source,
    releases,
    backups,
    configPath,
    tracePath,
    buildTracePath,
    lifecycleTracePath,
    gitTracePath,
    aclTracePath,
    bookkeeping,
    stable,
    workspace,
    config,
    gitShim,
    npmShim,
    openclawShim,
    nodeShim,
    aclShim,
    env,
    releasePath: join(releases, fullCommit),
  };
}

function publishArguments(fixture, extra = []) {
  return [
    '-SourceRoot', fixture.source,
    '-ReleaseRoot', fixture.releases,
    '-BackupRoot', fixture.backups,
    '-OpenClawConfigPath', fixture.configPath,
    '-GitExecutable', fixture.gitShim,
    '-NpmExecutable', fixture.npmShim,
    '-OpenClawExecutable', fixture.openclawShim,
    '-NodeExecutable', fixture.nodeShim,
    '-AclExecutable', fixture.aclShim,
    ...extra,
  ];
}

function releasePaths(releasePath) {
  return {
    bookkeeping: join(releasePath, 'openclaw-plugins', 'clawbot-bookkeeping'),
    stable: join(releasePath, 'openclaw-plugins', 'openclaw-weixin-stable-id'),
    workspace: join(releasePath, 'openclaw-workspace'),
  };
}

function normalizedOpenClawTrace(fixture) {
  if (!existsSync(fixture.tracePath)) return [];
  return readFileSync(fixture.tracePath, 'utf8')
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.replace(/^(config patch(?: --dry-run)? --file) .+$/u, '$1 <patch>'));
}

test('publishes an immutable hash manifest from the explicit release allowlist', () => {
  const fixture = createFixture();
  try {
    const result = runPowerShell(publishScript, publishArguments(fixture, ['-ReleaseOnly']), fixture.env);
    assertSucceeded(result);
    assert.deepEqual(readFileSync(fixture.buildTracePath, 'utf8').trim().split(/\r?\n/u), [
      'stable-id-build',
      'bookkeeping-production-dependencies',
      'stable-id-production-dependencies',
      'bookkeeping-module-resolution',
      'stable-id-module-resolution',
    ]);
    assert.equal(existsSync(fixture.releasePath), true);

    const files = walkFiles(fixture.releasePath);
    assert.deepEqual(files, [
      'openclaw-plugins/clawbot-bookkeeping/adapter.mjs',
      'openclaw-plugins/clawbot-bookkeeping/bookkeeping-core.mjs',
      'openclaw-plugins/clawbot-bookkeeping/categories.mjs',
      'openclaw-plugins/clawbot-bookkeeping/expense-summary.mjs',
      'openclaw-plugins/clawbot-bookkeeping/index.ts',
      'openclaw-plugins/clawbot-bookkeeping/mcp-connection.mjs',
      'openclaw-plugins/clawbot-bookkeeping/node_modules/.package-lock.json',
      'openclaw-plugins/clawbot-bookkeeping/node_modules/typebox/index.js',
      'openclaw-plugins/clawbot-bookkeeping/node_modules/typebox/package.json',
      'openclaw-plugins/clawbot-bookkeeping/openclaw.plugin.json',
      'openclaw-plugins/clawbot-bookkeeping/package-lock.json',
      'openclaw-plugins/clawbot-bookkeeping/package.json',
      'openclaw-plugins/openclaw-weixin-stable-id/dist/build-marker.js',
      'openclaw-plugins/openclaw-weixin-stable-id/dist/index.js',
      'openclaw-plugins/openclaw-weixin-stable-id/dist/index.js.map',
      'openclaw-plugins/openclaw-weixin-stable-id/node_modules/.package-lock.json',
      'openclaw-plugins/openclaw-weixin-stable-id/node_modules/openclaw/index.js',
      'openclaw-plugins/openclaw-weixin-stable-id/node_modules/openclaw/package.json',
      'openclaw-plugins/openclaw-weixin-stable-id/node_modules/qrcode-terminal/index.js',
      'openclaw-plugins/openclaw-weixin-stable-id/node_modules/qrcode-terminal/package.json',
      'openclaw-plugins/openclaw-weixin-stable-id/node_modules/zod/index.js',
      'openclaw-plugins/openclaw-weixin-stable-id/node_modules/zod/package.json',
      'openclaw-plugins/openclaw-weixin-stable-id/openclaw.plugin.json',
      'openclaw-plugins/openclaw-weixin-stable-id/package-lock.json',
      'openclaw-plugins/openclaw-weixin-stable-id/package.json',
      'openclaw-workspace/AGENTS.md',
      'openclaw-workspace/IDENTITY.md',
      'openclaw-workspace/SOUL.md',
      'openclaw-workspace/USER.md',
      'release-commit.txt',
      'release-manifest.json',
    ]);
    assert.equal(readFileSync(join(fixture.releasePath, 'release-commit.txt'), 'utf8'), `${fullCommit}\n`);
    assert.deepEqual(readFileSync(fixture.lifecycleTracePath, 'utf8').trim().split(/\r?\n/u), [
      'git-status',
      'git-head',
      'stable-id-build',
      'git-status',
      'git-head',
      'git-status',
      'git-head',
    ]);
    assert.equal(files.some((path) => path.includes('/node_modules/ignored/')), false);
    assert.equal(
      files.some((path) => path.startsWith('openclaw-plugins/clawbot-bookkeeping/node_modules/openclaw/')),
      false,
    );
    assert.equal(
      files.some((path) => path.startsWith('openclaw-plugins/openclaw-weixin-stable-id/node_modules/openclaw/')),
      true,
    );

    const manifest = JSON.parse(readFileSync(join(fixture.releasePath, 'release-manifest.json'), 'utf8'));
    assert.equal(Array.isArray(manifest), true);
    assert.deepEqual(
      manifest.map((entry) => Object.keys(entry).sort()),
      manifest.map(() => ['length', 'path', 'sha256']),
    );
    assert.deepEqual(
      manifest.map((entry) => entry.path),
      files.filter((path) => path !== 'release-manifest.json'),
    );
    for (const entry of manifest) {
      const path = join(fixture.releasePath, ...entry.path.split('/'));
      assert.equal(entry.length, readFileSync(path).length);
      assert.equal(entry.sha256, hash(path));
    }
    assertSucceeded(runPowerShell(verifyScript, ['-ReleasePath', fixture.releasePath, '-AclExecutable', fixture.aclShim], fixture.env));

    const second = runPowerShell(publishScript, publishArguments(fixture, ['-ReleaseOnly']), fixture.env);
    assertFailed(second, /already exists|immutable/iu);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('hardens and verifies the release ACL before publication or activation', () => {
  const fixture = createFixture();
  try {
    const published = runPowerShell(publishScript, publishArguments(fixture, ['-ReleaseOnly']), fixture.env);
    assertSucceeded(published);
    assert.deepEqual(readFileSync(fixture.aclTracePath, 'utf8').trim().split(/\r?\n/u), [
      'protect-release',
      'verify-release',
      'verify-release',
    ]);

    rmSync(fixture.aclTracePath, { force: true });
    rmSync(fixture.tracePath, { force: true });
    const unsafe = runPowerShell(
      publishScript,
      publishArguments(fixture, ['-ExistingReleasePath', fixture.releasePath, '-SwitchOpenClaw']),
      { ...fixture.env, CLAWBOT_TEST_RELEASE_ACL_UNSAFE: '1' },
    );
    assertFailed(unsafe, /ACL|immutable|release|protect/iu);
    assert.deepEqual(normalizedOpenClawTrace(fixture), []);
    assert.deepEqual(JSON.parse(readFileSync(fixture.configPath, 'utf8')), fixture.config);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('release ACL hardening failure publishes no release', () => {
  const fixture = createFixture();
  try {
    const result = runPowerShell(
      publishScript,
      publishArguments(fixture, ['-ReleaseOnly']),
      { ...fixture.env, CLAWBOT_TEST_ACL_FAIL_ON_CALL: '1' },
    );
    assertFailed(result, /ACL|immutable|release|protect/iu);
    assert.equal(existsSync(fixture.releasePath), false);
    assert.deepEqual(readdirSync(fixture.releases), []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('applies the exact repository-scoped safe.directory override to every Git check', () => {
  const fixture = createFixture();
  try {
    const result = runPowerShell(
      publishScript,
      publishArguments(fixture, ['-ReleaseOnly']),
      { ...fixture.env, CLAWBOT_TEST_REQUIRE_SAFE_DIRECTORY: '1' },
    );
    assertSucceeded(result);
    assert.deepEqual(readFileSync(fixture.gitTracePath, 'utf8').trim().split(/\r?\n/u), [
      `-c safe.directory=${fixture.source} -C ${fixture.source} status --porcelain`,
      `-c safe.directory=${fixture.source} -C ${fixture.source} rev-parse --verify HEAD`,
      `-c safe.directory=${fixture.source} -C ${fixture.source} status --porcelain`,
      `-c safe.directory=${fixture.source} -C ${fixture.source} rev-parse --verify HEAD`,
      `-c safe.directory=${fixture.source} -C ${fixture.source} status --porcelain`,
      `-c safe.directory=${fixture.source} -C ${fixture.source} rev-parse --verify HEAD`,
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('resolves the default source root only after Windows PowerShell initializes PSScriptRoot', () => {
  const fixture = createFixture();
  try {
    const result = runPowerShell(publishScript, [
      '-ReleaseRoot', fixture.releases,
      '-BackupRoot', fixture.backups,
      '-OpenClawConfigPath', fixture.configPath,
      '-ReleaseOnly',
      '-WhatIf',
    ]);
    assertSucceeded(result);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects unsupported and forbidden source artifacts instead of silently shipping them', () => {
  for (const [relativePath, pattern] of [
    ['openclaw-plugins/clawbot-bookkeeping/unexpected.txt', /unsupported/iu],
    ['openclaw-plugins/clawbot-bookkeeping/local.sqlite', /forbidden|sqlite|data/iu],
    ['openclaw-workspace/session.log', /forbidden|log/iu],
  ]) {
    const fixture = createFixture();
    try {
      write(join(fixture.source, ...relativePath.split('/')), 'must never ship');
      const result = runPowerShell(publishScript, publishArguments(fixture, ['-ReleaseOnly']), fixture.env);
      assertFailed(result, pattern);
      assert.equal(existsSync(fixture.releasePath), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('release verification rejects missing, added, modified, out-of-root, and reparse entries', () => {
  const fixture = createFixture();
  try {
    assertSucceeded(runPowerShell(publishScript, publishArguments(fixture, ['-ReleaseOnly']), fixture.env));
    const pristine = join(fixture.root, 'pristine');
    cpSync(fixture.releasePath, pristine, { recursive: true });

    const cases = [
      ['missing', (path) => rmSync(join(path, 'openclaw-workspace', 'USER.md')), /missing/iu],
      ['added', (path) => write(join(path, 'extra.txt'), 'extra'), /extra/iu],
      ['modified', (path) => write(join(path, 'openclaw-workspace', 'USER.md'), 'changed'), /length|hash|changed/iu],
      ['outside', (path) => {
        const manifestPath = join(path, 'release-manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        manifest[0].path = '../outside.txt';
        write(manifestPath, JSON.stringify(manifest));
      }, /relative|outside|root/iu],
      ['reparse', (path) => {
        const outside = join(fixture.root, 'outside-directory');
        mkdirSync(outside, { recursive: true });
        symlinkSync(outside, join(path, 'linked-directory'), 'junction');
      }, /reparse/iu],
    ];

    for (const [name, mutate, pattern] of cases) {
      const candidate = join(fixture.root, `verify-${name}`);
      cpSync(pristine, candidate, { recursive: true });
      mutate(candidate);
      assertFailed(runPowerShell(verifyScript, ['-ReleasePath', candidate, '-AclExecutable', fixture.aclShim], fixture.env), pattern);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('release verification rejects a valid payload under a non-commit directory name', () => {
  const fixture = createFixture();
  try {
    assertSucceeded(runPowerShell(publishScript, publishArguments(fixture, ['-ReleaseOnly']), fixture.env));
    const renamed = join(fixture.releases, 'not-a-commit');
    cpSync(fixture.releasePath, renamed, { recursive: true });
    assertFailed(runPowerShell(verifyScript, ['-ReleasePath', renamed, '-AclExecutable', fixture.aclShim], fixture.env), /directory|commit|name/iu);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('self-consistent hollow releases fail structure verification before OpenClaw is touched', () => {
  const fixture = createFixture();
  try {
    mkdirSync(fixture.releasePath, { recursive: true });
    write(join(fixture.releasePath, 'release-commit.txt'), `${fullCommit}\n`);
    writeManifest(fixture.releasePath);

    assertFailed(runPowerShell(verifyScript, ['-ReleasePath', fixture.releasePath, '-AclExecutable', fixture.aclShim], fixture.env), /required|structure|plugin|workspace|dependency/iu);
    const result = runPowerShell(
      publishScript,
      publishArguments(fixture, ['-ExistingReleasePath', fixture.releasePath, '-SwitchOpenClaw']),
      fixture.env,
    );
    assertFailed(result, /required|structure|plugin|workspace|dependency|invalid/iu);
    assert.deepEqual(normalizedOpenClawTrace(fixture), []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('live publication requires a clean source and a full hexadecimal commit', () => {
  for (const [envOverride, pattern, buildRan] of [
    [{ CLAWBOT_TEST_GIT_DIRTY: '1' }, /clean|dirty/iu, false],
    [{ CLAWBOT_TEST_GIT_COMMIT: 'abc123' }, /full|commit/iu, false],
    [{ CLAWBOT_TEST_GIT_DIRTY_AFTER_BUILD: '1' }, /clean|build|dirty/iu, true],
    [{ CLAWBOT_TEST_GIT_COMMIT_AFTER_BUILD: 'fedcba9876543210fedcba9876543210fedcba98' }, /head|commit|changed/iu, true],
    [{ CLAWBOT_TEST_GIT_DIRTY_BEFORE_PUBLISH: '1' }, /clean|publish|dirty/iu, true],
    [{ CLAWBOT_TEST_GIT_COMMIT_BEFORE_PUBLISH: nextCommit }, /head|commit|changed/iu, true],
  ]) {
    const fixture = createFixture();
    try {
      const result = runPowerShell(
        publishScript,
        publishArguments(fixture, ['-ReleaseOnly']),
        { ...fixture.env, ...envOverride },
      );
      assertFailed(result, pattern);
      assert.equal(existsSync(fixture.releasePath), false);
      assert.equal(existsSync(fixture.buildTracePath), buildRan);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('rejects every bookkeeper model fallback before touching OpenClaw', () => {
  const fixture = createFixture();
  try {
    const config = structuredClone(fixture.config);
    config.agents.entries.bookkeeper.model.fallbacks = ['unauthorized/example-model'];
    write(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);

    const result = runPowerShell(
      publishScript,
      publishArguments(fixture, ['-SwitchOpenClaw']),
      fixture.env,
    );

    assertFailed(result, /approved|codex|fallback|pinned/iu);
    assert.deepEqual(normalizedOpenClawTrace(fixture), []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('accepts an explicit empty bookkeeper fallback list', () => {
  const fixture = createFixture();
  try {
    const config = structuredClone(fixture.config);
    config.agents.entries.bookkeeper.model.fallbacks = [];
    write(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);

    assertSucceeded(runPowerShell(
      publishScript,
      publishArguments(fixture, ['-SwitchOpenClaw']),
      fixture.env,
    ));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('switches atomically from one verified release to a newer release in the same root', () => {
  const fixture = createFixture();
  try {
    assertSucceeded(runPowerShell(publishScript, publishArguments(fixture, ['-SwitchOpenClaw']), fixture.env));
    rmSync(fixture.tracePath, { force: true });

    const nextEnv = { ...fixture.env, CLAWBOT_TEST_GIT_COMMIT: nextCommit };
    const result = runPowerShell(publishScript, publishArguments(fixture, ['-SwitchOpenClaw']), nextEnv);
    assertSucceeded(result);

    const nextRelease = join(fixture.releases, nextCommit);
    const expected = releasePaths(nextRelease);
    const updated = JSON.parse(readFileSync(fixture.configPath, 'utf8'));
    assert.deepEqual(updated.plugins.load.paths, [
      expected.bookkeeping,
      expected.stable,
      fixture.config.plugins.load.paths[2],
    ]);
    assert.equal(updated.agents.entries.bookkeeper.workspace, expected.workspace);
    assert.deepEqual(normalizedOpenClawTrace(fixture), [
      'gateway status',
      'config patch --dry-run --file <patch>',
      'config patch --file <patch>',
      'gateway restart',
      'gateway status',
      'channels status --probe --json',
      'plugins info clawbot-bookkeeping',
      'plugins info openclaw-weixin',
      'plugins inspect codex',
      'models status --agent bookkeeper --json',
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects mixed repository/release and A/B release sources without touching OpenClaw', () => {
  const fixture = createFixture();
  try {
    assertSucceeded(runPowerShell(publishScript, publishArguments(fixture, ['-SwitchOpenClaw']), fixture.env));
    const nextEnv = { ...fixture.env, CLAWBOT_TEST_GIT_COMMIT: nextCommit };
    assertSucceeded(runPowerShell(publishScript, publishArguments(fixture, ['-ReleaseOnly']), nextEnv));

    const releaseA = releasePaths(fixture.releasePath);
    const releaseB = releasePaths(join(fixture.releases, nextCommit));
    const mixedConfigurations = [];

    const differentReleases = JSON.parse(readFileSync(fixture.configPath, 'utf8'));
    differentReleases.plugins.load.paths[1] = releaseB.stable;
    mixedConfigurations.push(differentReleases);

    const repositoryAndRelease = structuredClone(fixture.config);
    repositoryAndRelease.plugins.load.paths[1] = releaseA.stable;
    mixedConfigurations.push(repositoryAndRelease);

    for (const config of mixedConfigurations) {
      write(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);
      rmSync(fixture.tracePath, { force: true });
      const result = runPowerShell(
        publishScript,
        publishArguments(fixture, [
          '-ExistingReleasePath', join(fixture.releases, nextCommit),
          '-SwitchOpenClaw',
        ]),
        nextEnv,
      );
      assertFailed(result, /mixed|single|source|release|development/iu);
      assert.deepEqual(normalizedOpenClawTrace(fixture), []);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects every residual Git checkout load path before touching OpenClaw', () => {
  const fixture = createFixture();
  try {
    assertSucceeded(runPowerShell(publishScript, publishArguments(fixture, ['-ReleaseOnly']), fixture.env));
    const config = structuredClone(fixture.config);
    config.plugins.load.paths.push(join(fixture.source, 'openclaw-plugins', 'unrelated-development-plugin'));
    write(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);
    rmSync(fixture.tracePath, { force: true });

    const result = runPowerShell(
      publishScript,
      publishArguments(fixture, ['-ExistingReleasePath', fixture.releasePath, '-SwitchOpenClaw']),
      fixture.env,
    );

    assertFailed(result, /Git|checkout|repository|development|load path/iu);
    assert.deepEqual(normalizedOpenClawTrace(fixture), []);
    assert.deepEqual(JSON.parse(readFileSync(fixture.configPath, 'utf8')), config);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a reparse alias to a residual Git checkout load path', () => {
  const fixture = createFixture();
  try {
    assertSucceeded(runPowerShell(publishScript, publishArguments(fixture, ['-ReleaseOnly']), fixture.env));
    const repositoryPlugin = join(fixture.source, 'openclaw-plugins', 'unrelated-development-plugin');
    const aliasedPlugin = join(fixture.root, 'aliased-development-plugin');
    mkdirSync(repositoryPlugin, { recursive: true });
    symlinkSync(repositoryPlugin, aliasedPlugin, 'junction');
    const config = structuredClone(fixture.config);
    config.plugins.load.paths.push(aliasedPlugin);
    write(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);
    rmSync(fixture.tracePath, { force: true });

    const result = runPowerShell(
      publishScript,
      publishArguments(fixture, ['-ExistingReleasePath', fixture.releasePath, '-SwitchOpenClaw']),
      fixture.env,
    );

    assertFailed(result, /Git|checkout|repository|reparse|development|load path/iu);
    assert.deepEqual(normalizedOpenClawTrace(fixture), []);
    assert.deepEqual(JSON.parse(readFileSync(fixture.configPath, 'utf8')), config);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('revalidates isolated release module resolution before any OpenClaw command', () => {
  const fixture = createFixture();
  try {
    assertSucceeded(runPowerShell(publishScript, publishArguments(fixture, ['-ReleaseOnly']), fixture.env));
    rmSync(fixture.tracePath, { force: true });
    const result = runPowerShell(
      publishScript,
      publishArguments(fixture, ['-ExistingReleasePath', fixture.releasePath, '-SwitchOpenClaw']),
      { ...fixture.env, CLAWBOT_TEST_NODE_FAIL: '1' },
    );
    assertFailed(result, /module|resolution|release|invalid/iu);
    assert.deepEqual(normalizedOpenClawTrace(fixture), []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('preserves suspicious staging and an external sentinel when a junction appears', () => {
  const fixture = createFixture();
  try {
    const sentinelRoot = join(fixture.root, 'junction-sentinel');
    const sentinelPath = join(sentinelRoot, 'keep.txt');
    write(sentinelPath, 'keep');
    const result = runPowerShell(
      publishScript,
      publishArguments(fixture, ['-ReleaseOnly']),
      { ...fixture.env, CLAWBOT_TEST_STAGING_JUNCTION_TARGET: sentinelRoot },
    );
    assertFailed(result, /reparse|junction|preserv|staging/iu);
    assert.equal(readFileSync(sentinelPath, 'utf8'), 'keep');
    assert.equal(readdirSync(fixture.releases).filter((name) => name.startsWith('.staging-')).length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('dry-runs the exact OpenClaw config replacement before patch and restart', () => {
  const fixture = createFixture();
  try {
    const result = runPowerShell(publishScript, publishArguments(fixture, ['-SwitchOpenClaw']), fixture.env);
    assertSucceeded(result);
    assert.equal(result.stdout.includes('SENSITIVE-FIXTURE-VALUE'), false);
    assert.equal(result.stderr.includes('SENSITIVE-FIXTURE-VALUE'), false);

    const trace = readFileSync(fixture.tracePath, 'utf8').trim().split(/\r?\n/u);
    const dryRunIndex = trace.findIndex((line) => line.startsWith('config patch --dry-run --file '));
    const patchIndex = trace.findIndex((line) => line.startsWith('config patch --file '));
    const restartIndex = trace.findIndex((line) => line === 'gateway restart');
    assert.ok(dryRunIndex >= 0);
    assert.ok(patchIndex > dryRunIndex);
    assert.ok(restartIndex > patchIndex);
    assert.deepEqual(normalizedOpenClawTrace(fixture), [
      'gateway status',
      'config patch --dry-run --file <patch>',
      'config patch --file <patch>',
      'gateway restart',
      'gateway status',
      'channels status --probe --json',
      'plugins info clawbot-bookkeeping',
      'plugins info openclaw-weixin',
      'plugins inspect codex',
      'models status --agent bookkeeper --json',
    ]);

    const updated = JSON.parse(readFileSync(fixture.configPath, 'utf8'));
    const releaseBookkeeping = join(fixture.releasePath, 'openclaw-plugins', 'clawbot-bookkeeping');
    const releaseStable = join(fixture.releasePath, 'openclaw-plugins', 'openclaw-weixin-stable-id');
    assert.deepEqual(updated.plugins.load.paths, [
      releaseBookkeeping,
      releaseStable,
      fixture.config.plugins.load.paths[2],
    ]);
    assert.equal(updated.agents.entries.bookkeeper.workspace, join(fixture.releasePath, 'openclaw-workspace'));
    assert.equal(updated.plugins.entries['clawbot-bookkeeping'].config.serverBaseUrl, 'http://127.0.0.1:8888');
    assert.equal(updated.plugins.entries['clawbot-bookkeeping'].config.tokenPath, 'SENSITIVE-FIXTURE-VALUE');
    assert.deepEqual(updated.plugins.entries.unrelated, fixture.config.plugins.entries.unrelated);
    assert.deepEqual(updated.unrelatedTopLevel, fixture.config.unrelatedTopLevel);
    assert.deepEqual(updated.commands.ownerAllowFrom, fixture.config.commands.ownerAllowFrom);
    assert.deepEqual(readFileSync(fixture.aclTracePath, 'utf8').trim().split(/\r?\n/u), [
      'protect-release',
      'verify-release',
      'verify-release',
      'verify-release',
      'protect',
      'verify',
      'verify',
      'verify',
      'protect',
      'verify',
      'verify',
      'verify',
      'verify',
      'verify',
      'protect',
      'verify',
      'protect',
      'verify',
      'verify-release',
    ]);
    assert.deepEqual(readdirSync(fixture.backups).filter((name) => name.startsWith('.openclaw-patch-')), []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a secret-bearing OpenClaw backup root under OneDrive before publication or patching', () => {
  const fixture = createFixture();
  try {
    fixture.backups = join(fixture.root, 'OneDrive - fixture', 'openclaw-backups');
    mkdirSync(fixture.backups, { recursive: true });
    const result = runPowerShell(
      publishScript,
      publishArguments(fixture, ['-SwitchOpenClaw']),
      fixture.env,
    );
    assertFailed(result, /OneDrive|backup.*outside/iu);
    assert.equal(existsSync(fixture.releasePath), false);
    assert.deepEqual(normalizedOpenClawTrace(fixture), []);
    assert.deepEqual(walkFiles(fixture.backups), []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('ACL failure leaves no complete unprotected backup or patch artifact', () => {
  for (const failureCall of ['1', '3']) {
    const fixture = createFixture();
    try {
      const result = runPowerShell(
        publishScript,
        publishArguments(fixture, ['-SwitchOpenClaw']),
        { ...fixture.env, CLAWBOT_TEST_ACL_FAIL_ON_CALL: failureCall },
      );
      assertFailed(result, /ACL|protect|private|backup|harden/iu);
      assert.deepEqual(walkFiles(fixture.backups), []);
      assert.equal(readFileSync(fixture.configPath, 'utf8').includes('SENSITIVE-FIXTURE-VALUE'), true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('rolls back a verified config backup after a post-patch failure', () => {
  const fixture = createFixture();
  try {
    const originalHash = hash(fixture.configPath);
    const result = runPowerShell(
      publishScript,
      publishArguments(fixture, ['-SwitchOpenClaw']),
      { ...fixture.env, CLAWBOT_TEST_OPENCLAW_FAIL_ON: 'channels status --probe' },
    );
    assertFailed(result, /failed|rollback|probe/iu);
    assert.equal(hash(fixture.configPath), originalHash);

    const backups = readdirSync(fixture.backups).filter((name) => name.endsWith('.json'));
    assert.equal(backups.length, 1);
    assert.equal(hash(join(fixture.backups, backups[0])), originalHash);
    const trace = readFileSync(fixture.tracePath, 'utf8').trim().split(/\r?\n/u);
    assert.equal(trace.filter((line) => line === 'gateway restart').length, 2);
    const aclTrace = readFileSync(fixture.aclTracePath, 'utf8').trim().split(/\r?\n/u);
    assert.deepEqual(aclTrace.slice(-2), ['protect', 'verify']);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('exit-zero unhealthy or malformed WeChat channel JSON rolls back without disclosing status', () => {
  for (const mode of ['running-false', 'last-error', 'default-mismatch', 'probe-false', 'malformed']) {
    const fixture = createFixture();
    try {
      const originalHash = hash(fixture.configPath);
      const result = runPowerShell(
        publishScript,
        publishArguments(fixture, ['-SwitchOpenClaw']),
        { ...fixture.env, CLAWBOT_TEST_CHANNEL_STATUS_MODE: mode },
      );
      assertFailed(result, /channel|switch|restored|status|probe/iu);
      assert.equal(hash(fixture.configPath), originalHash, mode);
      assert.equal(`${result.stdout}\n${result.stderr}`.includes('SENSITIVE-CHANNEL-ERROR-MUST-NOT-APPEAR'), false, mode);
      const trace = readFileSync(fixture.tracePath, 'utf8').trim().split(/\r?\n/u);
      assert.equal(trace.filter((line) => line === 'gateway restart').length, 2, mode);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('rolls back and reloads the verified config when live patch reports failure after writing', () => {
  const fixture = createFixture();
  try {
    const originalHash = hash(fixture.configPath);
    const result = runPowerShell(
      publishScript,
      publishArguments(fixture, ['-SwitchOpenClaw']),
      { ...fixture.env, CLAWBOT_TEST_OPENCLAW_FAIL_AFTER_PATCH_WRITE: '1' },
    );
    assertFailed(result, /failed|rollback|restored/iu);
    assert.equal(hash(fixture.configPath), originalHash);

    const trace = readFileSync(fixture.tracePath, 'utf8').trim().split(/\r?\n/u);
    assert.equal(trace.filter((line) => line === 'gateway restart').length, 1);
    assert.equal(trace.at(-1), 'gateway status');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('atomically restores a deleted live config from the verified protected backup', () => {
  const fixture = createFixture();
  try {
    const originalHash = hash(fixture.configPath);
    const result = runPowerShell(
      publishScript,
      publishArguments(fixture, ['-SwitchOpenClaw']),
      { ...fixture.env, CLAWBOT_TEST_OPENCLAW_DELETE_CONFIG_AFTER_PATCH: '1' },
    );
    assertFailed(result, /failed|rollback|restored/iu);
    assert.equal(hash(fixture.configPath), originalHash);
    assert.deepEqual(normalizedOpenClawTrace(fixture).slice(-2), ['gateway restart', 'gateway status']);
    assert.deepEqual(
      readdirSync(dirname(fixture.configPath)).filter((name) => name.startsWith('.openclaw-')),
      [],
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('an invalid existing release never restarts or patches OpenClaw', () => {
  const fixture = createFixture();
  try {
    assertSucceeded(runPowerShell(publishScript, publishArguments(fixture, ['-ReleaseOnly']), fixture.env));
    write(join(fixture.releasePath, 'openclaw-workspace', 'USER.md'), 'tampered');
    rmSync(fixture.tracePath, { force: true });

    const result = runPowerShell(
      publishScript,
      publishArguments(fixture, ['-ExistingReleasePath', fixture.releasePath, '-SwitchOpenClaw']),
      fixture.env,
    );
    assertFailed(result, /length|hash|changed|invalid/iu);
    const trace = existsSync(fixture.tracePath) ? readFileSync(fixture.tracePath, 'utf8') : '';
    assert.equal(trace.includes('config patch'), false);
    assert.equal(trace.includes('gateway restart'), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
