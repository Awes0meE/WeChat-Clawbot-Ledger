import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync, realpathSync, statfsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { waitForOperationLock } from './operation-lock.mjs';
import { MIGRATION_ROLES, validateMigrationManifest } from '../../deploy/docker/migration-format.mjs';
import { verifyMigrationFiles } from '../../deploy/docker/migration-files.mjs';
import { verifyMigrationSemantics } from '../../deploy/docker/migration-semantics.mjs';
import { databaseAudit } from '../../deploy/docker/database-audit.mjs';
import { backupNineVolumes } from './backup-nine-volumes.mjs';
const exec = promisify(execFile), docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
// Production intake requires a previously reviewed source hash and destination
// image. No argument may select an existing volume as an overwrite target.
const [mode, directoryArg, image, expectedSourceSha256, expectedTargetCommit] = process.argv.slice(2);
if (!['rehearsal', 'production'].includes(mode) || !directoryArg || !/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new Error('Usage: import-migration.mjs <rehearsal|production> <private-package-directory> <image-digest> <source-snapshot-sha256> <target-commit>');
const directory = resolve(directoryArg), rehearsal = mode === 'rehearsal';
const verifyBackup = process.argv[7] === '--verify-backup';
if (process.argv[7] && (!verifyBackup || !rehearsal)) throw new Error('Backup rehearsal requires synthetic import mode');
assert.equal(realpathSync(directory), directory); const directoryStat = lstatSync(directory);
assert.ok(directoryStat.isDirectory() && directoryStat.uid === process.getuid() && !(directoryStat.mode & 0o077), 'Private package directory required');
if (!rehearsal) assert.ok(directory.startsWith(join(homedir(), 'Library', 'Application Support', 'Clawbot', 'imports') + '/'), 'Production imports must be staged outside Git');
const manifestPath = join(directory, 'manifest.json'), manifestStat = lstatSync(manifestPath);
assert.ok(manifestStat.isFile() && !manifestStat.isSymbolicLink() && manifestStat.size <= 16 * 1024 * 1024);
const manifest = JSON.parse(readFileSync(manifestPath));
const summary = validateMigrationManifest(manifest, { rehearsal, expectedSourceSha256, expectedTargetCommit });
await verifyMigrationFiles(join(directory, 'payload'), manifest);
verifyMigrationSemantics(join(directory, 'payload'), manifest);
for (const db of Object.values(manifest.databases)) assert.equal(databaseAudit(join(directory, 'payload', db.path)).auditSha256, db.auditSha256, 'Source database audit mismatch');
const free = statfsSync(directory);
assert.ok(free.bavail * free.bsize > summary.bytes * 2 + 10 * 2 ** 30, 'Insufficient import and recovery reserve');
const project = rehearsal ? `clawbot-import-check-${randomBytes(6).toString('hex')}` : 'clawbot-production';
const unlock = await waitForOperationLock('migration-import');
async function run(args, timeout = 30000) {
  try { return (await exec(docker, args, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 })).stdout.trim(); }
  catch { throw new Error('CLAWBOT_MIGRATION_DOCKER_STEP_FAILED'); }
}
const created = [];
try {
  const metadata = JSON.parse(await run(['image', 'inspect', image]))[0]; assert.equal(metadata.Architecture, 'arm64');
  if (!rehearsal) assert.equal(metadata.Config.Labels?.['org.opencontainers.image.revision'], expectedTargetCommit);
  assert.equal(await run(['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '', 'Destination containers exist');
  for (const role of MIGRATION_ROLES) assert.equal(await run(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${project}_${role}$`]), '', 'Refusing existing destination volume');
  for (const role of MIGRATION_ROLES) {
    const name = `${project}_${role}`;
    await run(['volume', 'create', '--label', `clawbot.project=${project}`, '--label', `clawbot.volume=${role}`,
      '--label', `clawbot.cutover=${manifest.target.cutoverId}`, name]); created.push(name);
  }
  const result = await run(['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL',
    '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--security-opt', 'no-new-privileges:true',
    '--mount', `type=bind,src=${directory},dst=/package,readonly`,
    ...MIGRATION_ROLES.flatMap((role) => ['--mount', `type=volume,src=${project}_${role},dst=/target/${role}`]),
    '--entrypoint', 'node', image, '/opt/clawbot/docker/import-migration.mjs', mode, project, expectedSourceSha256, expectedTargetCommit], 300000);
  const evidence = JSON.parse(result); assert.equal(evidence.status, 'CLAWBOT_MIGRATION_NEW_VOLUMES_VERIFIED');
  if (verifyBackup) {
    const backup = await backupNineVolumes({ project, image, backupRoot: join(directory, 'backup-rehearsal'),
      keyRoot: join(directory, 'backup-rehearsal-keys'), assertQuiescent: async () => {
        assert.equal(await run(['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '');
      } });
    evidence.backup = { status: backup.status, volumes: backup.volumes, tables: backup.tables };
  }
  console.log(JSON.stringify({ ...evidence, project }));
} finally {
  // Failed production imports are retained for inspection and never retried
  // over partial data. Only synthetic rehearsal destinations are disposable.
  if (rehearsal) for (const name of created) {
    const volume = JSON.parse(await run(['volume', 'inspect', name]))[0];
    if (volume.Labels?.['clawbot.project'] === project) await run(['volume', 'rm', name]);
  }
  unlock();
}
