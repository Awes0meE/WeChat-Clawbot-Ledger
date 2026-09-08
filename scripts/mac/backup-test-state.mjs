import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, lstatSync, realpathSync, readFileSync, writeFileSync, existsSync, statfsSync, fsyncSync, openSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { encryptArchive, decryptArchive } from './backup-crypto.mjs';
import { acquireOperationLock } from './operation-lock.mjs';
import { assertBackupBudget } from './backup-budget.mjs';

// Offline consistent snapshot, then restore ONLY into fresh offline check
// volumes. This script cannot select or overwrite production destinations.
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const env = { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}` };
const compose = ['compose', '-f', 'deploy/docker/compose.test.yml'];
const names = { config: 'ledger-config', ledger: 'ledger-data', bootstrap: 'bootstrap', secrets: 'secrets',
  receipts: 'receipts', openclaw: 'openclaw-state', codex: 'codex-state' };
const backupRoot = join(homedir(), 'Library', 'Application Support', 'Clawbot', 'backups');
const keyRoot = join(homedir(), 'Library', 'Application Support', 'Clawbot', 'backup-keys');
let image, stopped = false, stage = 'preflight';
const createdVolumes = [];
const operation = `${Date.now()}-${randomBytes(5).toString('hex')}`;
const releaseLock = acquireOperationLock('backup');
async function run(args, timeout = 60_000) {
  try { return (await exec(docker, args, { cwd: root, env, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 })).stdout; }
  catch { throw new Error('Docker backup operation failed'); }
}
async function checkHost() {
  try { await exec(process.execPath, ['scripts/mac/verify-test-host.mjs'], { cwd: root, env, timeout: 60_000 }); }
  catch { throw new Error('Test host boundary check failed'); }
}
function privateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077));
  assert.equal(realpathSync(path), path, 'Refusing symlink backup location');
}
function mounts(prefix, readOnly) {
  return Object.entries(names).flatMap(([directory, name]) => ['--mount',
    `type=volume,src=${prefix}_${name},dst=/var/lib/clawbot-test/${directory}${readOnly ? ',readonly' : ''}`]);
}
function helper(prefix, entrypoint, args, readOnly = true) {
  return ['run', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--user', '0:0', '--cap-add', 'DAC_OVERRIDE',
    ...(!readOnly ? ['--cap-add', 'CHOWN', '--cap-add', 'FOWNER'] : []),
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', ...mounts(prefix, readOnly), '--entrypoint', entrypoint, image, ...args];
}
function streaming(args) {
  const child = spawn(docker, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'ignore'] });
  const done = new Promise((resolve, reject) => {
    child.on('error', () => reject(new Error('Archive helper failed')));
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('Archive helper failed')));
  });
  // Register rejection immediately, including when pipeline fails first.
  done.catch(() => {});
  return { child, done };
}
async function up() { await run([...compose, 'up', '-d', '--wait', '--wait-timeout', '120', 'origin', 'openclaw'], 150_000); }
try {
  await checkHost();
  const running = JSON.parse(await run(['inspect', ...(await run(['ps', '-q'])).trim().split('\n').filter(Boolean)]));
  assert.ok(running.every((c) => c.Config.Labels?.['com.docker.compose.project'] !== 'clawbot-test'
    || ['origin', 'openclaw'].includes(c.Config.Labels?.['com.docker.compose.service'])), 'Another test operation is running');
  for (const name of Object.values(names)) {
    const v = JSON.parse(await run(['volume', 'inspect', `clawbot-test_${name}`]))[0];
    assert.equal(v.Labels?.['com.docker.compose.project'], 'clawbot-test');
    assert.equal(v.Labels?.['com.docker.compose.volume'], name);
  }
  image = JSON.parse(await run(['image', 'inspect', 'clawbot-openclaw-test:p1']))[0].Id;
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  privateDirectory(backupRoot); privateDirectory(keyRoot);
  function usedBytes(path) {
    const stat = lstatSync(path);
    assert.ok(!stat.isSymbolicLink(), 'Unexpected backup symlink');
    if (stat.isDirectory()) return readdirSync(path).reduce((sum, name) => sum + usedBytes(join(path, name)), 0);
    assert.ok(stat.isFile()); return stat.size;
  }
  const existingBytes = usedBytes(backupRoot);
  const free = statfsSync(backupRoot);
  assertBackupBudget({ freeBytes: free.bavail * free.bsize, existingBytes, sourceBytes: 0, entries: 0 });
  const keyFile = join(keyRoot, 'clawbot-test-aes256.key');
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
  const keyStat = lstatSync(keyFile);
  assert.ok(keyStat.isFile() && !keyStat.isSymbolicLink() && keyStat.uid === process.getuid() && !(keyStat.mode & 0o077));
  const key = readFileSync(keyFile); assert.equal(key.length, 32);
  const directory = join(backupRoot, `clawbot-test-${operation}`); mkdirSync(directory, { mode: 0o700 });
  const archive = join(directory, 'state.enc');
  const manifest = { format: 'clawbot-offline-aes256gcm-v1', project: 'clawbot-test', runtimeImage: image,
    originImage: 'mayswind/ezbookkeeping@sha256:1043c95201f0432cd30328f6feb9a5b57359449400ea54fdf9a0c6138ab4c227',
    createdAt: new Date().toISOString(), volumes: Object.values(names) };
  stage = 'quiesce';
  // Set the flag before stop: a partial stop still needs the controlled recovery.
  stopped = true; await run([...compose, 'stop', 'openclaw', 'origin']);
  stage = 'snapshot';
  await run([...compose, 'run', '--rm', '-T', '--no-deps', '--entrypoint', 'node', 'init', '/opt/clawbot/docker/verify-state.mjs', 'save']);
  const inventoryArgs = helper('clawbot-test', 'node', ['/opt/clawbot/docker/backup-inventory.mjs', 'save'], false);
  const inventory = JSON.parse(await run(inventoryArgs));
  const currentFree = statfsSync(backupRoot);
  assertBackupBudget({ freeBytes: currentFree.bavail * currentFree.bsize, existingBytes,
    sourceBytes: inventory.bytes, entries: inventory.entries });
  const packing = streaming(helper('clawbot-test', 'tar', ['-c', '-f', '-', '-C', '/var/lib/clawbot-test', ...Object.keys(names)]));
  packing.child.stdin.end();
  try { await encryptArchive(packing.child.stdout, archive, key, manifest); await packing.done; }
  catch (error) { packing.child.kill('SIGTERM'); throw error; }
  const fd = openSync(archive, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
  stage = 'authenticate';
  await decryptArchive(archive, key, manifest); // Authenticate BEFORE any extraction.
  stage = 'restore-check';
  const restorePrefix = `clawbot-check-${operation}`;
  for (const name of Object.values(names)) {
    const volume = `${restorePrefix}_${name}`;
    const existing = (await run(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${volume}$`])).trim();
    assert.equal(existing, '');
    await run(['volume', 'create', '--label', `clawbot.backup-check=${operation}`, volume]);
    createdVolumes.push(volume);
  }
  const unpacking = streaming(helper(restorePrefix, 'tar', ['-x', '-p', '--ignore-zeros', '-f', '-', '-C', '/var/lib/clawbot-test'], false));
  unpacking.child.stdout.resume();
  try { await decryptArchive(archive, key, manifest, unpacking.child.stdin); await unpacking.done; }
  catch (error) { unpacking.child.kill('SIGTERM'); throw error; }
  await run(helper(restorePrefix, 'node', ['/opt/clawbot/docker/backup-inventory.mjs', 'check']));
  await run(helper(restorePrefix, 'node', ['/opt/clawbot/docker/verify-state.mjs', 'check'], false));
  writeFileSync(join(directory, 'verified.json'), JSON.stringify({ status: 'restored-and-verified', checkedAt: new Date().toISOString(),
    fileInventory: true, ledgerAndReceiptIntegrity: true, restoreNetwork: 'none' }), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: 'CLAWBOT_ENCRYPTED_BACKUP_AND_OFFLINE_RESTORE_OK', directory, volumes: 7 }));
} catch { console.error(`CLAWBOT_BACKUP_FAILED:${stage}`); process.exitCode = 1; }
finally {
  for (const volume of createdVolumes) {
    try {
      const v = JSON.parse(await run(['volume', 'inspect', volume]))[0];
      if (v.Labels?.['clawbot.backup-check'] === operation) await run(['volume', 'rm', volume]);
    } catch { console.error('CLAWBOT_BACKUP_CHECK_VOLUME_RETAINED'); process.exitCode = 1; }
  }
  if (stopped) {
    try { await up(); await checkHost(); console.log('CLAWBOT_TEST_SERVICES_RESUMED'); }
    catch { console.error('CLAWBOT_TEST_RESUME_FAILED'); process.exitCode = 1; }
  }
  releaseLock();
}
