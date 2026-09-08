import assert from 'node:assert/strict';
import { readFileSync, lstatSync, realpathSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { MIGRATION_ROLES } from '../../deploy/docker/migration-format.mjs';
import { decryptArchive } from './backup-crypto.mjs';
import { assertBackupBudget } from './backup-budget.mjs';

// Independent disaster-recovery intake: no source volume is needed or mounted.
// A retained candidate is deliberately labelled as recovery, never production.
export async function restoreNineBackup({ directory, keyPath, image, retain = false }) {
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const folder = lstatSync(directory);
  assert.ok(folder.isDirectory() && realpathSync(directory) === directory && folder.uid === process.getuid() && !(folder.mode & 0o077));
  const checkFile = (path, maxBytes) => {
    const stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid()
      && !(stat.mode & 0o077) && stat.size <= maxBytes);
  };
  const archive = join(directory, 'state.enc'), manifestPath = join(directory, 'manifest.json');
  checkFile(archive, 20 * 2 ** 30); checkFile(manifestPath, 65536); checkFile(keyPath, 32);
  const manifestBytes = readFileSync(manifestPath), manifest = JSON.parse(manifestBytes), key = readFileSync(keyPath);
  assert.equal(manifest.format, 'clawbot-nine-volume-aes256gcm-v1'); assert.equal(manifest.runtimeImage, image);
  assert.ok(manifest.project === 'clawbot-production' || /^clawbot-import-check-[a-f0-9]{12}$/.test(manifest.project));
  assert.deepEqual(manifest.volumes, MIGRATION_ROLES); assert.equal(key.length, 32);
  if (manifest.volumeGeneration !== undefined && manifest.volumeGeneration !== null) {
    assert.match(manifest.volumeGeneration, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  }
  const docker = '/Applications/Docker.app/Contents/Resources/bin/docker', exec = promisify(execFile);
  const run = async (args) => {
    try { return (await exec(docker, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim(); }
    catch { throw Error('CLAWBOT_RECOVERY_DOCKER_FAILED'); }
  };
  const metadata = JSON.parse(await run(['image', 'inspect', image]))[0];
  assert.equal(metadata.Id, image); assert.equal(metadata.Architecture, 'arm64');
  // Authentication precedes creation of any destination. The archive carries
  // the authenticated full inventory/database audit generated while offline.
  await decryptArchive(archive, key, manifest);
  const disk = statfsSync(directory);
  assertBackupBudget({ existingBytes: 0, freeBytes: disk.bavail * disk.bsize,
    sourceBytes: manifest.audit?.bytes, entries: manifest.audit?.entries });
  const nonce = randomBytes(6).toString('hex'), project = `clawbot-recovery-${nonce}`, created = [];
  let verified = false;
  const helper = (writable) => ['run', '--rm', '-i', '--network', 'none', '--read-only', '--user', '0:0',
    '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', ...(writable ? ['--cap-add', 'CHOWN', '--cap-add', 'FOWNER'] : []),
    '--security-opt', 'no-new-privileges:true', ...MIGRATION_ROLES.flatMap((role) =>
      ['--mount', `type=volume,src=${project}_${role},dst=/state/${role}${writable ? '' : ',readonly'}`])];
  try {
    for (const role of MIGRATION_ROLES) {
      const name = `${project}_${role}`;
      assert.equal(await run(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${name}$`]), '');
      await run(['volume', 'create', '--label', `clawbot.recovery=${nonce}`, '--label', `clawbot.volume=${role}`,
        '--label', `clawbot.source-project=${manifest.project}`, name]); created.push(name);
    }
    const child = spawn(docker, [...helper(true), '--entrypoint', 'tar', image, '-x', '-p', '--ignore-zeros', '-f', '-', '-C', '/state'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), 300000); timer.unref();
    const done = new Promise((resolve, reject) => {
      child.on('error', () => { clearTimeout(timer); reject(Error('CLAWBOT_RECOVERY_EXTRACT_FAILED')); });
      child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('CLAWBOT_RECOVERY_EXTRACT_FAILED')); });
    }); done.catch(() => {});
    try { await decryptArchive(archive, key, manifest, child.stdin); await done; }
    catch (error) { child.kill('SIGTERM'); await done.catch(() => {}); throw error; }
    const audit = JSON.parse(await run([...helper(false), '--entrypoint', 'node', image, '/opt/clawbot/docker/nine-volume-audit.mjs']));
    assert.deepEqual(audit, manifest.audit, 'Recovered state does not match authenticated backup');
    verified = true;
    return { status: 'CLAWBOT_HISTORICAL_BACKUP_RECOVERY_VERIFIED', project, volumes: 9, retained: retain,
      sourceProject: manifest.project, sourceVolumeGeneration: manifest.volumeGeneration ?? null,
      sourceManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), audit,
      runtimeImage: image, tables: Object.fromEntries(Object.entries(audit.databases)
        .map(([name, db]) => [name, db.tableCount])), productionActivated: false };
  } finally {
    if (!verified || !retain) for (const name of created) {
      const volume = JSON.parse(await run(['volume', 'inspect', name]))[0];
      assert.equal(volume.Labels?.['clawbot.recovery'], nonce); await run(['volume', 'rm', name]);
    }
  }
}
