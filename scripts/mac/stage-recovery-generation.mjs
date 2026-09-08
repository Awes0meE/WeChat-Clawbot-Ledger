import assert from 'node:assert/strict';
import { statfsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { MIGRATION_ROLES } from '../../deploy/docker/migration-format.mjs';
import { generationReceipt } from '../../deploy/docker/generation-receipts.mjs';
import { validateGenerationStageReview } from './generation-stage-review.mjs';
import { validateReleaseUpdateStage } from './release-update-review.mjs';
import { assertBackupBudget } from './backup-budget.mjs';

// Caller holds the operation lock. Only new generation volumes are writable;
// the original production volumes and retained recovery candidate stay intact.
export async function stageRecoveryGeneration({ spec, candidate, review, image, reservePath, releaseUpdateFrom = null }) {
  const receipt = generationReceipt(spec);
  const validateReview = () => releaseUpdateFrom
    ? validateReleaseUpdateStage(review, releaseUpdateFrom, spec, candidate) : validateGenerationStageReview(review, spec, candidate);
  validateReview();
  assert.equal(candidate.status, 'CLAWBOT_HISTORICAL_BACKUP_RECOVERY_VERIFIED');
  assert.equal(candidate.retained, true); assert.equal(candidate.productionActivated, false);
  assert.match(candidate.project, /^clawbot-recovery-[a-f0-9]{12}$/);
  assert.equal(candidate.sourceProject, spec.project); assert.equal(candidate.runtimeImage, releaseUpdateFrom ? releaseUpdateFrom.services.openclaw.image : image);
  assert.equal(candidate.sourceManifestSha256, spec.recoverySourceManifestSha256);
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const prefix = `${spec.project}-recovery-${spec.volumeGeneration}`, nonce = candidate.project.slice('clawbot-recovery-'.length);
  const docker = '/Applications/Docker.app/Contents/Resources/bin/docker', exec = promisify(execFile);
  const run = async args => {
    try { return (await exec(docker, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim(); }
    catch { throw Error('CLAWBOT_GENERATION_DOCKER_FAILED'); }
  };
  const metadata = JSON.parse(await run(['image', 'inspect', image]))[0];
  assert.equal(metadata.Id, image); assert.equal(metadata.Architecture, 'arm64');
  if (spec.project === 'clawbot-production') assert.equal(metadata.Config.Labels?.['org.opencontainers.image.revision'], spec.sourceCommit);
  if (releaseUpdateFrom) {
    assert.equal(image, spec.services.openclaw.image);
    for (const [reference, source] of [[candidate.runtimeImage, releaseUpdateFrom.sourceCommit], [spec.services.guard.image, spec.sourceCommit]]) {
      const m = JSON.parse(await run(['image', 'inspect', reference]))[0];
      assert.equal(m.Id, reference); assert.equal(m.Architecture, 'arm64');
      if (spec.project === 'clawbot-production') assert.equal(m.Config.Labels?.['org.opencontainers.image.revision'], source);
    }
  }
  const helper = (target, writable = false, mountRoot = '/state') => ['run', '--rm', '-i', '--network', 'none', '--read-only', '--user', '0:0',
    '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', ...(writable ? ['--cap-add', 'CHOWN', '--cap-add', 'FOWNER'] : []),
    '--security-opt', 'no-new-privileges:true', ...MIGRATION_ROLES.flatMap(role =>
      ['--mount', `type=volume,src=${target}_${role},dst=${mountRoot}/${role}${writable ? '' : ',readonly'}`])];
  async function unused() {
    const ids = (await run(['ps', '-q'])).split('\n').filter(Boolean);
    if (ids.length) {
      const names = [candidate.project, prefix].flatMap(p => MIGRATION_ROLES.map(role => `${p}_${role}`));
      const live = JSON.parse(await run(['inspect', ...ids]));
      assert.ok(live.every(c => !c.Mounts.some(m => names.includes(m.Name))), 'Recovery data has a live consumer');
    }
  }
  const audit = async target => JSON.parse(await run([...helper(target), '--entrypoint', 'node', image, '/opt/clawbot/docker/nine-volume-audit.mjs']));
  for (const role of MIGRATION_ROLES) {
    const v = JSON.parse(await run(['volume', 'inspect', `${candidate.project}_${role}`]))[0];
    assert.equal(v.Driver, 'local'); assert.ok(!Object.keys(v.Options ?? {}).length);
    assert.equal(v.Labels?.['clawbot.recovery'], nonce); assert.equal(v.Labels?.['clawbot.volume'], role);
    assert.equal(v.Labels?.['clawbot.source-project'], spec.project); assert.equal(v.Labels?.['clawbot.project'], undefined);
    assert.equal(await run(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${prefix}_${role}$`]), '');
  }
  await unused(); assert.deepEqual(await audit(candidate.project), candidate.audit);
  const disk = statfsSync(reservePath);
  assertBackupBudget({ existingBytes: 0, freeBytes: disk.bavail * disk.bsize, sourceBytes: candidate.audit.bytes, entries: candidate.audit.entries });
  validateReview();
  for (const role of MIGRATION_ROLES) await run(['volume', 'create', '--label', `clawbot.project=${spec.project}`,
    '--label', `clawbot.volume=${role}`, '--label', `clawbot.cutover=${spec.cutoverId}`, '--label', `clawbot.generation=${spec.volumeGeneration}`,
    '--label', `clawbot.recovery-source=${candidate.project}`, `${prefix}_${role}`]);
  for (const role of MIGRATION_ROLES) {
    const volume = JSON.parse(await run(['volume', 'inspect', `${prefix}_${role}`]))[0];
    assert.equal(volume.Driver, 'local'); assert.ok(!Object.keys(volume.Options ?? {}).length);
    for (const [key, value] of Object.entries({ project: spec.project, volume: role, cutover: spec.cutoverId,
      generation: spec.volumeGeneration, 'recovery-source': candidate.project })) assert.equal(volume.Labels?.[`clawbot.${key}`], value);
  }
  await run([...helper(prefix), '--entrypoint', 'node', image, '-e',
    'const f=require("node:fs");for(const role of JSON.parse(process.argv[1]))if(f.readdirSync("/state/"+role).length)throw Error("Destination is not empty");', JSON.stringify(MIGRATION_ROLES)]);
  function stream(args) {
    const child = spawn(docker, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), 300000); timer.unref();
    const done = new Promise((resolve, reject) => {
      child.on('error', () => { clearTimeout(timer); reject(Error('CLAWBOT_GENERATION_COPY_FAILED')); });
      child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('CLAWBOT_GENERATION_COPY_FAILED')); });
    }); done.catch(() => {}); return { child, done };
  }
  const source = stream([...helper(candidate.project), '--entrypoint', 'tar', image, '-c', '-f', '-', '-C', '/state', ...MIGRATION_ROLES]);
  source.child.stdin.end();
  const target = stream([...helper(prefix, true), '--entrypoint', 'tar', image, '-x', '-p', '--ignore-zeros', '-f', '-', '-C', '/state']); target.child.stdout.resume();
  try { await Promise.all([pipeline(source.child.stdout, target.child.stdin), source.done, target.done]); }
  catch (error) { source.child.kill('SIGTERM'); target.child.kill('SIGTERM'); await Promise.allSettled([source.done, target.done]); throw error; }
  await unused(); assert.deepEqual(await audit(prefix), candidate.audit); assert.deepEqual(await audit(candidate.project), candidate.audit);
  const updateHelper = action => [...helper(prefix, action === 'rebind', '/generation'),
    ...MIGRATION_ROLES.flatMap(role => ['--mount', `type=volume,src=${candidate.project}_${role},dst=/source/${role},readonly`]),
    '--entrypoint', 'node', image, '/opt/clawbot/docker/rebind-release-update.mjs', action, JSON.stringify(releaseUpdateFrom), JSON.stringify(spec)];
  if (releaseUpdateFrom) assert.equal(await run(updateHelper('rebind')), 'CLAWBOT_RELEASE_UPDATE_DATA_VERIFIED');
  assert.equal(await run([...helper(prefix, true, '/generation'), '--entrypoint', 'node', image,
    '/opt/clawbot/docker/install-generation-receipts.mjs', JSON.stringify(receipt), JSON.stringify(candidate.sourceVolumeGeneration ?? null),
    ...(releaseUpdateFrom ? [releaseUpdateFrom.sourceCommit] : [])]), 'CLAWBOT_GENERATION_RECEIPTS_INSTALLED');
  if (releaseUpdateFrom) assert.equal(await run(updateHelper('verify')), 'CLAWBOT_RELEASE_UPDATE_DATA_VERIFIED');
  assert.equal(await run([...helper(prefix, false, '/generation'), '--entrypoint', 'node', image,
    '/opt/clawbot/docker/verify-generation-receipts.mjs', JSON.stringify(receipt)]), 'CLAWBOT_RECOVERY_GENERATION_COMPLETE');
  await unused(); assert.deepEqual(await audit(candidate.project), candidate.audit);
  return { status: releaseUpdateFrom ? 'CLAWBOT_RELEASE_UPDATE_GENERATION_STAGED' : 'CLAWBOT_RECOVERY_GENERATION_STAGED', volumePrefix: prefix, ...receipt,
    ...(releaseUpdateFrom ? { previousSourceCommit: releaseUpdateFrom.sourceCommit, previousRuntimeImage: candidate.runtimeImage, runtimeImage: image, guardImage: spec.services.guard.image, filesPreservedExceptSourceBindings: true } : {}),
    sourceCandidate: candidate.project, sourceAudit: candidate.audit, stagedAudit: await audit(prefix), productionActivated: false };
  // Failure deliberately leaves only this new, unactivated generation for
  // inspection. No old volume is deleted and no completion is reported.
}
