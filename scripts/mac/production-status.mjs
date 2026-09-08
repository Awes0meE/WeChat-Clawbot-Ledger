import assert from 'node:assert/strict';
import { activationMatches } from './managed-host-release.mjs';
import { visibleModelAuthorization } from './model-authorization.mjs';
import { visibleLedgerAuthorization } from './ledger-authorization-inspection.mjs';
import { visibleWeixinAuthorization } from './weixin-authorization-inspection.mjs';
import { summarizeTunnelStatus } from './tunnel-authorization-inspection.mjs';

const hostStates = new Set(['healthy', 'maintenance', 'disabled', 'another-operation', 'host-needs-attention',
  'waiting-for-docker', 'stopped-low-disk', 'low-disk-no-restart', 'healthy-low-disk', 'guard-unready',
  'recovery-backoff', 'storage-fault-latched', 'identity-needs-attention', 'activation-needs-attention', 'recovery-needs-attention']);
function hostState(context, spec, now) {
  if (!context?.enabled) return 'disabled';
  assert.ok(activationMatches(context.gate, spec));
  assert.ok(context.installed === true && Number.isSafeInteger(context.pid) && context.pid > 0);
  const h = context.host;
  assert.ok(h?.version === 1 && h.pid === context.pid && h.sourceCommit === spec.sourceCommit
    && (h.volumeGeneration ?? null) === (spec.volumeGeneration ?? null));
  const age = now - Date.parse(h.updatedAt); assert.ok(Number.isFinite(age) && age >= 0 && age < 45000);
  if (context.storageFault || h.storageFault) return 'storage-fault';
  if (context.maintenance) return 'maintenance';
  assert.ok(hostStates.has(h.state)); return h.state;
}
function identity(view) {
  assert.ok(view?.available && view.identityValid && view.namespaceValid);
  const selected = {};
  for (const role of ['origin', 'openclaw', 'guard']) {
    const row = view.identities?.[role];
    assert.match(view.trusted?.[role] ?? '', /^[a-f0-9]{64}$/);
    assert.ok(row?.id === view.trusted[role] && typeof view.running?.[role] === 'boolean' && typeof view.ready?.[role] === 'boolean');
    assert.match(row.image, /^sha256:[a-f0-9]{64}$/); assert.ok(Number.isFinite(Date.parse(row.startedAt)));
    selected[role] = { id: row.id, image: row.image, startedAt: row.startedAt, running: view.running[role] };
  }
  return selected;
}
// Inputs are provided by the local read-only adapter. The context is checked
// before and after diagnostics, so a new gate, generation, process, maintenance
// state, container or restart invalidates the whole captured result.
export async function collectProductionStatus({ spec, readContext, inspect, probes, now = Date.now }) {
  const base = { version: 1, profile: 'production', updatedAt: new Date(now()).toISOString(), state: 'inspection-unavailable',
    boundaryHealthy: false, services: [], businessWrites: false, remoteAcceptanceVerified: false,
    modelAuthorization: visibleModelAuthorization(), ledgerAuthorization: visibleLedgerAuthorization(),
    weixinAuthorization: visibleWeixinAuthorization(), tunnelAuthorization: { version: 1, state: 'inspection-unavailable', remoteVerified: false } };
  try {
    const context = await readContext(), state = hostState(context, spec, now());
    if (state === 'disabled') return { ...base, state };
    const view = await inspect();
    if (!view.available) return { ...base, state: 'waiting-for-docker' };
    if (!view.identityValid || !view.namespaceValid) return { ...base, state: 'identity-needs-attention' };
    const before = identity(view);
    const services = ['origin', 'openclaw', 'guard'].map(name => ({ name, running: view.running[name],
      health: view.ready[name] ? 'healthy' : view.running[name] ? 'not-ready' : 'stopped' }));
    const result = { ...base, state, services, boundaryHealthy: state === 'healthy' && view.healthy === true
      && services.every(s => s.running && s.health === 'healthy') };
    if (!result.boundaryHealthy) return result;
    const expected = { profile: 'production', sourceCommit: spec.sourceCommit, runtimeImage: before.openclaw.image,
      containerId: before.openclaw.id, containerStartedAt: before.openclaw.startedAt,
      originId: before.origin.id, originImage: before.origin.image, originStartedAt: before.origin.startedAt };
    const names = ['model', 'ledger', 'weixin', 'tunnel'];
    const checks = await Promise.allSettled(names.map(name => probes[name]()));
    const afterContext = await readContext(), afterState = hostState(afterContext, spec, now());
    assert.equal(afterState, 'healthy'); assert.equal(afterContext.pid, context.pid);
    assert.deepEqual(afterContext.gate, context.gate);
    const afterView = await inspect(); assert.deepEqual(identity(afterView), before); assert.equal(afterView.healthy, true);
    const value = name => { const r = checks[names.indexOf(name)]; return r.status === 'fulfilled' ? r.value : undefined; };
    result.modelAuthorization = visibleModelAuthorization(value('model'), expected, now());
    result.ledgerAuthorization = visibleLedgerAuthorization(value('ledger'), expected, now());
    result.weixinAuthorization = visibleWeixinAuthorization(value('weixin'), expected, now());
    const tunnel = value('tunnel');
    if (tunnel?.containerId === before.guard.id && tunnel.containerStartedAt === before.guard.startedAt
      && tunnel.raw?.updatedAt >= Date.parse(before.guard.startedAt)) result.tunnelAuthorization = summarizeTunnelStatus(tunnel.raw, now());
    result.updatedAt = new Date(now()).toISOString();
    return result;
  } catch { return { ...base, updatedAt: new Date(now()).toISOString() }; }
}
