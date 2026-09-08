import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectModelAuthorization } from '../../../scripts/mac/model-authorization-inspection.mjs';
import { visibleModelAuthorization } from '../../../scripts/mac/model-authorization.mjs';
const sourceCommit = 'a'.repeat(40), containerId = 'b'.repeat(64), runtimeImage = `sha256:${'c'.repeat(64)}`;
const containerStartedAt = '2026-09-08T00:00:00.000Z';
const expected = { sourceCommit, runtimeImage, containerId, containerStartedAt };
function harness({ digest = '5a37cd8f591c608e1e352b32dfb9e3ffc84aefbb0829f811adcc7dee4e20bbec', restarted = false, replaced = false } = {}) {
  const calls = []; let starts = 0, inspections = 0;
  return { calls, inspect: async () => ++inspections > 1 && replaced ? 'd'.repeat(64) : containerId,
    run: async args => {
      calls.push(args);
      if (args[0] === 'inspect') return JSON.stringify(args[2].includes('.Image') ? runtimeImage
        : ++starts > 1 && restarted ? '2026-09-08T01:00:00.000Z' : containerStartedAt);
      if (args.includes('-e')) return digest;
      assert.deepEqual(args, ['exec', containerId, 'node', '/app/openclaw.mjs', 'models', 'status', '--agent', 'bookkeeper', '--json']);
      return JSON.stringify({ agentId: 'bookkeeper', resolvedDefault: 'openai/gpt-5.6-sol', fallbacks: [],
        auth: { runtimeAuthRoutes: [{ provider: 'openai', runtime: 'codex', status: 'usable' }],
          oauth: { profiles: [{ provider: 'openai', access: 'SECRET', email: 'PRIVATE' }] } } });
    } };
}
test('inspection uses pinned read-only command and binds sanitized results to one runtime', async () => {
  const h = harness(), report = await inspectModelAuthorization({ ...h, sourceCommit, profile: 'isolated-test' });
  assert.equal(report.state, 'credentials-present'); assert.equal(report.containerId, containerId);
  assert.equal(report.remoteVerified, false); assert.equal(report.restartRecommended, false);
  assert.doesNotMatch(JSON.stringify(report), /SECRET|PRIVATE/);
  assert.ok(h.calls.every(args => !args.includes('--probe') && !args.includes('login') && !args.includes('restart')));
});
test('changed upstream code is rejected before auth inspection; restart or replacement invalidates results', async () => {
  const changed = harness({ digest: 'unexpected' });
  await assert.rejects(inspectModelAuthorization({ ...changed, sourceCommit, profile: 'isolated-test' }));
  assert.ok(changed.calls.every(args => !args.includes('models')));
  for (const option of [{ restarted: true }, { replaced: true }]) {
    await assert.rejects(inspectModelAuthorization({ ...harness(option), sourceCommit, profile: 'isolated-test' }));
  }
});
test('page projection expires cached diagnostics and rejects different runtime identities', async () => {
  const report = await inspectModelAuthorization({ ...harness(), sourceCommit, profile: 'isolated-test' });
  const now = Date.parse(report.observedAt);
  assert.equal(visibleModelAuthorization(report, expected, now).state, 'credentials-present');
  assert.equal(visibleModelAuthorization(report, expected, now + 6 * 60000 + 1).state, 'stale');
  assert.equal(visibleModelAuthorization(report, expected, now - 1).state, 'inspection-unavailable');
  for (const key of Object.keys(expected)) {
    assert.equal(visibleModelAuthorization(report, { ...expected, [key]: 'different' }, now).state, 'inspection-unavailable');
  }
  assert.equal(visibleModelAuthorization(report, {}, now).state, 'inspection-unavailable');
});
test('page output contains only defined state and warning fields, never injected profile metadata', async () => {
  const report = await inspectModelAuthorization({ ...harness(), sourceCommit, profile: 'isolated-test' });
  report.account = 'SECRET'; report.raw = { token: 'PRIVATE' }; report.warnings = ['temporarily-unavailable'];
  const publicReport = visibleModelAuthorization(report, expected);
  assert.deepEqual(publicReport.warnings, ['temporarily-unavailable']);
  assert.doesNotMatch(JSON.stringify(publicReport), /SECRET|PRIVATE|containerId|runtimeImage/);
  report.warnings.push('print SECRET');
  assert.equal(visibleModelAuthorization(report, expected).state, 'inspection-unavailable');
});
