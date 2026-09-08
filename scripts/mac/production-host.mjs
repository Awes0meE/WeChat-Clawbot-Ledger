import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManagedHostRelease, activationMatches } from './managed-host-release.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { reconcileRuntime } from './runtime-controller.mjs';
import { acquireOperationLock, waitForOperationLock, operationsRoot } from './operation-lock.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const { spec } = readManagedHostRelease(directory);
mkdirSync(operationsRoot, { recursive: true, mode: 0o700 });
if (realpathSync(operationsRoot) !== operationsRoot || (lstatSync(operationsRoot).mode & 0o077)) throw new Error('CLAWBOT_OPERATIONS_DIRECTORY');
const faultPath = join(operationsRoot, 'production-storage-fault.json');
const state = { storageFault: existsSync(faultPath) };
function atomic(name, value) {
  const path = join(operationsRoot, name), tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { flag: 'w', mode: 0o600 }); renameSync(tmp, path);
}
const driver = managedDockerDriver(spec, join(directory, 'compose.json'), {
  latchStorageFault: () => atomic('production-storage-fault.json', { version: 1, project: spec.project,
    sourceCommit: spec.sourceCommit, cutoverId: spec.cutoverId, volumeGeneration: spec.volumeGeneration ?? null,
    detectedAt: new Date().toISOString(), requiresDataReconciliation: true }),
});
let busy = false, closing = false;
async function tick() {
  if (busy || closing) return;
  busy = true; let unlock, result = 'disabled';
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
      const view = await driver.inspect();
      for (const role of ['guard', 'openclaw', 'origin']) if (view.trusted?.[role]) await driver.stop(role, view.trusted[role]);
      return;
    }
    const maintenance = existsSync(join(operationsRoot, 'production-maintenance'));
    if (maintenance) { result = 'maintenance'; return; }
    state.storageFault ||= existsSync(faultPath);
    const view = await driver.inspect();
    const storage = view.available && view.identityValid ? await driver.storage() : undefined;
    result = await reconcileRuntime(driver, state, { storage });
  } catch (error) { result = error.message === 'CLAWBOT_OPERATION_BUSY' ? 'another-operation' : 'host-needs-attention'; }
  finally {
    try { atomic('production-host-status.json', { version: 1, state: result, sourceCommit: spec.sourceCommit,
      volumeGeneration: spec.volumeGeneration ?? null, pid: process.pid,
      updatedAt: new Date().toISOString(), storageFault: state.storageFault }); } catch {}
    unlock?.(); busy = false;
  }
}
await tick();
if (process.argv.includes('--once')) process.exit(0);
const timer = setInterval(tick, 15000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  closing = true; clearInterval(timer);
  const wait = setInterval(() => { if (!busy) { clearInterval(wait); process.exit(0); } }, 100);
});
