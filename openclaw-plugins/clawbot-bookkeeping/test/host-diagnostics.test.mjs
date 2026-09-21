import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { hostDiagnostics, diagnosticError } from '../../../scripts/mac/host-diagnostics.mjs';
import { managedDockerDriver } from '../../../scripts/mac/managed-docker-driver.mjs';

const native = { skip: process.platform === 'win32' };
function temp() { return realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-diagnostics-'))); }
test('Failures retain stage, timeout and exit metadata without command, token or stderr contents', async () => {
  const secret = 'PRIVATE_TOKEN_AND_WECHAT_TEXT', events = []; let time = 0;
  const d = managedDockerDriver({}, 'secret-compose-path', { clock: () => time, onDiagnostic: event => events.push(event),
    execute: async () => { time = 20001; throw Object.assign(Error(secret), { code: null, killed: true, signal: 'SIGTERM', stderr: secret }); } });
  await assert.rejects(d.run(['exec', secret]), error => error.message === 'CLAWBOT_DOCKER_OPERATION_FAILED' && error.diagnostic.timedOut);
  assert.equal(events.at(-1).phase, 'docker.exec'); assert.equal(events.at(-1).error.elapsedMs, 20001);
  assert.equal(events.at(-1).error.timeoutMs, 20000); assert.equal(JSON.stringify(events).includes(secret), false);
  assert.equal(diagnosticError({ stderr: `write failed: no space left on device ${secret}`, code: 1 }).kind, 'disk-full');
  assert.equal(diagnosticError({ stderr: secret, code: 125 }).code, 125);
});
test('Storage helper failure remains fail-closed and carries the actual failure diagnostic', async () => {
  const events = [], spec = { project: 'clawbot-production', profile: 'production', root: '/state', cutoverId: 'test',
    volumeGeneration: null, services: { openclaw: { image: 'synthetic', mounts: [['ledger-data', '/ledger']] } } };
  const d = managedDockerDriver(spec, 'fixture', { onDiagnostic: event => events.push(event), execute: async (_, args) => {
    if (args[0] === 'volume') return { stdout: JSON.stringify([{ Name: 'clawbot-production_ledger-data', Driver: 'local', Options: {},
      Labels: { 'clawbot.project': spec.project, 'clawbot.volume': 'ledger-data', 'clawbot.cutover': spec.cutoverId } }]) };
    throw Object.assign(Error('sensitive command'), { code: 125, stderr: 'Cannot connect to the Docker daemon' });
  } });
  const storage = await d.storage(); assert.equal(storage.error, 'STORAGE_UNAVAILABLE');
  assert.equal(storage.diagnostic.kind, 'daemon-unavailable'); assert.equal(storage.diagnostic.code, 125);
  assert.ok(events.some(e => e.phase === 'storage.volume-free' && e.event === 'command-failed'));
});
test('Observer failures cannot turn successful driver operations into failures', async () => {
  const d = managedDockerDriver({}, 'fixture', { execute: async () => ({ stdout: 'ok\n' }), onDiagnostic: () => { throw Error('disk failure'); } });
  assert.equal(await d.run(['info']), 'ok');
});
test('Bounded rotation and durable incident snapshots retain pre-failure chronology across restart', native, () => {
  const root = temp(), dir = join(root, 'logs');
  try {
    const options = { sampleBytes: 1600, eventBytes: 800, sampleFiles: 3, eventFiles: 2, incidentFiles: 2, incidentBytes: 4000 };
    const d = hostDiagnostics(dir, options), at = '2026-09-20T00:00:00.000Z';
    for (let i = 0; i < 50; i++) assert.equal(d.record({ event: 'sample', state: 'healthy', sequence: i, at, token: 'DO_NOT_LOG' }), true);
    const restarted = hostDiagnostics(dir, options);
    for (let i = 0; i < 6; i++) assert.equal(restarted.record({ event: 'storage-fault', phase: 'storage.volume-free', sequence: 50 + i,
      error: diagnosticError({ code: 'ETIMEDOUT' }) }, { incident: true }), true);
    const incident = JSON.parse(readFileSync(join(dir, 'incident.json')));
    assert.ok(incident.before.length > 0); assert.equal(incident.before.at(-1).at, at);
    assert.equal(incident.before.at(-1).sequence, 49); assert.equal(incident.trigger.event, 'storage-fault');
    assert.ok(readdirSync(dir).length <= 7);
    for (const name of readdirSync(dir)) { assert.equal(statSync(join(dir, name)).mode & 0o077, 0); assert.ok(statSync(join(dir, name)).size <= 4001); }
    assert.equal(readdirSync(dir).map(n => readFileSync(join(dir, n), 'utf8')).join('').includes('DO_NOT_LOG'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('Symlink and hardlink destinations are refused without modifying their target; failures remain observable', native, () => {
  for (const link of [symlinkSync, linkSync]) {
    const root = temp(), dir = join(root, 'logs');
    try {
      const d = hostDiagnostics(dir), target = join(root, 'unrelated'); writeFileSync(target, 'untouched', { mode: 0o600 });
      link(target, join(dir, 'events.jsonl'));
      assert.equal(d.record({ event: 'host-start' }), false); assert.equal(readFileSync(target, 'utf8'), 'untouched');
      assert.equal(d.status().healthy, false); assert.ok(d.status().failures > 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
test('Progress is replaced atomically and sensitive extra fields are excluded', native, () => {
  const root = temp(), dir = join(root, 'logs');
  try {
    const d = hostDiagnostics(dir);
    assert.equal(d.progress({ phase: 'storage.volume-free', sequence: 5, argv: ['SECRET'], stderr: 'SECRET' }), true);
    const raw = readFileSync(join(dir, 'progress.json'), 'utf8'); assert.equal(raw.includes('SECRET'), false);
    assert.equal(JSON.parse(raw).phase, 'storage.volume-free');
    assert.equal(d.progress({ phase: 'tick.complete', sequence: 5 }), true);
    assert.equal(JSON.parse(readFileSync(join(dir, 'progress.json'))).phase, 'tick.complete');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('Fatal-exception observation writes a redacted incident without suppressing process failure', native, () => {
  const root = temp(), dir = join(root, 'logs');
  try {
    const source = `import {hostDiagnostics,diagnosticError} from ${JSON.stringify(new URL('../../../scripts/mac/host-diagnostics.mjs', import.meta.url).href)};
      const log=hostDiagnostics(${JSON.stringify(dir)});log.progress({phase:'storage.volume-free',sequence:3});
      process.on('uncaughtExceptionMonitor',error=>log.record({event:'host-crash',phase:'process.uncaught',error:diagnosticError(error)},{incident:true}));
      setImmediate(()=>{throw Error('PRIVATE_FATAL_MESSAGE')});`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 1);
    const raw = readFileSync(join(dir, 'incident.json'), 'utf8'); assert.equal(raw.includes('PRIVATE_FATAL_MESSAGE'), false);
    assert.equal(JSON.parse(raw).trigger.event, 'host-crash');
    const restarted = hostDiagnostics(dir); assert.equal(restarted.previousProgress.phase, 'storage.volume-free');
    assert.equal(restarted.previousProgress.sequence, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('Default incident budget retains 120 representative service and resource samples', native, () => {
  const root = temp(), dir = join(root, 'logs');
  try {
    const d = hostDiagnostics(dir), c = { id: 'a'.repeat(64), running: true, oomKilled: false, exitCode: 0, restartCount: 0,
      startedAt: '2026-09-21T00:00:00Z', finishedAt: '0001-01-01T00:00:00Z', health: 'healthy', failingStreak: 0, lastHealthExitCode: 0 };
    for (let i=0;i<120;i++) d.record({ event:'sample',state:'healthy',sequence:i,codeFingerprint:'b'.repeat(64),
      view:{available:true,identityValid:true,namespaceValid:true,healthy:true,diagnostics:{origin:c,openclaw:c,guard:c}},
      storage:{hostFreeBytes:12*2**30,volumeFreeBytes:200*2**30},resources:{freeMemoryBytes:2**30,totalMemoryBytes:8*2**30,loadAverage:[4,5,6],uptimeSeconds:1000,processRssBytes:40000000},
      stats:Object.fromEntries(['origin','openclaw','guard'].map(r=>[r,{cpuPercent:5,memoryPercent:20,pids:40,memoryUsage:'399.9MiB / 1.925GiB'}])),statsObservedAt:'2026-09-21T00:00:00Z' });
    assert.equal(d.record({event:'storage-fault',phase:'storage.volume-free'},{incident:true}),true);
    assert.equal(JSON.parse(readFileSync(join(dir,'incident.json'))).before.length,120);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
