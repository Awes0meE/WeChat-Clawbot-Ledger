import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync, realpathSync, readdirSync, mkdirSync,
  openSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readManagedHostRelease, activationMatches } from './managed-host-release.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { managedHostJob } from './managed-host-job.mjs';
import { auditManagedState } from './managed-state-audit.mjs';
import { decryptArchive } from './backup-crypto.mjs';
import { operationsRoot, waitForOperationLock } from './operation-lock.mjs';
import { managedVolumeName } from './managed-runtime-spec.mjs';
import { MIGRATION_ROLES } from '../../deploy/docker/migration-format.mjs';
import { applyLedgerTokenUpdate } from './ledger-token-operation.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function privateBytes(path, max = 65536) {
  const s = lstatSync(path);
  assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === process.getuid()
    && !(s.mode & 0o077) && s.size <= max && realpathSync(path) === path);
  return readFileSync(path);
}
function privateDirectory(path) {
  const s = lstatSync(path);
  assert.ok(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid()
    && !(s.mode & 0o077) && realpathSync(path) === path);
}
function absent(path) {
  try { lstatSync(path); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
}
function durableRecord(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(resolve(path, '..'), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
}
let unlock;
try {
  const [action, hostArg, inputArg, identityArg, backupArg, reviewArg] = process.argv.slice(2);
  assert.ok(['prepare', 'apply', 'resume'].includes(action) && hostArg && inputArg && identityArg && backupArg
    && process.argv.length === (action === 'prepare' ? 7 : 8));
  const base = join(homedir(), 'Library/Application Support/Clawbot');
  const host = resolve(hostArg), input = resolve(inputArg), identity = resolve(identityArg), backup = resolve(backupArg);
  assert.ok(host.startsWith(join(base, 'production-host-releases') + '/') && realpathSync(host) === host);
  assert.ok(backup.startsWith(join(base, 'production-backups') + '/') && realpathSync(backup) === backup);
  for (const path of [input, identity]) assert.ok(path.startsWith(operationsRoot + '/'));
  privateDirectory(input); assert.deepEqual(readdirSync(input).sort(), ['http-token', 'mcp-token']);
  const identityBytes = privateBytes(identity, 4096), owner = JSON.parse(identityBytes);
  assert.deepEqual(Object.keys(owner).sort(), ['expectedUsername', 'reviewed', 'version']);
  assert.ok(owner.version === 1 && owner.reviewed === true && typeof owner.expectedUsername === 'string'
    && owner.expectedUsername.length > 0 && owner.expectedUsername.length <= 256);
  const tokens = Object.fromEntries(['http', 'mcp'].map(role => [role, privateBytes(join(input, `${role}-token`), 16384)]));
  const { spec } = readManagedHostRelease(host), driver = managedDockerDriver(spec, join(host, 'compose.json'));
  unlock = await waitForOperationLock('ledger-token-rotation');
  const maintenancePath = join(operationsRoot, 'production-maintenance'), gatePath = join(operationsRoot, 'production-enabled.json');
  const maintenanceBytes = privateBytes(maintenancePath), marker = JSON.parse(maintenanceBytes);
  for (const key of ['project', 'sourceCommit', 'cutoverId', 'importManifestSha256']) assert.equal(marker[key], spec[key]);
  assert.equal(marker.volumeGeneration ?? null, spec.volumeGeneration ?? null);
  const job = managedHostJob(host); job.installed(); job.loaded();
  const manifestBytes = privateBytes(join(backup, 'manifest.json')), manifest = JSON.parse(manifestBytes);
  const verifiedBytes = privateBytes(join(backup, 'verified.json')), verified = JSON.parse(verifiedBytes);
  assert.equal(manifest.format, 'clawbot-nine-volume-aes256gcm-v1'); assert.equal(manifest.project, spec.project);
  assert.equal(manifest.runtimeImage, spec.services.openclaw.image); assert.deepEqual(manifest.volumes, MIGRATION_ROLES);
  assert.equal(manifest.volumeGeneration ?? null, spec.volumeGeneration ?? null);
  assert.ok(verified.status === 'restored-and-verified' && verified.volumes === 9 && verified.fileInventory === true
    && verified.ledgerAndReceiptIntegrity === true && verified.restoreNetwork === 'none');
  const archive = join(backup, 'state.enc'), archiveStat = lstatSync(archive);
  assert.ok(archiveStat.isFile() && !archiveStat.isSymbolicLink() && archiveStat.nlink === 1 && archiveStat.uid === process.getuid()
    && !(archiveStat.mode & 0o077) && archiveStat.size <= 20 * 2 ** 30 && realpathSync(archive) === archive);
  const key = privateBytes(join(base, 'production-backup-keys/clawbot-production.key'), 32); assert.equal(key.length, 32);
  await decryptArchive(archive, key, manifest);

  async function quiescent() {
    assert.ok(privateBytes(maintenancePath).equals(maintenanceBytes));
    assert.ok(activationMatches(JSON.parse(privateBytes(gatePath)), spec));
    assert.ok(absent(join(operationsRoot, 'production-storage-fault.json')));
    assert.ok(privateBytes(identity).equals(identityBytes));
    privateDirectory(input); assert.deepEqual(readdirSync(input).sort(), ['http-token', 'mcp-token']);
    for (const role of ['http', 'mcp']) assert.ok(privateBytes(join(input, `${role}-token`)).equals(tokens[role]));
    assert.ok(privateBytes(join(backup, 'manifest.json')).equals(manifestBytes)
      && privateBytes(join(backup, 'verified.json')).equals(verifiedBytes));
    job.installed(); job.loaded();
    const view = await driver.inspect(); assert.ok(view.identityValid && !Object.values(view.running).some(Boolean));
    // auditManagedState also checks every running container for consumers of
    // all nine volumes, including containers outside this Compose project.
    return await auditManagedState(spec, driver, { ledgerRotation: true });
  }
  async function helper(mode, binding = null) {
    const id = randomUUID(), name = `clawbot-ledger-token-update-${id}`;
    const args = ['run', '--rm', '-i', '--name', name, '--label', `clawbot.ledger-token-update=${id}`,
      '--log-driver', 'none', '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,nosuid,nodev,size=640m,mode=1777',
      '--mount', `type=volume,src=${managedVolumeName(spec, 'ledger-data')},dst=/rotation/ledger,readonly`,
      '--mount', `type=volume,src=${managedVolumeName(spec, 'secrets')},dst=/rotation/secrets${mode === 'inspect' ? ',readonly' : ''}`,
      '--entrypoint', 'node', spec.services.openclaw.image, '/opt/clawbot/docker/import-ledger-tokens.mjs'];
    try {
      const output = await new Promise((resolveOutput, reject) => {
        const child = spawn('/Applications/Docker.app/Contents/Resources/bin/docker', args, { stdio: ['pipe', 'pipe', 'ignore'] });
        let output = '', failed = false;
        const timer = setTimeout(() => { failed = true; child.kill(); }, 120000);
        child.stdout.on('data', chunk => { output += chunk; if (output.length > 8192) { failed = true; child.kill(); } });
        child.stdin.on('error', () => { failed = true; });
        child.on('error', () => { clearTimeout(timer); reject(Error('helper unavailable')); });
        child.on('close', code => { clearTimeout(timer); code === 0 && !failed ? resolveOutput(output) : reject(Error('helper failed')); });
        child.stdin.end(JSON.stringify({ action: mode, expectedBinding: binding, expectedUsername: owner.expectedUsername,
          http: tokens.http.toString('utf8'), mcp: tokens.mcp.toString('utf8') }));
      });
      return JSON.parse(output);
    } finally {
      // A timed-out Docker client may leave its container running. Stop only
      // this operation's exact labelled helper; never release into a live writer.
      const ids = (await driver.run(['ps', '-a', '-q', '--no-trunc', '--filter', `name=^${name}$`])).split('\n').filter(Boolean);
      if (ids.length) {
        assert.equal(ids.length, 1);
        const container = JSON.parse(await driver.run(['inspect', ids[0]]))[0];
        assert.equal(container.Config.Labels?.['clawbot.ledger-token-update'], id);
        assert.equal(container.Image, spec.services.openclaw.image);
        if (container.State.Running) await driver.run(['stop', '--time', '1', ids[0]]);
        assert.equal(await driver.run(['ps', '-q', '--filter', `name=^${name}$`]), '');
      }
    }
  }
  const unrelatedAudit = await quiescent();
  const evidence = { version: 1, sourceCommit: spec.sourceCommit, runtimeImage: spec.services.openclaw.image,
    cutoverId: spec.cutoverId, volumeGeneration: spec.volumeGeneration ?? null, backupManifestSha256: hash(manifestBytes),
    identitySha256: hash(identityBytes), inputSha256: hash(Buffer.concat([tokens.http, Buffer.from([0]), tokens.mcp])),
    maintenanceSha256: hash(maintenanceBytes), unrelatedAudit };
  const records = join(operationsRoot, 'ledger-token-updates'); mkdirSync(records, { recursive: true, mode: 0o700 }); privateDirectory(records);
  if (action === 'prepare') {
    assert.deepEqual(await auditManagedState(spec, driver), manifest.audit);
    const inspection = await helper('inspect'); assert.equal(inspection.status, 'CLAWBOT_LEDGER_ROTATION_READY_FOR_REVIEW');
    assert.match(inspection.binding, /^[a-f0-9]{64}$/);
    assert.deepEqual(await quiescent(), unrelatedAudit); assert.deepEqual(await auditManagedState(spec, driver), manifest.audit);
    const file = join(records, `review-${randomUUID()}.json`);
    durableRecord(file, { ...evidence, binding: inspection.binding, approved: false, reviewedAt: null });
    console.log(JSON.stringify({ status: 'CLAWBOT_LEDGER_ROTATION_REVIEW_UNCONFIRMED', file }));
  } else {
    const reviewPath = resolve(reviewArg); assert.ok(reviewPath.startsWith(records + '/'));
    const result = await applyLedgerTokenUpdate({ action, evidence, manifest, reviewBytes: privateBytes(reviewPath),
      loadReview: () => privateBytes(reviewPath),
      loadStarted: binding => JSON.parse(privateBytes(join(records, `started-${binding}.json`))),
      saveStarted: operation => durableRecord(join(records, `started-${operation.binding}.json`), operation),
      quiescent, fullAudit: () => auditManagedState(spec, driver), helper,
      saveReceipt: record => {
        const receipt = join(records, `saved-${record.binding}.json`); durableRecord(receipt, record); return receipt;
      } });
    console.log(JSON.stringify(result));
  }
} catch { console.error('CLAWBOT_LEDGER_ROTATION_STOPPED_MAINTENANCE_REMAINS'); process.exitCode = 1; }
finally { unlock?.(); }
