import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForOperationLock } from './operation-lock.mjs';
import { managedRuntimeSpec, managedCompose } from './managed-runtime-spec.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { reconcileRuntime } from './runtime-controller.mjs';
import { enterMaintenance, leaveMaintenance } from './maintenance-operation.mjs';
import { storageRecoveryTemplate, clearReviewedStorageFault } from './storage-recovery-review.mjs';
import { generationSwitchTemplate, switchGenerationInMaintenance, releaseUpdateSwitchTemplate, switchReleaseUpdateInMaintenance } from './generation-switch.mjs';
import { validateOriginConfig } from '../../deploy/guard/origin-identity.mjs';

const exec = promisify(execFile), docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const env = { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}` };
async function run(args, input, timeout = 30000) {
  // execFile does not accept input; use only non-secret command arguments here.
  return (await exec(docker, args, { env, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
}
const unlock = await waitForOperationLock('three-service-rehearsal');
const nonce = randomBytes(6).toString('hex'), project = `clawbot-rehearsal-${nonce}`;
const folder = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-runtime-'))), created = [];
let spec, driver, stage = 'setup';
try {
  const image = JSON.parse(await run(['image', 'inspect', 'clawbot-guard-rehearsal:p2']))[0].Id;
  spec = managedRuntimeSpec({ profile: 'rehearsal', project, runtimeImage: image, guardImage: image, sourceCommit: 'a'.repeat(40) });
  const compose = managedCompose(spec), path = join(folder, 'compose.json');
  writeFileSync(path, JSON.stringify(compose), { mode: 0o400 });
  // Fresh fixture ledger and secrets are synthetic. No production/test OAuth,
  // WeChat account, original receipts or user ledger are copied into this lab.
  let ini = readFileSync(new URL('../../deploy/docker/ezbookkeeping.test.ini', import.meta.url), 'utf8')
    .replace('__GENERATE_LOCAL_TEST_SECRET__', randomBytes(32).toString('hex'));
  // The rehearsal does not have the interactive bootstrap password volume.
  ini = ini.split('\n').filter((line) => !line.includes('/bootstrap/')).join('\n');
  const policy = { version: 1, profile: 'isolated-test', root: spec.root, port: 18888,
    configPath: `${spec.root}/config/ezbookkeeping.ini`, dbPath: `${spec.root}/ledger/data/ezbookkeeping-test.db`,
    configSha256: createHash('sha256').update(ini).digest('hex') };
  validateOriginConfig(ini, policy);
  stage = 'fixture-volumes';
  for (const role of Object.keys(compose.volumes)) {
    const name = `${project}_${role}`;
    assert.equal(await run(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${name}$`]), '');
    await run(['volume', 'create', '--label', `clawbot.project=${project}`, '--label', `clawbot.volume=${role}`, name]); created.push(name);
  }
  // Synthetic setup text is staged only in a private temporary fixture file.
  writeFileSync(join(folder, 'setup.json'), JSON.stringify({ ini, policy }), { mode: 0o600 });
  stage = 'fixture-files';
  await run(['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER',
    '--cap-add', 'DAC_OVERRIDE', '--mount', `type=bind,src=${folder},dst=/fixture,readonly`,
    ...[['ledger-config', '/config'], ['ledger-data', '/ledger'], ['guard-config', '/guard']].flatMap(([name, target]) =>
      ['--mount', `type=volume,src=${project}_${name},dst=${target}`]), '--entrypoint', 'node', image, '--input-type=module', '-e',
    'import{readFileSync,writeFileSync,mkdirSync,chownSync,chmodSync}from"node:fs";const x=JSON.parse(readFileSync("/fixture/setup.json"));for(const p of["/config","/ledger","/guard","/ledger/data","/ledger/log","/ledger/storage"]){mkdirSync(p,{recursive:true});chownSync(p,1000,1000);chmodSync(p,0o700)};for(const[p,s]of[["/config/ezbookkeeping.ini",x.ini],["/guard/policy.json",JSON.stringify(x.policy)]]){writeFileSync(p,s,{mode:0o400});chownSync(p,1000,1000)}']);
  const composeArgs = ['compose', '-f', path];
  let latch = false;
  driver = managedDockerDriver(spec, path, { latchStorageFault: () => { latch = true; }, validateRehearsalInputs: () => true });
  stage = 'initial-provision';
  const prepared = await driver.createStopped();
  assert.ok(Object.values(prepared.running).every((running) => !running));
  await assert.rejects(driver.createStopped(), /CLAWBOT_INITIAL_RUNTIME_EXISTS/);
  console.log('CLAWBOT_THREE_SERVICE_OK:initial-create-stopped-repeat-refused');
  stage = 'initial-start';
  const storage = await driver.storage();
  assert.equal(await reconcileRuntime(driver, {}, { storage }), 'healthy');
  let view = await driver.inspect();
  stage = 'initial-identity';
  assert.ok(view.identityValid && view.namespaceValid && view.healthy, 'Initial three-service identity');
  assert.equal(await reconcileRuntime(driver, {}, { storage }), 'healthy');
  console.log('CLAWBOT_THREE_SERVICE_OK:healthy-boundary');
  if (!process.argv.includes('--switch-only')) {
    stage = 'maintenance';
    let paused = false;
    await enterMaintenance(driver, () => { paused = true; });
    assert.equal(await reconcileRuntime(driver, {}, { storage, maintenance: paused }), 'maintenance');
    assert.ok(Object.values((await driver.inspect()).running).every((running) => !running));
    await leaveMaintenance(driver, { storageFault: false, remove: () => { paused = false; } });
    assert.equal(await reconcileRuntime(driver, {}, { storage, maintenance: paused }), 'healthy');
    view = await driver.inspect();
    console.log('CLAWBOT_THREE_SERVICE_OK:maintenance-stop-and-resume');
    stage = 'guard-crash';
    await run(['kill', '--signal', 'KILL', view.trusted.guard]);
    assert.equal(await reconcileRuntime(driver, {}, { storage }), 'healthy');
    console.log('CLAWBOT_THREE_SERVICE_OK:guard-crash-recovery');
    stage = 'origin-replacement';
    view = await driver.inspect();
    await driver.stop('guard', view.trusted.guard); await driver.stop('openclaw', view.trusted.openclaw);
    await run([...composeArgs, 'up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '60', 'origin'], undefined, 90000);
    const replaced = await driver.inspect(); assert.notEqual(replaced.trusted.origin, view.trusted.origin); assert.equal(replaced.namespaceValid, false);
    assert.equal(await reconcileRuntime(driver, {}, { storage }), 'healthy');
    console.log('CLAWBOT_THREE_SERVICE_OK:namespace-rebound');
    stage = 'low-space';
    const state = {};
    assert.equal(await reconcileRuntime(driver, state, { storage: { ...storage, volumeFreeBytes: 1024 } }), 'stopped-low-disk');
    view = await driver.inspect(); assert.ok(Object.values(view.running).every((running) => !running));
    assert.equal(await reconcileRuntime(driver, state, { storage: { ...storage, volumeFreeBytes: 3 * 2 ** 30 } }), 'stopped-low-disk');
    assert.equal(await reconcileRuntime(driver, state, { storage }), 'healthy');
    console.log('CLAWBOT_THREE_SERVICE_OK:low-space-stop-and-hysteresis');
    stage = 'real-enospc';
    // Fill only a 1 MiB tmpfs and feed the actual kernel ENOSPC into the same
    // storage-fault path. Never fill the Mac disk or any persistent volume.
    const failure = await run(['run', '--rm', '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
      '--tmpfs', '/fault:rw,nosuid,nodev,size=1m,mode=1777', '--entrypoint', 'node', image, '--input-type=module', '-e',
      'import{writeFileSync}from"node:fs";try{writeFileSync("/fault/full",Buffer.alloc(2**21));console.log("unexpected")}catch(e){console.log(e.code)}']);
    assert.equal(failure, 'ENOSPC');
    const sqlite = JSON.parse(await run(['run', '--rm', '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
      '--tmpfs', '/fault:rw,nosuid,nodev,size=1m,mode=1777', '--entrypoint', 'node', image, '--input-type=module', '-e',
      'import{DatabaseSync}from"node:sqlite";const d=new DatabaseSync("/fault/check.db");d.exec("CREATE TABLE t(v BLOB); INSERT INTO t VALUES (zeroblob(16)); BEGIN");let full=false;try{d.exec("INSERT INTO t VALUES (zeroblob(2097152)); COMMIT")}catch(e){full=e.errcode===13;try{d.exec("ROLLBACK")}catch{}};const count=d.prepare("SELECT count(*) n FROM t").get().n,ok=d.prepare("PRAGMA integrity_check").get().integrity_check==="ok";d.close();console.log(JSON.stringify({full,count,ok}));']));
    assert.deepEqual(sqlite, { full: true, count: 1, ok: true });
    assert.equal(await reconcileRuntime(driver, state, { storage: { error: failure } }), 'storage-fault-latched');
    assert.ok(latch); assert.equal(await reconcileRuntime(driver, state, { storage }), 'storage-fault-latched');
    view = await driver.inspect(); assert.ok(Object.values(view.running).every((running) => !running));
    console.log('CLAWBOT_THREE_SERVICE_OK:real-enospc-latched');
    stage = 'reviewed-storage-recovery';
    let recoveringInMaintenance = true, fixtureHostStopped = false, fixtureHostRestarted = false;
    const evidence = { faultSha256: '1'.repeat(64), backupManifestSha256: '2'.repeat(64), dataAuditSha256: '3'.repeat(64) };
    const review = storageRecoveryTemplate(spec, evidence);
    review.reviewedAt = new Date().toISOString();
    for (const key of Object.keys(review.checks)) review.checks[key] = true;
    // Review declarations and host callbacks are synthetic in this lab; the
    // common operation checks the real three-container driver and actual disk.
    await clearReviewedStorageFault({ driver, spec, review, evidence,
      verifyEvidence: async () => { assert.ok(recoveringInMaintenance && latch); },
      stopHost: async () => { fixtureHostStopped = true; },
      archiveAndClear: async () => { assert.ok(fixtureHostStopped); latch = false; },
      restartHost: async () => { assert.ok(recoveringInMaintenance && !latch); fixtureHostRestarted = true; },
    });
    assert.ok(fixtureHostRestarted);
    const restartedState = {};
    assert.equal(await reconcileRuntime(driver, restartedState, { storage, maintenance: recoveringInMaintenance }), 'maintenance');
    view = await driver.inspect(); assert.ok(Object.values(view.running).every(running => !running));
    await leaveMaintenance(driver, { storageFault: latch, remove: () => { recoveringInMaintenance = false; } });
    assert.equal(await reconcileRuntime(driver, restartedState, { storage }), 'healthy');
    console.log('CLAWBOT_THREE_SERVICE_OK:reviewed-fault-release-maintenance-and-ordered-resume');
  }
  stage = 'generation-host-switch';
  await assert.rejects(driver.retireStopped(), /STOPPED_IDENTITY/);
  let switchMaintenance = false;
  await enterMaintenance(driver, () => { switchMaintenance = true; });
  const updateMode = process.argv.includes('--verify-release-update');
  const nextImage = updateMode ? JSON.parse(await run(['image', 'inspect', 'clawbot-guard-update-rehearsal:p5']))[0].Id : image;
  const switchTemplate = updateMode ? releaseUpdateSwitchTemplate : generationSwitchTemplate;
  const performSwitch = updateMode ? switchReleaseUpdateInMaintenance : switchGenerationInMaintenance;
  const switchPrefix = updateMode ? 'CLAWBOT_RELEASE_UPDATE' : 'CLAWBOT_GENERATION';
  const generation = randomUUID(), nextSpec = managedRuntimeSpec({ profile: 'rehearsal', project, runtimeImage: nextImage, guardImage: nextImage,
    sourceCommit: updateMode ? 'b'.repeat(40) : spec.sourceCommit, volumeGeneration: generation, recoverySourceManifestSha256: 'b'.repeat(64) });
  const nextComposePath = join(folder, 'generation-compose.json'); writeFileSync(nextComposePath, JSON.stringify(managedCompose(nextSpec)), { mode: 0o400 });
  const nextDriver = managedDockerDriver(nextSpec, nextComposePath, { validateRehearsalInputs: () => true });
  for (const role of Object.keys(compose.volumes)) {
    const name = `${nextSpec.volumePrefix}_${role}`;
    await run(['volume', 'create', '--label', `clawbot.project=${project}`, '--label', `clawbot.volume=${role}`, '--label', `clawbot.generation=${generation}`, name]); created.push(name);
    await run(['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER',
      '--mount', `type=volume,src=${project}_${role},dst=/source,readonly`, '--mount', `type=volume,src=${name},dst=/target`, '--entrypoint', 'cp', image, '-a', '/source/.', '/target']);
  }
  const stateHash = async prefix => run(['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE',
    ...Object.keys(compose.volumes).flatMap(role => ['--mount', `type=volume,src=${prefix}_${role},dst=/state/${role},readonly`]), '--entrypoint', 'node', image, '-e',
    'const f=require("node:fs"),c=require("node:crypto"),rows=[];function walk(p){const s=f.lstatSync("/state/"+p);if(s.isSocket())return;rows.push([p,s.mode,s.uid,s.gid,s.isSymbolicLink()?f.readlinkSync("/state/"+p):s.isFile()?c.createHash("sha256").update(f.readFileSync("/state/"+p)).digest("hex"):null]);if(s.isDirectory())for(const n of f.readdirSync("/state/"+p).sort())walk(p+"/"+n)};for(const p of f.readdirSync("/state").sort())walk(p);console.log(c.createHash("sha256").update(JSON.stringify(rows)).digest("hex"));']);
  // A distinct synthetic target proves that selection is not just a restart
  // of identical data. Only the newly created fixture volume is writable.
  if (!updateMode) await run(['run', '--rm', '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
    '--mount', `type=volume,src=${nextSpec.volumePrefix}_ledger-data,dst=/ledger`, '--entrypoint', 'node', image, '-e',
    'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/ledger/data/ezbookkeeping-test.db");d.exec("CREATE TABLE recovery_selection_probe(value TEXT); INSERT INTO recovery_selection_probe VALUES (\'synthetic-target-only\')");d.close();']);
  const initialHash = await stateHash(project), targetHash = await stateHash(nextSpec.volumePrefix);
  if (updateMode) assert.equal(targetHash, initialHash); else assert.notEqual(targetHash, initialHash);
  const switchEvidence = { currentAuditSha256: initialHash, selectedAuditSha256: targetHash };
  const switchReview = switchTemplate(spec, nextSpec, switchEvidence);
  switchReview.reviewedAt = new Date().toISOString(); for (const key of Object.keys(switchReview.checks)) switchReview.checks[key] = true;
  let selection = spec, hostRunning = true, inject = true;
  const switchOptions = { before: spec, after: nextSpec, oldDriver: driver, newDriver: nextDriver, review: switchReview, evidence: switchEvidence,
    verifyData: async () => { assert.ok(switchMaintenance); assert.equal(await stateHash(project), initialHash); assert.equal(await stateHash(nextSpec.volumePrefix), targetHash); },
    stopHost: async selected => { assert.equal(selection, selected); hostRunning = false; },
    selectHost: async selected => { assert.ok(!hostRunning && switchMaintenance); selection = selected; },
    startHost: async selected => { assert.equal(selection, selected); if (inject && selected === nextSpec) { inject = false; throw Error('synthetic-host-bootstrap-failure'); } hostRunning = true; },
    checkpoint: async () => {},
  };
  const createCompleteTarget = nextDriver.createStopped.bind(nextDriver);
  nextDriver.createStopped = async () => {
    await nextDriver.run(['compose', '-f', nextComposePath, 'create', '--no-build', '--pull', 'never', 'origin']);
    nextDriver.createStopped = createCompleteTarget;
    throw Error('synthetic-failure-after-only-origin-created');
  };
  assert.equal((await performSwitch(switchOptions)).status, `${switchPrefix}_SWITCH_ROLLED_BACK_IN_MAINTENANCE`);
  assert.equal(selection, spec); assert.ok(hostRunning && switchMaintenance); assert.ok((await driver.inspect()).identityValid);
  console.log('CLAWBOT_THREE_SERVICE_OK:partial-target-creation-rollback-without-volume-loss');
  assert.equal((await performSwitch(switchOptions)).status, `${switchPrefix}_SWITCH_ROLLED_BACK_IN_MAINTENANCE`);
  assert.equal(selection, spec); assert.ok(hostRunning && switchMaintenance); assert.ok((await driver.inspect()).identityValid);
  assert.equal((await performSwitch(switchOptions)).status, `${switchPrefix}_SELECTED_IN_MAINTENANCE`);
  assert.equal(selection, nextSpec); assert.ok(hostRunning && switchMaintenance);
  assert.ok(Object.values((await nextDriver.inspect()).running).every(running => !running));
  assert.equal(await stateHash(project), initialHash); assert.equal(await stateHash(nextSpec.volumePrefix), targetHash);
  console.log(updateMode ? 'CLAWBOT_THREE_SERVICE_OK:release-update-new-images-and-source-switch-failure-rollback' : 'CLAWBOT_THREE_SERVICE_OK:generation-switch-and-failure-rollback-old-data-retained');
  if (updateMode) {
    await leaveMaintenance(nextDriver, { storageFault: false, remove: () => { switchMaintenance = false; } });
    assert.equal(await reconcileRuntime(nextDriver, {}, { storage: await nextDriver.storage() }), 'healthy');
    const resumed = await nextDriver.inspect(); assert.ok(resumed.identityValid && resumed.namespaceValid && resumed.healthy);
    await enterMaintenance(nextDriver, () => { switchMaintenance = true; });
    assert.ok(Object.values((await nextDriver.inspect()).running).every(r => !r));
    assert.equal(await stateHash(project), initialHash);
    console.log('CLAWBOT_THREE_SERVICE_OK:explicit-new-release-resume-and-maintenance-old-volumes-unchanged');
  }
  console.log('CLAWBOT_MANAGED_RUNTIME_REHEARSAL_OK');
} catch { console.error(`CLAWBOT_MANAGED_RUNTIME_REHEARSAL_FAILED:${stage}`); process.exitCode = 1; }
finally {
  // Remove only this nonce-labelled fixture. Keep user and production volumes.
  try {
    const ids = (await run(['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${project}`])).split('\n').filter(Boolean);
    for (const id of ids) await run(['rm', '-f', id]);
    if (spec) {
      const networkNames = await run(['network', 'ls', '--format', '{{.Name}}', '--filter', `label=com.docker.compose.project=${project}`]);
      if (networkNames === `${project}_default`) await run(['network', 'rm', networkNames]);
    }
    for (const name of created) {
      const v = JSON.parse(await run(['volume', 'inspect', name]))[0];
      if (v.Labels?.['clawbot.project'] === project) await run(['volume', 'rm', name]);
    }
    rmSync(folder, { recursive: true });
  } catch { console.error('CLAWBOT_REHEARSAL_CLEANUP_NEEDS_ATTENTION'); process.exitCode = 1; }
  unlock();
}
