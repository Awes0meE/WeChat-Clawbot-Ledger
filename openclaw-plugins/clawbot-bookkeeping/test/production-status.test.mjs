import test from 'node:test';
import assert from 'node:assert/strict';
import { managedRuntimeSpec } from '../../../scripts/mac/managed-runtime-spec.mjs';
import { collectProductionStatus } from '../../../scripts/mac/production-status.mjs';
const time = Date.parse('2026-09-08T12:00:00Z'), startedAt = new Date(time - 3600000).toISOString();
const spec = managedRuntimeSpec({ profile: 'production', project: 'clawbot-production', sourceCommit: 'a'.repeat(40),
  runtimeImage: `sha256:${'b'.repeat(64)}`, guardImage: `sha256:${'c'.repeat(64)}`, cutoverId: '11111111-2222-4333-8444-555555555555',
  sourceSnapshotSha256: 'd'.repeat(64), importManifestSha256: 'e'.repeat(64) });
const ids = { origin: '1'.repeat(64), openclaw: '2'.repeat(64), guard: '3'.repeat(64) };
const images = { origin: `sha256:${'4'.repeat(64)}`, openclaw: spec.services.openclaw.image, guard: spec.services.guard.image };
function fixture(options = {}) {
  let contexts = 0, inspections = 0, probesCalled = 0;
  const gate = { version: 1, project: spec.project, enabled: true, sourceCommit: spec.sourceCommit, cutoverId: spec.cutoverId,
    sourceSnapshotSha256: spec.sourceSnapshotSha256, importManifestSha256: spec.importManifestSha256 };
  const context = { enabled: true, gate, installed: true, pid: 12345, maintenance: false, storageFault: false,
    host: { version: 1, sourceCommit: spec.sourceCommit, pid: 12345, updatedAt: new Date(time).toISOString(), state: 'healthy', storageFault: false } };
  const view = { available: true, identityValid: true, namespaceValid: true, healthy: true, trusted: ids,
    running: { origin: true, openclaw: true, guard: true }, ready: { origin: true, openclaw: true, guard: true },
    identities: Object.fromEntries(Object.keys(ids).map(role => [role, { id: ids[role], image: images[role], startedAt }])) };
  const common = { version: 1, profile: 'production', hostSourceCommit: spec.sourceCommit, runtimeImage: images.openclaw,
    containerId: ids.openclaw, containerStartedAt: startedAt, observedAt: new Date(time).toISOString(), restartRecommended: false };
  const reports = {
    model: { ...common, state: 'credentials-present', remoteVerified: false, warnings: [], token: 'SECRET' },
    ledger: { ...common, originId: ids.origin, originImage: images.origin, originStartedAt: startedAt,
      http: { state: 'accepted-read-only' }, mcp: { state: 'accepted-read-only' }, businessWrites: false, accountIdentityVerified: false, account: 'PRIVATE' },
    weixin: { ...common, state: 'last-poll-accepted', remoteVerified: false, messageAcceptanceVerified: false,
      pollObservedAt: new Date(time - 1000).toISOString(), accountId: 'PRIVATE' },
    tunnel: { containerId: ids.guard, containerStartedAt: startedAt, raw: { version: 1, state: 'tunnel-ready', updatedAt: time,
      tunnel: { authorization: 'last-registration-accepted', diagnostic: 'registration-accepted', publisherRunning: true,
        authorizationObservedAt: time - 1000, diagnosticObservedAt: time - 1000, secret: 'SECRET' } } },
  };
  return { spec, now: () => time, count: () => probesCalled,
    readContext: async () => { const value = structuredClone(context); options.context?.(value, ++contexts); return value; },
    inspect: async () => { const value = structuredClone(view); options.view?.(value, ++inspections); return value; },
    probes: Object.fromEntries(Object.keys(reports).map(name => [name, async () => {
      probesCalled++; if (options.fail === name) throw Error('SECRET');
      const value = structuredClone(reports[name]); options.report?.(name, value); return value;
    }])) };
}
test('production overview aggregates four authorization sources without revealing runtime or account identities', async () => {
  const f = fixture(), result = await collectProductionStatus(f);
  assert.equal(result.state, 'healthy'); assert.equal(result.boundaryHealthy, true); assert.equal(f.count(), 4);
  assert.equal(result.modelAuthorization.state, 'credentials-present'); assert.equal(result.ledgerAuthorization.http.state, 'accepted-read-only');
  assert.equal(result.weixinAuthorization.state, 'last-poll-accepted'); assert.equal(result.tunnelAuthorization.state, 'observed');
  assert.equal(result.remoteAcceptanceVerified, false);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE|containerId|originId|runtimeImage|cutoverId/);
});
test('disabled, maintenance, storage fault and unhealthy boundaries never launch credential checks', async () => {
  for (const option of [
    { context: value => { value.enabled = false; } },
    { context: value => { value.maintenance = true; } },
    { context: value => { value.storageFault = true; } },
    { context: value => { value.host.state = 'healthy-low-disk'; } },
    { view: value => { value.healthy = false; value.ready.guard = false; } },
    { view: value => { value.available = false; } },
    { view: value => { value.identityValid = false; } },
  ]) {
    const f = fixture(option), result = await collectProductionStatus(f);
    assert.equal(f.count(), 0); assert.equal(result.boundaryHealthy, false);
    assert.equal(result.ledgerAuthorization.http.state, 'inspection-unavailable');
  }
});
test('wrong gate, pid, generation, future or stale host reports fail before credential access', async () => {
  for (const change of [v => { v.gate.cutoverId = 'wrong'; }, v => { v.host.pid++; }, v => { v.host.volumeGeneration = 'different'; },
    v => { v.host.updatedAt = new Date(time - 45000).toISOString(); }, v => { v.host.updatedAt = new Date(time + 1).toISOString(); }]) {
    const f = fixture({ context: change }); assert.equal((await collectProductionStatus(f)).state, 'inspection-unavailable'); assert.equal(f.count(), 0);
  }
});
test('maintenance, process replacement and any container restart during checks discard captured acceptance', async () => {
  const changes = [
    { context: (v, n) => { if (n > 1) v.maintenance = true; } },
    { context: (v, n) => { if (n > 1) { v.pid++; v.host.pid++; } } },
    ...Object.keys(ids).map(role => ({ view: (v, n) => { if (n > 1) v.identities[role].startedAt = new Date(time - 1000).toISOString(); } })),
  ];
  for (const option of changes) { const r = await collectProductionStatus(fixture(option));
    assert.equal(r.state, 'inspection-unavailable'); assert.equal(r.boundaryHealthy, false); assert.equal(r.modelAuthorization.state, 'inspection-unavailable'); }
});
test('one failed probe remains unavailable while other sources retain their own verified scope', async () => {
  const r = await collectProductionStatus(fixture({ fail: 'ledger' }));
  assert.equal(r.boundaryHealthy, true); assert.equal(r.ledgerAuthorization.state, 'inspection-unavailable');
  assert.equal(r.modelAuthorization.state, 'credentials-present'); assert.equal(r.weixinAuthorization.state, 'last-poll-accepted');
});
test('historical guard output, stale poll evidence and another profile cannot become current authorization', async () => {
  const r = await collectProductionStatus(fixture({ report: (name, value) => {
    if (name === 'tunnel') value.containerStartedAt = 'changed';
    if (name === 'model') value.profile = 'isolated-test';
    if (name === 'weixin') value.pollObservedAt = new Date(time - 300001).toISOString();
  } }));
  assert.equal(r.tunnelAuthorization.state, 'inspection-unavailable'); assert.equal(r.modelAuthorization.state, 'inspection-unavailable');
  assert.equal(r.weixinAuthorization.state, 'poll-stale');
});
