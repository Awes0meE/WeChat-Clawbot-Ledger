import test from 'node:test';
import assert from 'node:assert/strict';
import { managedDockerDriver } from '../../../scripts/mac/managed-docker-driver.mjs';
import { reconcileRuntime } from '../../../scripts/mac/runtime-controller.mjs';

const spec = { project: 'clawbot-production', profile: 'production', root: '/state', sourceCommit: 'a'.repeat(40),
  cutoverId: 'fixture', volumeGeneration: null, services: { openclaw: { image: `sha256:${'b'.repeat(64)}`,
    mounts: [['ledger-data', '/ledger']] } } };
function fixture(input = spec) {
  const f = { calls: [], container: null, template: null, failRun: false, failRemove: false, retainAfterRemove: false,
    mutate: undefined, time: 0, runCount: 0, events: [], disappearAt: undefined, runError: undefined, removeError: undefined,
    output: '8589934592' };
  f.driver = managedDockerDriver(input, 'fixture', { clock: () => f.time, onDiagnostic: event => f.events.push(event),
    execute: async (_, args) => {
      f.calls.push(args);
      if (args[0] === 'volume') return { stdout: JSON.stringify([{ Name: `${input.project}_ledger-data`, Driver: 'local', Options: {},
        Labels: { 'clawbot.project': input.project, 'clawbot.volume': 'ledger-data', 'clawbot.cutover': input.cutoverId,
          ...(input.volumeGeneration ? { 'clawbot.generation': input.volumeGeneration } : {}) } }]) };
      if (args[0] === 'ps') return { stdout: f.container?.Id ?? '' };
      if (args[0] === f.disappearAt && ['inspect', 'rm'].includes(args[0])) {
        f.container = null;
        throw Object.assign(Error('No such container'), { code: 1 });
      }
      if (args[0] === 'inspect') return { stdout: JSON.stringify([f.container]) };
      if (args[0] === 'rm') {
        if (f.removeError) throw f.removeError;
        if (f.failRemove) throw Error('remove refused');
        if (!f.retainAfterRemove) f.container = null;
        return { stdout: '' };
      }
      if (args[0] === 'run') {
        f.runCount++;
        const labels = {};
        for (let i = 0; i < args.length; i++) if (args[i] === '--label') {
          const entry = args[i + 1], pos = entry.indexOf('='); labels[entry.slice(0, pos)] = entry.slice(pos + 1);
        }
        const imageIndex = args.indexOf(input.services.openclaw.image);
        f.container = { Id: 'c'.repeat(64), Name: `/${args[args.indexOf('--name') + 1]}`, Image: input.services.openclaw.image,
          Config: { Image: input.services.openclaw.image, Entrypoint: ['node'], Cmd: args.slice(imageIndex + 1),
            User: '1000:1000', Labels: labels },
          HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: [],
            SecurityOpt: ['no-new-privileges:true'], AutoRemove: true, RestartPolicy: { Name: 'no' }, PidMode: '', IpcMode: 'private' },
          Mounts: [{ Type: 'volume', Name: `${input.project}_ledger-data`, Destination: '/state/ledger', RW: false }] };
        f.mutate?.(f.container);
        f.template = structuredClone(f.container);
        if (f.runError) throw f.runError;
        if (f.failRun) { f.time += 20001; throw Object.assign(Error('timeout'), { killed: true, signal: 'SIGTERM' }); }
        return { stdout: f.output };
      }
      throw Error(`unexpected command ${args[0]}`);
    } });
  return f;
}
test('Named capacity probe carries exact ownership labels and cleans the verified immutable ID', async () => {
  const f = fixture();
  const result = await f.driver.storage();
  assert.equal(result.volumeFreeBytes, 8589934592);
  assert.match(f.template.Name, /^\/clawbot-storage-[a-f0-9]{24}$/);
  assert.deepEqual(f.template.Config.Labels, { 'clawbot.task': 'storage-capacity-probe', 'clawbot.project': spec.project,
    'clawbot.source': spec.sourceCommit, 'clawbot.generation': 'none' });
  assert.deepEqual(f.calls.find(args => args[0] === 'rm'), ['rm', '--force', 'c'.repeat(64)]);
  assert.equal(f.container, null);
  assert.ok(f.calls[1].includes(`name=^${f.template.Name}$`));
});
test('A lingering prior probe is cleaned before another one can be created', async () => {
  const f = fixture(); await f.driver.storage();
  f.container = structuredClone(f.template); f.calls = [];
  assert.equal((await f.driver.storage()).volumeFreeBytes, 8589934592);
  assert.ok(f.calls.findIndex(args => args[0] === 'rm') < f.calls.findIndex(args => args[0] === 'run'));
  assert.equal(f.runCount, 2); assert.equal(f.container, null);
});
test('Timeout cleans its verified helper, preserves the timeout classification and permits a clean later sample', async () => {
  const f = fixture(); f.failRun = true;
  const result = await f.driver.storage();
  assert.equal(result.error, 'STORAGE_UNAVAILABLE'); assert.equal(result.diagnostic.kind, 'timeout');
  assert.equal(result.diagnostic.timedOut, true); assert.equal(f.container, null);
  assert.ok(Number.isSafeInteger(result.hostFreeBytes));
  f.failRun = false;
  assert.equal((await f.driver.storage()).volumeFreeBytes, 8589934592);
});
test('Cleanup failure rejects successful measurements and blocks further helper creation', async () => {
  const f = fixture(); f.failRemove = true;
  assert.equal((await f.driver.storage()).error, 'STORAGE_UNAVAILABLE');
  assert.equal((await f.driver.storage()).error, 'STORAGE_UNAVAILABLE');
  assert.equal(f.runCount, 1);
  f.failRemove = false;
  assert.equal((await f.driver.storage()).volumeFreeBytes, 8589934592);
});
test('A cleanup command returning success without disappearance cannot authorize a sample or replacement', async () => {
  const f = fixture(); f.retainAfterRemove = true;
  assert.equal((await f.driver.storage()).error, 'STORAGE_UNAVAILABLE');
  assert.equal((await f.driver.storage()).error, 'STORAGE_UNAVAILABLE');
  assert.equal(f.runCount, 1);
});
test('Unknown same-name containers are never removed, and prevent creating a new probe', async () => {
  const changes = [
    c => { c.Name += '-other'; }, c => { c.Config.Labels['clawbot.task'] = 'business'; },
    c => { c.Config.Labels['clawbot.project'] = 'other'; }, c => { c.Config.Labels['clawbot.source'] = 'other'; },
    c => { c.Config.Labels['clawbot.generation'] = 'other'; }, c => { c.Config.Labels['com.docker.compose.service'] = 'origin'; },
    c => { c.Image = 'other'; }, c => { c.Config.Image = 'other'; }, c => { c.Config.Entrypoint = ['sh']; },
    c => { c.Config.Cmd.push('extra'); }, c => { c.Config.User = 'root'; }, c => { c.HostConfig.NetworkMode = 'host'; },
    c => { c.HostConfig.ReadonlyRootfs = false; }, c => { c.HostConfig.Privileged = true; },
    c => { c.HostConfig.CapDrop = []; }, c => { c.HostConfig.CapAdd = ['SYS_ADMIN']; },
    c => { c.HostConfig.SecurityOpt = []; }, c => { c.HostConfig.AutoRemove = false; },
    c => { c.Mounts[0].Name = 'business-volume'; }, c => { c.Mounts[0].RW = true; },
    c => { c.Mounts.push({ ...c.Mounts[0] }); }, c => { c.HostConfig.Binds = ['/private:/private']; },
  ];
  for (const change of changes) {
    const f = fixture(); await f.driver.storage();
    f.container = structuredClone(f.template); change(f.container); f.calls = [];
    const result = await f.driver.storage();
    assert.equal(result.error, 'STORAGE_UNAVAILABLE'); assert.equal(result.diagnostic.kind, 'unclassified');
    assert.ok(!f.calls.some(args => ['rm', 'run', 'stop'].includes(args[0])));
  }
});
test('Changed identity after a timed-out run is refused rather than force-cleaned', async () => {
  const f = fixture(); f.failRun = true; f.mutate = c => { c.Mounts[0].RW = true; };
  assert.equal((await f.driver.storage()).error, 'STORAGE_UNAVAILABLE');
  assert.ok(!f.calls.some(args => args[0] === 'rm'));
});
test('Probe names are stable within a generation and differ between generations', async () => {
  const a = fixture(), b = fixture({ ...spec, volumeGeneration: 'different-generation' });
  await a.driver.storage(); const name = a.template.Name;
  await a.driver.storage(); assert.equal(a.template.Name, name);
  await b.driver.storage(); assert.notEqual(b.template.Name, name);
});
test('Auto-removal between discovery and inspect or cleanup requires confirmed absence', async () => {
  for (const phase of ['inspect', 'rm']) {
    const f = fixture(); f.disappearAt = phase;
    assert.equal((await f.driver.storage()).volumeFreeBytes, 8589934592);
    assert.equal(f.container, null);
    assert.equal(f.calls.at(-1)[0], 'ps');
  }
});
test('Hard capacity errors cannot be downgraded by a later transient cleanup failure', async () => {
  const hard = [['ENOSPC', 'disk-full'], ['EIO', 'io-error'], ['EROFS', 'read-only-filesystem'],
    ['permission denied', 'permission-denied'], ['unexpected probe failure', 'unclassified']];
  for (const [message, kind] of hard) for (const cleanupMessage of ['timeout', 'Cannot connect to the Docker daemon']) {
    const f = fixture(); f.runError = Error(message); f.removeError = Error(cleanupMessage);
    const result = await f.driver.storage();
    assert.equal(result.error, 'STORAGE_UNAVAILABLE'); assert.equal(result.diagnostic.kind, kind);
    assert.equal(result.volumeFreeBytes, undefined); assert.ok(f.container);
    assert.ok(f.events.some(event => event.event === 'storage-probe-cleanup-failed'));
    await f.driver.storage(); assert.equal(f.runCount, 1);
  }
});
test('Hard cleanup failures override transient probe failures', async () => {
  for (const message of ['timeout', 'Cannot connect to the Docker daemon']) {
    const f = fixture(); f.runError = Error(message); f.removeError = Error('EIO');
    const result = await f.driver.storage();
    assert.equal(result.error, 'STORAGE_UNAVAILABLE'); assert.equal(result.diagnostic.kind, 'io-error');
    assert.equal(result.volumeFreeBytes, undefined);
    await f.driver.storage(); assert.equal(f.runCount, 1);
  }
});
test('Two transient failures remain unavailable and require cleanup before a later probe', async () => {
  for (const runMessage of ['timeout', 'Cannot connect to the Docker daemon']) {
    for (const [cleanupMessage, kind] of [['timeout', 'timeout'], ['Cannot connect to the Docker daemon', 'daemon-unavailable']]) {
      const f = fixture(); f.runError = Error(runMessage); f.removeError = Error(cleanupMessage);
      const result = await f.driver.storage();
      assert.equal(result.error, 'STORAGE_UNAVAILABLE'); assert.equal(result.diagnostic.kind, kind);
      assert.equal(result.volumeFreeBytes, undefined);
      await f.driver.storage(); assert.equal(f.runCount, 1);
      f.runError = undefined; f.removeError = undefined;
      assert.equal((await f.driver.storage()).volumeFreeBytes, 8589934592);
      assert.equal(f.runCount, 2);
    }
  }
});
test('Capacity evidence survives cleanup timeout and retains controller stop and latch decisions', async () => {
  for (const [output, expected, latch] of [['0', 'stopped-low-disk', false], ['invalid', 'storage-fault-latched', true]]) {
    const f = fixture(); f.output = output; f.removeError = Error('timeout');
    const storage = await f.driver.storage(), trace = [];
    assert.equal(storage.error, 'STORAGE_UNAVAILABLE'); assert.equal(storage.diagnostic.kind, 'timeout');
    assert.equal(output === '0' ? storage.volumeFreeBytes === 0 : Number.isNaN(storage.volumeFreeBytes), true);
    const driver = { inspect: async () => ({ available: true, identityValid: true, namespaceValid: true, healthy: true,
      trusted: { guard: 'g', openclaw: 'w', origin: 'o' } }), validateInputs: async () => true,
      stop: async role => trace.push(`stop:${role}`), latchStorageFault: async () => trace.push('latch') };
    const state = { healthyStorageAt: 0, healthyStorageContainers: ['g', 'w', 'o'] };
    assert.equal(await reconcileRuntime(driver, state, { now: 1, storage }), expected);
    assert.deepEqual(trace, [...(latch ? ['latch'] : []), 'stop:guard', 'stop:openclaw', 'stop:origin']);
    await f.driver.storage(); assert.equal(f.runCount, 1);
  }
});
test('Safe measured capacity plus cleanup failure remains unavailable and cannot start or refresh grace', async () => {
  const f = fixture(); f.removeError = Error('timeout');
  const storage = { ...await f.driver.storage(), hostFreeBytes: 40 * 2 ** 30 }, trace = [];
  assert.equal(storage.error, 'STORAGE_UNAVAILABLE'); assert.equal(storage.volumeFreeBytes, 8589934592);
  const driver = { inspect: async () => ({ available: true, identityValid: true, namespaceValid: true, healthy: true,
    trusted: { guard: 'g', openclaw: 'w', origin: 'o' } }), validateInputs: async () => true,
    stop: async role => trace.push(`stop:${role}`), latchStorageFault: async () => trace.push('latch') };
  const state = { healthyStorageAt: 0, healthyStorageContainers: ['g', 'w', 'o'] };
  assert.equal(await reconcileRuntime(driver, state, { now: 59999, storage }), 'storage-observation-grace');
  assert.equal(state.healthyStorageAt, 0); assert.deepEqual(trace, []);
  assert.equal(await reconcileRuntime(driver, state, { now: 60000, storage }), 'storage-observation-paused');
  assert.deepEqual(trace, ['stop:guard', 'stop:openclaw', 'stop:origin']);
  await f.driver.storage(); assert.equal(f.runCount, 1);
});
