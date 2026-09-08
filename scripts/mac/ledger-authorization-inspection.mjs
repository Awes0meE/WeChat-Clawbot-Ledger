import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const states = new Set(['accepted-read-only', 'credential-unavailable', 'credential-rejected', 'credential-expired',
  'credential-type-mismatch', 'interactive-auth-required', 'credential-missing', 'api-token-disabled', 'rate-limited',
  'source-denied', 'service-unavailable', 'unrecognized-response', 'request-timeout', 'transport-unavailable',
  'credential-configuration-mismatch', 'endpoint-mismatch', 'required-tool-unavailable']);
function projectReport(raw) {
  assert.equal(raw?.version, 1);
  for (const key of ['businessWrites', 'accountIdentityVerified', 'restartRecommended']) assert.equal(raw[key], false);
  assert.ok(Number.isFinite(Date.parse(raw.observedAt)));
  const report = { version: 1, businessWrites: false, accountIdentityVerified: false, restartRecommended: false,
    observedAt: new Date(raw.observedAt).toISOString() };
  for (const role of ['http', 'mcp']) {
    assert.ok(states.has(raw[role]?.state));
    assert.ok(raw[role].sessionCleanup === undefined || (role === 'mcp' && raw[role].sessionCleanup === 'not-confirmed'));
    report[role] = { state: raw[role].state };
    if (raw[role].sessionCleanup) report[role].sessionCleanup = 'not-confirmed';
  }
  return report;
}
function docker(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('/Applications/Docker.app/Contents/Resources/bin/docker', args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let text = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 45000);
    child.stdout.on('data', chunk => { text += chunk; if (text.length > 8192) { failed = true; child.kill(); } });
    child.stdin.on('error', () => { failed = true; });
    child.on('error', () => { clearTimeout(timer); reject(Error('CLAWBOT_LEDGER_INSPECTION_UNAVAILABLE')); });
    child.on('close', code => { clearTimeout(timer); code === 0 && !failed ? resolve(text) : reject(Error('CLAWBOT_LEDGER_INSPECTION_UNAVAILABLE')); });
    child.stdin.end(input);
  });
}
function validPair(pair) {
  for (const role of ['origin', 'openclaw']) assert.match(pair?.[role] ?? '', /^[a-f0-9]{64}$/);
  assert.notEqual(pair.origin, pair.openclaw);
  return { origin: pair.origin, openclaw: pair.openclaw };
}
// The caller verifies mounts, labels, fixed images and the shared namespace.
// Both containers must retain their identities and start times across the probe.
export async function inspectLedgerAuthorization({ inspect, profile, sourceCommit, run = docker }) {
  assert.ok(['isolated-test', 'production'].includes(profile)); assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  const pair = validPair(await inspect());
  const identity = async () => {
    const format = '{"id":{{json .Id}},"image":{{json .Image}},"startedAt":{{json .State.StartedAt}},"running":{{json .State.Running}}}';
    const rows = (await run(['inspect', '--format', format, pair.origin, pair.openclaw])).trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2);
    for (const [i, role] of ['origin', 'openclaw'].entries()) {
      assert.equal(rows[i].id, pair[role]); assert.equal(rows[i].running, true);
      assert.match(rows[i].image, /^sha256:[a-f0-9]{64}$/); assert.ok(Number.isFinite(Date.parse(rows[i].startedAt)));
    }
    return rows;
  };
  const before = await identity(), test = profile === 'isolated-test';
  const source = readFileSync(new URL('../../deploy/docker/ledger-authorization.mjs', import.meta.url), 'utf8');
  const runner = `
    const fs = await import('node:fs');
    const root = ${JSON.stringify(test ? '/var/lib/clawbot-test' : '/var/lib/clawbot')};
    const report = await probeLedgerAuthorization({origin: ${JSON.stringify(test ? 'http://127.0.0.1:18888' : 'http://127.0.0.1:8888')}, readToken(role) {
      const path = root + '/secrets/' + role + '-token', stat = fs.lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
        || (stat.mode & 0o077) || stat.size > 16384 || fs.realpathSync(path) !== path) throw Error('credential unavailable');
      return fs.readFileSync(path, 'utf8');
    }});
    console.log(JSON.stringify(report));
  `;
  const output = await run(['exec', '-i', pair.openclaw, 'node', '--input-type=module', '-'], source + '\n' + runner);
  assert.deepEqual(validPair(await inspect()), pair); assert.deepEqual(await identity(), before);
  const report = projectReport(JSON.parse(output));
  const observedAt = Date.parse(report.observedAt);
  assert.ok(observedAt <= Date.now() && before.every(row => Date.parse(row.startedAt) <= observedAt));
  return { ...report, profile, hostSourceCommit: sourceCommit, runtimeImage: before[1].image,
    containerId: pair.openclaw, containerStartedAt: before[1].startedAt,
    originImage: before[0].image, originId: pair.origin, originStartedAt: before[0].startedAt };
}

export function visibleLedgerAuthorization(report, expected, now = Date.now()) {
  const base = { state: 'inspection-unavailable', observedAt: null, businessWrites: false, accountIdentityVerified: false,
    restartRecommended: false, http: { state: 'inspection-unavailable' }, mcp: { state: 'inspection-unavailable' } };
  try {
    const profile = expected?.profile ?? 'isolated-test';
    assert.ok(['isolated-test', 'production'].includes(profile)); assert.equal(report?.profile, profile);
    assert.match(expected?.sourceCommit ?? '', /^[a-f0-9]{40}$/);
    assert.equal(report.hostSourceCommit, expected.sourceCommit);
    for (const key of ['containerId', 'originId']) assert.match(expected[key], /^[a-f0-9]{64}$/);
    for (const key of ['runtimeImage', 'originImage']) assert.match(expected[key], /^sha256:[a-f0-9]{64}$/);
    for (const key of ['containerStartedAt', 'originStartedAt']) assert.ok(Number.isFinite(Date.parse(expected[key])));
    for (const key of ['runtimeImage', 'containerId', 'containerStartedAt', 'originImage', 'originId', 'originStartedAt']) assert.equal(report[key], expected[key]);
    const clean = projectReport(report), time = Date.parse(clean.observedAt), age = now - time;
    assert.ok(Number.isFinite(age) && age >= 0 && time >= Date.parse(expected.containerStartedAt) && time >= Date.parse(expected.originStartedAt));
    if (age > 6 * 60000) return { ...base, state: 'stale', observedAt: clean.observedAt };
    return { ...base, state: 'observed', observedAt: clean.observedAt, http: clean.http, mcp: clean.mcp };
  } catch { return base; }
}
