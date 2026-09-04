import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const configPath = join(projectDirectory, 'config', 'cloudflare-ledger-rules.example.json');
const publicTestPath = join(projectDirectory, 'scripts', 'test-ledger-public.ps1');
const publicHelperPath = join(projectDirectory, 'scripts', 'test-ledger-public.mjs');
const restartTestPath = join(projectDirectory, 'scripts', 'test-ledger-restart.ps1');
const runbookPath = join(projectDirectory, 'docs', 'ledger-cloudflare-runbook.md');
const readmePath = join(projectDirectory, 'README.md');
const windowsHandoffPath = join(projectDirectory, 'WINDOWS-HANDOFF.md');
const ledgerHost = 'ledger.66ccff-labs.com';

function readRequired(path) {
  assert.equal(existsSync(path), true, `missing required artifact: ${path}`);
  return readFileSync(path, 'utf8');
}

function runPowerShell(arguments_) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    ...arguments_,
  ], {
    cwd: projectDirectory,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

function assertPowerShellParses(path) {
  const escaped = path.replaceAll("'", "''");
  const result = runPowerShell([
    '-Command',
    `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { exit 1 }`,
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('Cloudflare manifest is credential-free and scopes every control to Ledger', () => {
  const source = readRequired(configPath);
  const manifest = JSON.parse(source);

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.hostname, ledgerHost);
  assert.equal(manifest.origin, 'http://127.0.0.1:8888');
  assert.equal(manifest.access.enabled, false);
  assert.equal(manifest.access.reason, 'single ezBookkeeping login only');

  assert.equal(manifest.dns.hostname, ledgerHost);
  assert.equal(manifest.dns.recordType, 'CNAME');
  assert.equal(manifest.dns.proxied, true);
  assert.equal(manifest.dns.createLast, true);
  assert.match(manifest.dns.targetTemplate, /^<TUNNEL_UUID>\.cfargotunnel\.com$/u);

  const exactHostExpression = `http.host eq "${ledgerHost}"`;
  assert.equal(
    manifest.rules.singleRedirect.expression,
    `${exactHostExpression} and http.request.full_uri wildcard r"http://*"`,
  );
  assert.equal(manifest.rules.singleRedirect.statusCode, 301);
  assert.equal(
    manifest.rules.singleRedirect.targetExpression,
    `concat("https://${ledgerHost}", http.request.uri.path)`,
  );
  assert.equal(manifest.rules.singleRedirect.preserveQueryString, true);
  assert.equal(manifest.rules.singleRedirect.preservePath, true);
  assert.equal(manifest.rules.singleRedirect.preserveQuery, true);
  assert.equal(manifest.rules.cacheBypass.expression, exactHostExpression);
  assert.equal(manifest.rules.cacheBypass.cache, false);
  assert.equal(manifest.rules.responseHeaders.expression, exactHostExpression);
  assert.equal(manifest.rules.wafBlock.action, 'block');
  assert.match(manifest.rules.wafBlock.expression, new RegExp(`http\\.host eq "${ledgerHost.replaceAll('.', '\\.')}"`, 'u'));
  assert.match(manifest.rules.wafBlock.expression, /http\.request\.method eq "TRACE"/u);
  assert.match(manifest.rules.wafBlock.expression, /http\.request\.method eq "POST"/u);
  assert.match(manifest.rules.wafBlock.expression, /http\.request\.uri\.path eq "\/api\/register\.json"/u);

  assert.deepEqual(manifest.rules.responseHeaders.set, {
    'Strict-Transport-Security': 'max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  });
  assert.equal(manifest.rules.responseHeaders.hstsActivationGate, 'activate only after public HTTPS validation');
  assert.equal(manifest.rules.responseHeaders.hstsIncludeSubDomains, false);
  assert.equal(manifest.rules.responseHeaders.hstsPreload, false);

  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /66ccff-labs\.com\*|\*\.66ccff-labs\.com|0\.0\.0\.0|localhost|:8180|:18888/iu);
  assert.doesNotMatch(serialized, /always.?use.?https|zone.?wide|"hstsIncludeSubDomains":true|"hstsPreload":true/iu);
  assert.doesNotMatch(serialized, /api[_-]?token|account[_-]?id|zone[_-]?id|credential|certificate|password|bearer\s|authorization/iu);
});

test('rate-limit variants fail closed around Cloudflare plan capabilities', () => {
  const manifest = JSON.parse(readRequired(configPath));
  const paid = manifest.rules.loginRateLimit.paidPlan;
  const free = manifest.rules.loginRateLimit.freePlanFallback;

  assert.match(paid.expression, new RegExp(`http\\.host eq "${ledgerHost.replaceAll('.', '\\.')}"`, 'u'));
  assert.match(paid.expression, /http\.request\.uri\.path eq "\/api\/authorize\.json"/u);
  assert.match(paid.expression, /http\.request\.method eq "POST"/u);
  assert.deepEqual(paid.ratelimit.characteristics, ['cf.colo.id', 'ip.src']);
  assert.equal(paid.ratelimit.requests_per_period, 5);
  assert.equal(paid.ratelimit.period, 10);
  assert.equal(paid.ratelimit.mitigation_timeout, 10);

  assert.equal(free.expression, 'http.request.uri.path eq "/api/authorize.json"');
  assert.deepEqual(free.ratelimit.characteristics, ['cf.colo.id', 'ip.src']);
  assert.equal(free.ratelimit.requests_per_period, 5);
  assert.equal(free.ratelimit.period, 10);
  assert.equal(free.ratelimit.mitigation_timeout, 10);
  assert.equal(free.activationGates.apexCollisionProbeRequired, true);
  assert.equal(free.activationGates.wwwCollisionProbeRequired, true);
  assert.equal(free.activationGates.sanitizedApiReadbackRequired, true);
  assert.equal(free.activationGates.refuseWhenAnyGateIsUnknownOrFalse, true);
  assert.equal('countingExpression' in free, false);
  assert.equal('requestsToOrigin' in free, false);
  assert.equal('customResponse' in free, false);
});

test('free-plan activation gate requires fresh sanitized API evidence and probes both methods without a boolean bypass', () => {
  const wrapper = readRequired(publicTestPath);
  const helper = readRequired(publicHelperPath);

  assert.match(wrapper, /FreeRateLimitEvidencePath/u);
  assert.doesNotMatch(wrapper, /RateLimitSlotAvailable/u);
  assert.match(helper, /--free-rate-limit-evidence/u);
  assert.doesNotMatch(helper, /--rate-limit-slot-available/u);
  assert.match(helper, /source\s*!==\s*'cloudflare-api-readback'/u);
  assert.match(helper, /rulesetPhase\s*!==\s*'http_ratelimit'/u);
  assert.match(helper, /existingRateLimitRuleCount\s*!==\s*0/u);
  assert.match(helper, /15\s*\*\s*60\s*\*\s*1000/u);
  assert.match(helper, /\['GET',\s*'POST'\]/u);
  assert.match(helper, /PORTFOLIO_HOSTS/u);
});

test('public and restart acceptance scripts parse in Windows PowerShell 5.1', () => {
  for (const path of [publicTestPath, restartTestPath]) {
    readRequired(path);
    assertPowerShellParses(path);
  }
});

test('public acceptance is bounded, bodyless, credential-redacting, and portfolio-aware', () => {
  const wrapper = readRequired(publicTestPath);
  const helper = readRequired(publicHelperPath);
  const source = `${wrapper}\n${helper}`;

  assert.match(wrapper, /test-ledger-public\.mjs/u);
  assert.match(wrapper, /LEDGER_PUBLIC_\[A-Z0-9_\]\+/u);
  assert.match(source, /ledger\.66ccff-labs\.com/u);
  assert.match(source, /66ccff-labs\.com/u);
  assert.match(source, /www\.66ccff-labs\.com/u);
  assert.match(source, /TimeoutSec/u);
  assert.match(helper, /transport\.request/u);
  assert.match(helper, /rejectUnauthorized:\s*true/u);
  assert.match(helper, /agent:\s*false/u);
  assert.match(helper, /AbortSignal\.timeout\(timeoutMs\)/u);
  assert.match(helper, /hardTimeoutMs/u);
  assert.match(helper, /\[307, 308\]/u);
  assert.match(helper, /https:\/\/www\.66ccff-labs\.com\/api\/authorize\.json/u);
  assert.match(source, /api\/authorize\.json/u);
  assert.match(source, /api\/register\.json/u);
  assert.match(source, /\/mcp/u);
  assert.match(source, /X-Content-Type-Options/iu);
  assert.match(source, /X-Frame-Options/iu);
  assert.match(source, /Referrer-Policy/iu);
  assert.match(source, /X-Robots-Tag/iu);
  assert.match(source, /Strict-Transport-Security/iu);
  assert.match(source, /CF-Cache-Status/iu);
  assert.match(source, /cloudflareaccess|cdn-cgi\/access/iu);
  assert.match(source, /TRACE/u);
  assert.match(source, /CapturePortfolioBaseline/u);
  assert.match(source, /ComparePortfolioBaseline/u);
  assert.match(helper, /httpsLocation/u);
  assert.match(helper, /schemaVersion:\s*2/u);
  assert.match(helper, /dns\.resolveCname/u);
  assert.match(helper, /cnameTargets/u);
  assert.doesNotMatch(helper, /schemaVersion:\s*1/u);
  assert.match(helper, /redirect\.statusCode\s*!==\s*301/u);
  assert.doesNotMatch(helper, /\[301,\s*302,\s*307,\s*308\]/u);
  assert.match(helper, /assertNotCached\(root\)/u);
  assert.match(helper, /assertNotCached\(registration\)/u);
  assert.match(helper, /assertNotCached\(trace\)/u);
  assert.match(helper, /assertNotCached\(response\)/u);
  assert.match(helper, /HIT\|STALE\|REVALIDATED\|UPDATING/u);
  assert.match(helper, /\[401,\s*403\]/u);
  const credentialBoundary = helper.match(/async function assertCredentialRejected[\s\S]*?\n\}/u)?.[0] ?? '';
  assert.notEqual(credentialBoundary, '');
  assert.doesNotMatch(credentialBoundary, /response\.statusCode\s*>=\s*200\s*&&\s*response\.statusCode\s*<\s*300/u);
  assert.match(source, /ApiTokenPath/u);
  assert.match(source, /McpTokenPath/u);
  assert.match(helper, /MAX_BODY_BYTES/u);
  assert.doesNotMatch(wrapper, /Write-(?:Host|Output|Verbose|Warning)[^\r\n]*(?:body|content|token|credential)/iu);
  assert.doesNotMatch(wrapper, /Out-File|Export-Clixml|Start-Transcript|Tee-Object/iu);
  assert.doesNotMatch(helper, /console\.(?:log|error)|process\.(?:stdout|stderr)\.write\([^\r\n]*(?:body|content|token|credential)/iu);
});

test('portfolio baseline capture handles a Cloudflare-flattened apex without comparing rotating addresses', () => {
  const helper = readRequired(publicHelperPath);

  assert.match(helper, /if\s*\(options\.capture\)\s*\{[\s\S]*?saveBaseline\([\s\S]*?return;/u);
  assert.match(helper, /document\?\.schemaVersion\s*!==\s*2/u);
  assert.match(helper, /schemaVersion:\s*2/u);
  assert.match(helper, /dns\.resolveCname\(hostname\)/u);
  assert.match(helper, /error\?\.code\s*===\s*'ENODATA'[\s\S]*hostname\s*===\s*PORTFOLIO_HOSTS\[0\]/u);
  assert.match(helper, /dns\.resolve4\(hostname\)/u);
  assert.match(helper, /dns\.resolve6\(hostname\)/u);
  assert.match(helper, /mode:\s*'flattened-apex'/u);
  assert.match(helper, /mode:\s*'cname'/u);
  assert.doesNotMatch(helper, /addresses\s*:/u);
  assert.doesNotMatch(helper, /JSON\.stringify\(matches\[0\]\)\s*!==\s*JSON\.stringify\(actualEntry\)/u);
});

test('public acceptance rejects unsafe arguments before any network or credential output', () => {
  const result = runPowerShell([
    '-File',
    publicTestPath,
    '-CapturePortfolioBaseline',
    '-ComparePortfolioBaseline',
    '-ApiTokenPath',
    'TOKEN-SENTINEL-MUST-NOT-APPEAR',
  ]);
  assert.notEqual(result.status, 0);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /mutually exclusive/iu);
  assert.equal(output.includes('TOKEN-SENTINEL-MUST-NOT-APPEAR'), false);
  assert.doesNotMatch(output, /DNS verification|bounded public request/iu);
});

test('restart acceptance only controls recognized exact tasks and tests fail-close recovery', () => {
  const source = readRequired(restartTestPath);
  const publicWrapper = readRequired(publicTestPath);
  const publicHelper = readRequired(publicHelperPath);

  assert.match(source, /Clawbot ezBookkeeping/u);
  assert.match(source, /Clawbot Ledger Tunnel/u);
  assert.match(source, /Get-LedgerListenerOwner\s+-Port\s+8888/u);
  assert.match(source, /ledger-tunnel-supervisor\.ps1/u);
  assert.match(source, /test-ledger-local\.ps1/u);
  assert.match(source, /test-ledger-public\.ps1/u);
  assert.match(source, /Stop-ScheduledTask/u);
  assert.match(source, /Start-ScheduledTask/u);
  assert.match(source, /Get-ScheduledTaskInfo/u);
  assert.match(source, /fail.?closed/iu);
  assert.match(source, /ExpectLedgerUnavailable/u);
  assert.match(publicWrapper, /ExpectLedgerUnavailable/u);
  assert.match(publicHelper, /expect-ledger-unavailable/u);
  assert.match(source, /SupportsShouldProcess/u);
  assert.match(source, /ExpectedCloudflaredSha256/u);
  assert.match(source, /Assert-ProductionPortClearBeforeStart/u);
  assert.match(source, /Assert-TunnelChildAbsentBeforeStart/u);
  assert.match(source, /RECOVERY_INCOMPLETE/u);
  assert.match(source, /MSFT_TaskLogonTrigger/u);
  assert.match(source, /RestartCount/u);
  assert.match(source, /MultipleInstances/u);
  assert.match(source, /CapturePreReboot/u);
  assert.match(source, /VerifyPostReboot/u);
  assert.match(source, /LastBootUpTime/u);
  assert.match(source, /openclaw(?:\.cmd)?[\s\S]*gateway[\s\S]*status/iu);
  assert.match(source, /channels[\s\S]*status[\s\S]*--probe/iu);
  assert.doesNotMatch(source, /Reboot-equivalent/iu);
  assert.doesNotMatch(source, /Invoke-WebRequest|Invoke-RestMethod/iu);
  assert.doesNotMatch(source, /Stop-Process|taskkill|TerminateProcess/iu);
  assert.doesNotMatch(source, /Unregister-ScheduledTask|Remove-Item|Disable-ScheduledTask/iu);
});

test('restart acceptance WhatIf returns before files, tasks, processes, or network are touched', () => {
  const result = runPowerShell([
    '-File',
    restartTestPath,
    '-ReleasePath',
    'Z:\definitely-missing-release',
    '-PortfolioBaselinePath',
    'Z:\definitely-missing-baseline.json',
    '-ExpectedCloudflaredSha256',
    '0'.repeat(64),
    '-WhatIf',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /WhatIf|What if/iu);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /required restart-acceptance file|scheduled task|bounded public/iu);
});

test('runbook keeps credentials, production data, and portfolio routes outside deployment scope', () => {
  const source = readRequired(runbookPath);

  for (const phrase of [
    'ledger.66ccff-labs.com',
    '127.0.0.1:8888',
    '127.0.0.1:18888',
    'Cloudflare Access',
    'DNS cutover last',
    'visible terminal',
    'Free plan',
    '66ccff-labs.com',
    'www.66ccff-labs.com',
    'WeChat',
  ]) {
    assert.equal(source.includes(phrase), true, `runbook must mention ${phrase}`);
  }
  assert.match(source, /credentials?|token|password/iu);
  assert.match(source, /SQLite/iu);
  assert.match(source, /rollback/iu);
  assert.match(source, /fail.?closed/iu);
  assert.match(source, /outside (?:the )?(?:repository|Git)/iu);
});

test('runbook documents ordered host-scoped Cloudflare mutations and real reboot evidence', () => {
  const source = readRequired(runbookPath);

  assert.match(source, /http\.request\.full_uri wildcard r"http:\/\/\*"/u);
  assert.doesNotMatch(source, /http\.request\.scheme/u);
  assert.match(source, /POST[\s\S]*position\.before/iu);
  assert.match(source, /concat\("https:\/\/ledger\.66ccff-labs\.com",\s*http\.request\.uri\.path\)/u);
  assert.match(source, /preserve_query_string/iu);
  assert.match(source, /cf\.colo\.id[\s\S]*ip\.src/u);
  assert.match(source, /counting_expression[\s\S]*(?:不得|不要|禁止)/iu);
  assert.match(source, /CapturePreReboot/u);
  assert.match(source, /VerifyPostReboot/u);
  assert.match(source, /LastBootUpTime/u);
  assert.match(source, /portfolio-before-v2\.json/u);
  assert.match(source, /API readback[\s\S]*cfargotunnel\.com/iu);
  assert.doesNotMatch(source, /\$cloudflaredSha256\s*=\s*\(Get-FileHash/iu);
  assert.match(source, /approvedCloudflaredSha256[\s\S]*Get-FileHash[\s\S]*(?:-cne|-ne)/iu);
});

test('Windows handoff revalidates the complete production task before starting it', () => {
  const source = readRequired(windowsHandoffPath);

  assert.match(
    source,
    /try\s*\{[\s\S]*?install-ezbookkeeping-task\.ps1[\s\S]*?Get-LedgerExpectedTask[\s\S]*?-Mode\s+Explicit[\s\S]*?Start-ScheduledTask[\s\S]*?\}\s*catch/iu,
  );
  assert.doesNotMatch(source, /\$tasks\s*=\s*@\(Get-ScheduledTask[\s\S]*?Start-ScheduledTask\s+-InputObject\s+\$tasks\[0\]/iu);
});

test('README quick commands pass the required release, Tunnel, and local-acceptance identities', () => {
  const source = readRequired(readmePath);

  assert.match(source, /publish-openclaw-release\.ps1[\s\S]*-SourceRoot[\s\S]*-ReleaseRoot[\s\S]*-BackupRoot[\s\S]*-OpenClawConfigPath[\s\S]*-ReleaseOnly/iu);
  assert.match(source, /publish-openclaw-release\.ps1[\s\S]*-SwitchOpenClaw[\s\S]*-ExistingReleasePath/iu);
  assert.match(source, /install-ledger-tunnel-task\.ps1[\s\S]*-CredentialPath[\s\S]*-TunnelConfigPath[\s\S]*-ExpectedCloudflaredSha256/iu);
  assert.match(source, /test-ledger-local\.ps1[\s\S]*-ReleasePath[\s\S]*-CredentialPath[\s\S]*-ExpectedCloudflaredSha256/iu);
  assert.doesNotMatch(source, /\$approvedCloudflaredSha256\s*=\s*\(Get-FileHash/iu);
});
