import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readManagedHostRelease, activationMatches } from './managed-host-release.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { reconcileRuntime } from './runtime-controller.mjs';
import { acquireOperationLock, waitForOperationLock, operationsRoot } from './operation-lock.mjs';
import { hostDiagnostics, hostResources, diagnosticError, diagnosticSnapshot } from './host-diagnostics.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const { spec, release } = readManagedHostRelease(directory);
const codeFingerprint = createHash('sha256').update(JSON.stringify(release.files)).digest('hex');
mkdirSync(operationsRoot, { recursive: true, mode: 0o700 });
if (realpathSync(operationsRoot) !== operationsRoot || (lstatSync(operationsRoot).mode & 0o077)) throw new Error('CLAWBOT_OPERATIONS_DIRECTORY');
const faultPath = join(operationsRoot, 'production-storage-fault.json');
const state = { storageFault: existsSync(faultPath) };
const diagnostics = hostDiagnostics(join(operationsRoot, 'runtime-diagnostics'));
let sequence = 0, phase = 'startup', lastError, storage, view, stats, statsObservedAt, lastStatsAt = 0, previousState, previousTickAt, tickGapMs;
const snapshot = event => ({ event, phase, sequence, tickGapMs, codeFingerprint, error: lastError, storage, view, resources: hostResources(), stats, statsObservedAt });
function atomic(name, value) {
  const path = join(operationsRoot, name), tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { flag: 'w', mode: 0o600 }); renameSync(tmp, path);
}
const driver = managedDockerDriver(spec, join(directory, 'compose.json'), {
  onDiagnostic: event => {
    phase = event.phase;
    if (event.error) lastError = event.error;
    if (event.event === 'command-start') {
      diagnostics.progress({ ...event, sequence });
      if (event.phase.startsWith('lifecycle.')) diagnostics.record({ ...event, sequence });
    }
    else diagnostics.record({ ...event, sequence });
  },
  latchStorageFault: () => {
    // Retain the first failure and its pre-stop evidence, including through
    // subsequent failed samples. Recovery review hashes this exact file.
    if (existsSync(faultPath)) return;
    const evidence = snapshot('storage-fault');
    diagnostics.record(evidence, { incident: true });
    atomic('production-storage-fault.json', { version: 1, project: spec.project,
      sourceCommit: spec.sourceCommit, cutoverId: spec.cutoverId, volumeGeneration: spec.volumeGeneration ?? null,
      detectedAt: new Date().toISOString(), requiresDataReconciliation: true, diagnostic: diagnosticSnapshot(evidence) });
  },
});
if (diagnostics.previousProgress) diagnostics.record({ ...diagnostics.previousProgress, event: 'previous-progress' });
diagnostics.record(snapshot('host-start'));
// Observe fatal exceptions without intercepting Node's normal termination.
process.on('uncaughtExceptionMonitor', error => {
  diagnostics.record({ ...snapshot('host-crash'), phase: 'process.uncaught', error: diagnosticError(error) }, { incident: true });
});
let busy = false, closing = false;
async function tick() {
  if (busy || closing) return;
  busy = true; let unlock, result = 'disabled';
  const started = Date.now(); sequence++; lastError = undefined; storage = undefined; view = undefined; phase = 'tick.start';
  tickGapMs = previousTickAt === undefined ? null : started - previousTickAt; previousTickAt = started;
  if (tickGapMs > 45000) diagnostics.record(snapshot('sampling-gap'), { incident: true });
  diagnostics.progress({ event: 'tick-start', phase, sequence });
  try {
    const gatePath = join(operationsRoot, 'production-enabled.json');
    let enabled = false;
    try {
      const stat = lstatSync(gatePath);
      enabled = stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.size < 4096
        && activationMatches(JSON.parse(readFileSync(gatePath)), spec);
    } catch {}
    unlock = process.argv.includes('--once') ? await waitForOperationLock('production-recovery') : acquireOperationLock('production-recovery');
    // A disabled release cannot start anything. It can close its own verified
    // services if its enable gate was removed after a previous activation.
    if (!enabled) {
      view = await driver.inspect();
      for (const role of ['guard', 'openclaw', 'origin']) if (view.trusted?.[role]) await driver.stop(role, view.trusted[role]);
      return;
    }
    const maintenance = existsSync(join(operationsRoot, 'production-maintenance'));
    if (maintenance) { result = 'maintenance'; return; }
    state.storageFault ||= existsSync(faultPath);
    view = await driver.inspect();
    storage = !state.storageFault && view.available && view.identityValid ? await driver.storage() : undefined;
    // Use the same inspected identity that authorized this sample. A second
    // inspection used to turn a recovered Docker query + no sample into a fault.
    result = await reconcileRuntime(driver, state, { storage, view });
  } catch (error) {
    result = error.message === 'CLAWBOT_OPERATION_BUSY' ? 'another-operation' : 'host-needs-attention';
    if (result !== 'another-operation') lastError = error.diagnostic ?? diagnosticError(error);
  }
  finally {
    // Optional resource sampling is bounded and cannot change controller
    // decisions or skip a stop. Release the operation lock before doing it.
    unlock?.(); unlock = undefined;
    if (result === 'healthy' && view?.healthy && Date.now() - lastStatsAt >= 60000) {
      const controlPhase = phase, controlError = lastError;
      lastStatsAt = Date.now();
      try { stats = await driver.diagnosticStats(); statsObservedAt = new Date().toISOString(); }
      catch { stats = undefined; statsObservedAt = undefined; }
      phase = controlPhase; lastError = controlError;
    }
    const sample = { ...snapshot('sample'), state: result, elapsedMs: Date.now() - started };
    diagnostics.record(sample);
    if (result !== previousState) {
      diagnostics.record({ ...sample, event: 'state-change' }, { incident: !['healthy', 'disabled', 'maintenance', 'another-operation'].includes(result) });
      previousState = result;
    }
    diagnostics.progress({ ...sample, phase: 'tick.complete' });
    try { atomic('production-host-status.json', { version: 1, state: result, sourceCommit: spec.sourceCommit,
      volumeGeneration: spec.volumeGeneration ?? null, pid: process.pid,
      updatedAt: new Date().toISOString(), storageFault: state.storageFault, hostCodeSha256: codeFingerprint, diagnostics: diagnostics.status() }); } catch (error) {
      diagnostics.record({ event: 'status-write-failed', phase: 'status.write', sequence, error: diagnosticError(error) }, { incident: true });
    }
    busy = false;
  }
}
await tick();
if (process.argv.includes('--once')) process.exit(0);
const timer = setInterval(tick, 15000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  diagnostics.record({ ...snapshot('host-stop'), phase: signal === 'SIGTERM' ? 'signal.sigterm' : 'signal.sigint' });
  closing = true; clearInterval(timer);
  const wait = setInterval(() => { if (!busy) { clearInterval(wait); process.exit(0); } }, 100);
});
