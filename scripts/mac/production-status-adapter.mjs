import assert from 'node:assert/strict';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readManagedHostRelease, activationMatches } from './managed-host-release.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { managedHostJob } from './managed-host-job.mjs';
import { operationsRoot } from './operation-lock.mjs';
import { inspectModelAuthorization } from './model-authorization-inspection.mjs';
import { inspectLedgerAuthorization } from './ledger-authorization-inspection.mjs';
import { inspectWeixinAuthorization } from './weixin-authorization-inspection.mjs';
import { collectProductionStatus } from './production-status.mjs';
import { backgroundAuthorizationChecks } from './background-authorization-checks.mjs';

export function productionStatusAdapter(directory, { backgroundChecks = false } = {}) {
  const { spec } = readManagedHostRelease(directory), driver = managedDockerDriver(spec, join(directory, 'compose.json'));
  const cache = backgroundAuthorizationChecks(); let contextKey, identityKey;
  function bindContext(context) {
    const key = JSON.stringify([context.enabled, context.gate, context.pid, context.maintenance, context.storageFault, context.host?.state]);
    if (key !== contextKey) { cache.invalidate(); contextKey = key; }
    return context;
  }
  function privateFile(name, optional = false) {
    const path = join(operationsRoot, name);
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw error; }
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid()
      && !(stat.mode & 0o077) && stat.size <= 8192 && realpathSync(path) === path);
    return readFileSync(path);
  }
  async function readContext() {
    assert.deepEqual(readManagedHostRelease(directory).spec, spec);
    const gateBytes = privateFile('production-enabled.json', true);
    if (!gateBytes) return bindContext({ enabled: false });
    const gate = JSON.parse(gateBytes); assert.ok(activationMatches(gate, spec));
    const job = managedHostJob(directory); job.installed();
    const live = job.loaded(); assert.ok(!live.starting && /^[1-9]\d*$/.test(live.pid ?? ''));
    return bindContext({ enabled: true, gate, installed: true, pid: Number(live.pid),
      host: JSON.parse(privateFile('production-host-status.json')),
      maintenance: privateFile('production-maintenance', true) !== undefined,
      storageFault: privateFile('production-storage-fault.json', true) !== undefined });
  }
  async function inspect() {
    const view = await driver.inspect();
    if (!view.available || !view.identityValid || !view.namespaceValid) { cache.invalidate(); identityKey = undefined; return view; }
    const format = '{"id":{{json .Id}},"image":{{json .Image}},"startedAt":{{json .State.StartedAt}}}';
    const roles = ['origin', 'openclaw', 'guard'];
    const rows = (await driver.run(['inspect', '--format', format, ...roles.map(role => view.trusted[role])])).split('\n').map(JSON.parse);
    assert.equal(rows.length, roles.length); view.identities = {};
    for (const [i, role] of roles.entries()) { assert.equal(rows[i].id, view.trusted[role]); view.identities[role] = rows[i]; }
    const key = JSON.stringify([view.identities, view.running]);
    if (key !== identityKey) { cache.invalidate(); identityKey = key; }
    return view;
  }
  async function pair() {
    const context = await readContext();
    assert.ok(context.enabled && !context.maintenance && !context.storageFault);
    const view = await inspect();
    assert.ok(view.identityValid && view.namespaceValid && view.running.origin && view.running.openclaw);
    return { origin: view.trusted.origin, openclaw: view.trusted.openclaw };
  }
  const options = { profile: 'production', sourceCommit: spec.sourceCommit };
  const probes = {
    model: () => inspectModelAuthorization({ ...options, inspect: async () => (await pair()).openclaw }),
    ledger: () => inspectLedgerAuthorization({ ...options, inspect: pair }),
    weixin: () => inspectWeixinAuthorization({ ...options, inspect: async () => (await pair()).openclaw }),
    tunnel: async () => {
      const context = await readContext(); assert.ok(context.enabled && !context.maintenance && !context.storageFault);
      const before = await inspect(); assert.ok(before.identityValid && before.namespaceValid && before.running.guard);
      const containerId = before.trusted.guard, containerStartedAt = before.identities.guard.startedAt;
      const raw = JSON.parse(await driver.run(['exec', containerId, 'node', '-e',
        'const f=require("node:fs"),p="/tmp/clawbot-guard-status.json",s=f.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>8192)throw Error();process.stdout.write(f.readFileSync(p,"utf8"))']));
      const after = await inspect(); assert.ok(after.identityValid && after.namespaceValid && after.running.guard
        && after.trusted.guard === containerId && after.identities.guard.startedAt === containerStartedAt);
      return { raw, containerId, containerStartedAt };
    },
  };
  // Tunnel status is live health evidence and expires after ten seconds. Do
  // not retain that snapshot for the five-minute credential-check interval.
  const checks = backgroundChecks ? Object.fromEntries(Object.entries(probes).map(([name, action]) =>
    [name, () => cache.read(name, action, { refreshMs: name === 'tunnel' ? 2000 : 5 * 60000 })])) : probes;
  return { spec, get checksPending() { return cache.pending; },
    boundary: () => collectProductionStatus({ spec, readContext, inspect,
      probes: Object.fromEntries(Object.keys(probes).map(name => [name, () => undefined])) }),
    // Private switch evidence: never include these identities in HTTP output.
    // The UI switch holds the shared operation lock briefly; the business host
    // may report another-operation while leaving its processes unchanged.
    binding: async () => {
      const context = await readContext(), view = await inspect(), h = context.host;
      const age = Date.now() - Date.parse(h?.updatedAt);
      assert.ok(context.enabled && !context.maintenance && !context.storageFault && !h?.storageFault
        && h?.version === 1 && h.pid === context.pid && h.sourceCommit === spec.sourceCommit
        && (h.volumeGeneration ?? null) === (spec.volumeGeneration ?? null)
        && age >= 0 && age < 45000 && ['healthy', 'another-operation'].includes(h.state));
      assert.ok(view.available && view.identityValid && view.namespaceValid && view.healthy
        && ['origin', 'openclaw', 'guard'].every(role => view.running[role] && view.ready[role]));
      return { gate: context.gate, pid: context.pid, identities: view.identities };
    },
    collect: async () => ({ ...await collectProductionStatus({ spec, readContext, inspect, probes: checks }), authorizationChecking: cache.pending }) };
}
