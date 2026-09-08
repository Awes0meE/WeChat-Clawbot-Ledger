import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync, readdirSync, statfsSync, existsSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MIGRATION_ROLES } from '../../deploy/docker/migration-format.mjs';
import { encryptArchive, decryptArchive } from './backup-crypto.mjs';
import { assertBackupBudget } from './backup-budget.mjs';

// Caller owns the operation lock and maintenance state. The function verifies
// source volumes are unused before and after capture, never stops consumers,
// and restores only into this call's random, empty, offline check volumes.
export async function backupNineVolumes({ project, image, backupRoot, keyRoot, assertQuiescent, volumeGeneration = null }) {
  assert.ok(project === 'clawbot-production' || /^clawbot-import-check-[a-f0-9]{12}$/.test(project));
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  if (volumeGeneration !== null) {
    assert.match(volumeGeneration, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  }
  const sourcePrefix = volumeGeneration ? `${project}-recovery-${volumeGeneration}` : project;
  const docker = '/Applications/Docker.app/Contents/Resources/bin/docker', exec = promisify(execFile);
  const run = async (args) => {
    try { return (await exec(docker, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim(); }
    catch { throw new Error('CLAWBOT_NINE_BACKUP_DOCKER_FAILED'); }
  };
  function privateDirectory(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 }); const stat = lstatSync(path);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077));
    assert.equal(realpathSync(path), path);
  }
  privateDirectory(backupRoot); privateDirectory(keyRoot);
  function used(path) {
    const stat = lstatSync(path); assert.ok(!stat.isSymbolicLink());
    if (stat.isDirectory()) return readdirSync(path).reduce((sum, name) => sum + used(join(path, name)), 0);
    assert.ok(stat.isFile()); return stat.size;
  }
  const existingBytes = used(backupRoot), nonce = randomBytes(6).toString('hex'), checkProject = `clawbot-backup-check-${nonce}`;
  const directory = join(backupRoot, `${project}-${Date.now()}-${nonce}`), created = [];
  const sourceNames = MIGRATION_ROLES.map((role) => `${sourcePrefix}_${role}`);
  async function unusedSource() {
    await assertQuiescent();
    for (const role of MIGRATION_ROLES) {
      const v = JSON.parse(await run(['volume', 'inspect', `${sourcePrefix}_${role}`]))[0];
      assert.equal(v.Driver, 'local'); assert.ok(!Object.keys(v.Options ?? {}).length);
      assert.equal(v.Labels?.['clawbot.project'], project); assert.equal(v.Labels?.['clawbot.volume'], role);
      assert.equal(v.Labels?.['clawbot.generation'] ?? null, volumeGeneration);
    }
    const ids = (await run(['ps', '-q'])).split('\n').filter(Boolean);
    if (ids.length) {
      const containers = JSON.parse(await run(['inspect', ...ids]));
      assert.ok(containers.every((c) => !c.Mounts.some((m) => sourceNames.includes(m.Name))), 'Source volumes have a live consumer');
    }
  }
  const helper = (prefix, entrypoint, args, writable = false) => ['run', '--rm', '-i', '--network', 'none', '--read-only',
    '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE',
    ...(writable ? ['--cap-add', 'CHOWN', '--cap-add', 'FOWNER'] : []), '--security-opt', 'no-new-privileges:true',
    ...MIGRATION_ROLES.flatMap((role) => ['--mount', `type=volume,src=${prefix}_${role},dst=/state/${role}${writable ? '' : ',readonly'}`]),
    '--entrypoint', entrypoint, image, ...args];
  function stream(args) {
    const child = spawn(docker, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), 300000); timer.unref();
    const done = new Promise((resolve, reject) => {
      child.on('error', () => { clearTimeout(timer); reject(Error('CLAWBOT_NINE_BACKUP_STREAM_FAILED')); });
      child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('CLAWBOT_NINE_BACKUP_STREAM_FAILED')); });
    }); done.catch(() => {}); return { child, done };
  }
  const audit = async (prefix) => JSON.parse(await run(helper(prefix, 'node', ['/opt/clawbot/docker/nine-volume-audit.mjs'])));
  try {
    await unusedSource();
    const before = await audit(sourcePrefix), disk = statfsSync(backupRoot);
    assertBackupBudget({ existingBytes, freeBytes: disk.bavail * disk.bsize, sourceBytes: before.bytes, entries: before.entries });
    const keyPath = join(keyRoot, `${project}.key`);
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
    const keyStat = lstatSync(keyPath); assert.ok(keyStat.isFile() && !keyStat.isSymbolicLink() && keyStat.uid === process.getuid() && !(keyStat.mode & 0o077));
    const key = readFileSync(keyPath); assert.equal(key.length, 32);
    mkdirSync(directory, { mode: 0o700 });
    const manifest = { format: 'clawbot-nine-volume-aes256gcm-v1', project, runtimeImage: image,
      createdAt: new Date().toISOString(), volumes: MIGRATION_ROLES, audit: before, volumeGeneration };
    const archive = join(directory, 'state.enc'), packing = stream(helper(sourcePrefix, 'tar', ['-c', '-f', '-', '-C', '/state', ...MIGRATION_ROLES]));
    packing.child.stdin.end();
    try { await encryptArchive(packing.child.stdout, archive, key, manifest); await packing.done; }
    catch (error) { packing.child.kill('SIGTERM'); await packing.done.catch(() => {}); throw error; }
    await unusedSource(); assert.deepEqual(await audit(sourcePrefix), before, 'Source changed while packing');
    const fd = openSync(archive, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    await decryptArchive(archive, key, manifest); // Authenticate fully before extraction.
    for (const role of MIGRATION_ROLES) {
      const name = `${checkProject}_${role}`;
      assert.equal(await run(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${name}$`]), '');
      await run(['volume', 'create', '--label', `clawbot.backup-check=${nonce}`, name]); created.push(name);
    }
    const unpacking = stream(helper(checkProject, 'tar', ['-x', '-p', '--ignore-zeros', '-f', '-', '-C', '/state'], true)); unpacking.child.stdout.resume();
    try { await decryptArchive(archive, key, manifest, unpacking.child.stdin); await unpacking.done; }
    catch (error) { unpacking.child.kill('SIGTERM'); await unpacking.done.catch(() => {}); throw error; }
    assert.deepEqual(await audit(checkProject), before, 'Restored state differs from offline source');
    await unusedSource();
    writeFileSync(join(directory, 'verified.json'), JSON.stringify({ status: 'restored-and-verified', checkedAt: new Date().toISOString(),
      fileInventory: true, ledgerAndReceiptIntegrity: true, restoreNetwork: 'none', volumes: 9 }), { flag: 'wx', mode: 0o600 });
    return { status: 'CLAWBOT_NINE_VOLUME_BACKUP_RESTORE_VERIFIED', directory, volumes: 9, entries: before.entries,
      tables: Object.fromEntries(Object.entries(before.databases).map(([name, db]) => [name, db.tableCount])) };
  } finally {
    for (const name of created) {
      const volume = JSON.parse(await run(['volume', 'inspect', name]))[0];
      assert.equal(volume.Labels?.['clawbot.backup-check'], nonce); await run(['volume', 'rm', name]);
    }
  }
}
