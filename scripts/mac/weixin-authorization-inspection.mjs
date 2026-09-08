import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const states = new Set(['not-enabled', 'runtime-disabled', 'login-required', 'reauthorization-required', 'awaiting-poll',
  'poll-timeout', 'transport-unavailable', 'response-unrecognized', 'api-unavailable', 'message-processing-failed',
  'not-running', 'unknown', 'poll-stale', 'last-poll-accepted', 'gateway-unavailable', 'inspection-unavailable']);
function docker(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('/Applications/Docker.app/Contents/Resources/bin/docker', args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let text = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 35000);
    child.stdout.on('data', chunk => { text += chunk; if (text.length > 8192) { failed = true; child.kill(); } });
    child.stdin.on('error', () => { failed = true; });
    child.on('error', () => { clearTimeout(timer); reject(Error('CLAWBOT_WEIXIN_INSPECTION_UNAVAILABLE')); });
    child.on('close', code => { clearTimeout(timer); code === 0 && !failed ? resolve(text) : reject(Error('CLAWBOT_WEIXIN_INSPECTION_UNAVAILABLE')); });
    child.stdin.end(input);
  });
}
export async function inspectWeixinAuthorization({ inspect, profile, sourceCommit, run = docker }) {
  assert.ok(['isolated-test', 'production'].includes(profile)); assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  const id = await inspect(); assert.match(id, /^[a-f0-9]{64}$/);
  const identity = async () => {
    const format = '{"id":{{json .Id}},"image":{{json .Image}},"startedAt":{{json .State.StartedAt}},"running":{{json .State.Running}}}';
    const row = JSON.parse(await run(['inspect', '--format', format, id]));
    assert.equal(row.id, id); assert.equal(row.running, true); assert.match(row.image, /^sha256:[a-f0-9]{64}$/);
    assert.ok(Number.isFinite(Date.parse(row.startedAt))); return row;
  };
  const before = await identity();
  const source = readFileSync(new URL('../../deploy/docker/weixin-authorization.mjs', import.meta.url), 'utf8');
  const runner = profile === 'production'
    ? `const {verifyProductionActivation}=await import('/opt/clawbot/docker/production-activation.mjs');const config=verifyProductionActivation();`
    : `const config=JSON.parse(readFileSync('/var/lib/clawbot-test/openclaw/openclaw.json'));assert.equal(config?.plugins?.entries?.['clawbot-bookkeeping']?.config?.deploymentProfile,'isolated-test');`;
  const output = await run(['exec', '-i', id, 'node', '--input-type=module', '-'], source + '\n' + runner + '\nconsole.log(JSON.stringify(await inspectConfiguredWeixin(config)));');
  assert.equal(await inspect(), id); assert.deepEqual(await identity(), before);
  const raw = JSON.parse(output);
  assert.equal(raw.version, 1); assert.ok(states.has(raw.state));
  for (const key of ['remoteVerified', 'messageAcceptanceVerified', 'restartRecommended']) assert.equal(raw[key], false);
  const time = Date.parse(raw.observedAt); assert.ok(Number.isFinite(time) && time <= Date.now() && time >= Date.parse(before.startedAt));
  const report = { version: 1, state: raw.state, remoteVerified: false, messageAcceptanceVerified: false,
    restartRecommended: false, observedAt: new Date(time).toISOString(), profile, hostSourceCommit: sourceCommit,
    runtimeImage: before.image, containerId: id, containerStartedAt: before.startedAt };
  if (raw.state === 'last-poll-accepted') {
    const poll = Date.parse(raw.pollObservedAt); assert.ok(Number.isFinite(poll) && poll <= time && time - poll <= 5 * 60000 && poll >= Date.parse(before.startedAt));
    report.pollObservedAt = new Date(poll).toISOString();
  }
  return report;
}

export function visibleWeixinAuthorization(report, expected, now = Date.now()) {
  const base = { state: 'inspection-unavailable', observedAt: null, remoteVerified: false, messageAcceptanceVerified: false, restartRecommended: false };
  try {
    const profile = expected?.profile ?? 'isolated-test';
    assert.ok(['isolated-test', 'production'].includes(profile));
    assert.equal(report?.version, 1); assert.equal(report.profile, profile); assert.ok(states.has(report.state));
    for (const key of ['remoteVerified', 'messageAcceptanceVerified', 'restartRecommended']) assert.equal(report[key], false);
    assert.match(expected?.sourceCommit ?? '', /^[a-f0-9]{40}$/); assert.match(expected.runtimeImage, /^sha256:[a-f0-9]{64}$/);
    assert.match(expected.containerId, /^[a-f0-9]{64}$/); assert.ok(Number.isFinite(Date.parse(expected.containerStartedAt)));
    assert.equal(report.hostSourceCommit, expected.sourceCommit);
    for (const key of ['runtimeImage', 'containerId', 'containerStartedAt']) assert.equal(report[key], expected[key]);
    const time = Date.parse(report.observedAt), age = now - time;
    assert.ok(Number.isFinite(age) && age >= 0 && time >= Date.parse(expected.containerStartedAt));
    if (age > 6 * 60000) return { ...base, state: 'stale', observedAt: new Date(time).toISOString() };
    // The test profile must never turn a reported real receiver into a green
    // authorization card, even if a malformed subprocess claims acceptance.
    if (profile === 'isolated-test') assert.ok(['not-enabled', 'inspection-unavailable'].includes(report.state));
    const visible = { ...base, state: report.state, observedAt: new Date(time).toISOString() };
    if (report.state === 'last-poll-accepted') {
      const poll = Date.parse(report.pollObservedAt);
      assert.ok(Number.isFinite(poll) && poll <= time && poll >= Date.parse(expected.containerStartedAt));
      if (now - poll > 5 * 60000) return { ...base, state: 'poll-stale', observedAt: visible.observedAt };
      visible.pollObservedAt = new Date(poll).toISOString();
    }
    return visible;
  } catch { return base; }
}
