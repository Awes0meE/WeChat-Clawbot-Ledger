import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync, existsSync, realpathSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readManagedHostRelease } from './managed-host-release.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { storageDecision } from './runtime-controller.mjs';
import { activationReviewTemplate, validateActivationReview } from './activation-review.mjs';
import { operationsRoot, waitForOperationLock } from './operation-lock.mjs';

// Explicit first activation only. Review declarations come from the operator
// after Windows cooperation; they are not proof obtained by remote polling.
const [action, directoryArg, reviewArg] = process.argv.slice(2);
if (!['prepare', 'enable'].includes(action) || !directoryArg || (action === 'enable' && !reviewArg)) throw Error('Usage: activate-production.mjs <prepare|enable> <immutable-host-directory> [private-review-json]');
const directory = resolve(directoryArg), base = join(homedir(), 'Library', 'Application Support', 'Clawbot', 'production-host-releases');
assert.ok(directory.startsWith(base + '/') && realpathSync(directory) === directory);
const { spec } = readManagedHostRelease(directory), driver = managedDockerDriver(spec, join(directory, 'compose.json'));
let unlock = await waitForOperationLock('production-activation'), gateBytes, gateCreated = false;
const gatePath = join(operationsRoot, 'production-enabled.json'), label = 'com.clawbot.mac-production-host';
const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
function run(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  if (result.status !== 0) throw Error('CLAWBOT_ACTIVATION_HOST_COMMAND_FAILED'); return result.stdout;
}
try {
  if (action === 'prepare') {
    const path = join(operationsRoot, `activation-review-${spec.cutoverId}.json`);
    writeFileSync(path, JSON.stringify(activationReviewTemplate(spec), null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ status: 'CLAWBOT_ACTIVATION_REVIEW_PREPARED_ALL_UNCONFIRMED', path }));
  } else {
    const reviewPath = resolve(reviewArg), stat = lstatSync(reviewPath);
    assert.ok(reviewPath.startsWith(operationsRoot + '/') && realpathSync(reviewPath) === reviewPath && stat.isFile()
      && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077) && stat.size < 16384);
    const reviewBytes = readFileSync(reviewPath), review = JSON.parse(reviewBytes);
    validateActivationReview(review, spec);
    for (const path of [gatePath, plist, join(operationsRoot, 'production-maintenance'), join(operationsRoot, 'production-storage-fault.json')]) assert.ok(!existsSync(path), 'Existing activation or maintenance state requires inspection');
    assert.notEqual(spawnSync('/bin/launchctl', ['list', label], { encoding: 'utf8' }).status, 0, 'Production host job already exists');
    const view = await driver.inspect();
    assert.ok(view.available && view.identityValid && view.namespaceValid && Object.values(view.running).every((running) => !running));
    assert.ok(await driver.validateInputs()); assert.equal(storageDecision(await driver.storage()), 'ok');
    const sourcePlist = join(directory, `${label}.plist`), sourceStat = lstatSync(sourcePlist);
    assert.ok(sourceStat.isFile() && !sourceStat.isSymbolicLink() && !(sourceStat.mode & 0o222) && sourceStat.size < 16384);
    const job = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', sourcePlist]));
    assert.deepEqual(job, { Label: label, ProgramArguments: [process.execPath, join(directory, 'production-host.mjs')],
      RunAtLoad: true, KeepAlive: true, ThrottleInterval: 30, StandardOutPath: '/dev/null', StandardErrorPath: '/dev/null' });
    assert.deepEqual(readFileSync(reviewPath), reviewBytes); validateActivationReview(review, spec);
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plist, readFileSync(sourcePlist), { flag: 'wx', mode: 0o600 });
    gateBytes = JSON.stringify({ version: 1, project: spec.project, enabled: true, sourceCommit: spec.sourceCommit,
      cutoverId: spec.cutoverId, sourceSnapshotSha256: spec.sourceSnapshotSha256, importManifestSha256: spec.importManifestSha256,
      volumeGeneration: spec.volumeGeneration ?? null, recoverySourceManifestSha256: spec.recoverySourceManifestSha256 ?? null });
    writeFileSync(gatePath, gateBytes, { flag: 'wx', mode: 0o600 }); gateCreated = true;
    run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]);
    unlock(); unlock = null;
    const started = Date.now(), deadline = started + 240000; let healthy = false;
    while (Date.now() < deadline) {
      try {
        const status = JSON.parse(readFileSync(join(operationsRoot, 'production-host-status.json')));
        if (status.sourceCommit === spec.sourceCommit && status.state === 'healthy' && Date.parse(status.updatedAt) >= started) {
          const current = await driver.inspect();
          if (current.identityValid && current.namespaceValid && current.healthy) { healthy = true; break; }
        }
      } catch {}
      await delay(1000);
    }
    assert.ok(healthy, 'Production readiness did not complete');
    assert.equal(readFileSync(gatePath, 'utf8'), gateBytes, 'Enable gate changed during readiness');
    console.log('CLAWBOT_PRODUCTION_HOST_ACTIVE_REQUIRES_WECHAT_AND_PUBLIC_ACCEPTANCE');
  }
} catch {
  // Removing only our gate prevents further automatic starts. Preserve data
  // and task files for inspection; never roll a database back on this failure.
  if (gateCreated && existsSync(gatePath) && readFileSync(gatePath, 'utf8') === gateBytes) unlinkSync(gatePath);
  if (gateCreated) {
    try {
      unlock ??= await waitForOperationLock('failed-activation-quiesce');
      const view = await driver.inspect();
      for (const role of ['guard', 'openclaw', 'origin']) if (view.trusted?.[role]) await driver.stop(role, view.trusted[role]);
    } catch { console.error('CLAWBOT_FAILED_ACTIVATION_STOP_REQUIRES_INSPECTION'); }
  }
  console.error('CLAWBOT_PRODUCTION_ACTIVATION_FAILED_NEEDS_REVIEW'); process.exitCode = 1;
} finally { unlock?.(); }
