import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { MIGRATION_ROLES } from '../../deploy/docker/migration-format.mjs';
import { databaseAudit } from '../../deploy/docker/database-audit.mjs';
import { canonicalTunnelConfig } from '../../deploy/guard/tunnel-policy.mjs';
import { waitForOperationLock } from './operation-lock.mjs';
import { backupNineVolumes } from './backup-nine-volumes.mjs';
import { restoreNineBackup } from './restore-nine-backup.mjs';
import { copyVerifiedBackup } from './copy-verified-backup.mjs';
import { stageRecoveryGeneration } from './stage-recovery-generation.mjs';
import { generationStageTemplate } from './generation-stage-review.mjs';
import { releaseUpdateStageTemplate } from './release-update-review.mjs';

async function verifyNonemptyDestination(directory, image, sourceSha, targetCommit) {
  const project = `clawbot-import-check-${randomBytes(6).toString('hex')}`, created = [], recoveryResources = [];
  const unlock = await waitForOperationLock('migration-overwrite-rehearsal');
  const docker = (args) => spawnSync('/Applications/Docker.app/Contents/Resources/bin/docker', args,
    { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
  const mounts = MIGRATION_ROLES.flatMap((role) => ['--mount', `type=volume,src=${project}_${role},dst=/target/${role}`]);
  const base = ['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL',
    '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--security-opt', 'no-new-privileges:true', ...mounts];
  try {
    for (const role of MIGRATION_ROLES) {
      const name = `${project}_${role}`;
      assert.equal(docker(['volume', 'create', '--label', `clawbot.project=${project}`, '--label', `clawbot.volume=${role}`, name]).status, 0); created.push(name);
    }
    assert.equal(docker([...base, '--entrypoint', 'node', image, '-e',
      'require("node:fs").writeFileSync("/target/receipts/sentinel", "retain-existing-data", {flag:"wx"})']).status, 0);
    const rejected = docker([...base, '--mount', `type=bind,src=${directory},dst=/package,readonly`, '--entrypoint', 'node', image,
      '/opt/clawbot/docker/import-migration.mjs', 'rehearsal', project, sourceSha, targetCommit]);
    assert.notEqual(rejected.status, 0); assert.ok(rejected.stderr.includes('CLAWBOT_MIGRATION_IMPORT_FAILED:empty-destinations'));
    const unchanged = docker([...base, '--entrypoint', 'node', image, '-e',
      'const f=require("node:fs"),a=require("node:assert/strict");for(const r of f.readdirSync("/target")){a.deepEqual(f.readdirSync("/target/"+r),r==="receipts"?["sentinel"]:[])}a.equal(f.readFileSync("/target/receipts/sentinel","utf8"),"retain-existing-data")']);
    assert.equal(unchanged.status, 0);
    console.log('CLAWBOT_MIGRATION_NONEMPTY_REFUSED_WITHOUT_WRITES');
    // These are this function's disposable synthetic volumes. Once the refusal
    // is proved, remove only its sentinel and import a full fixture to exercise
    // a crash-left WAL backup (a different contract from migration intake).
    assert.equal(docker([...base, '--entrypoint', 'node', image, '-e',
      'require("node:fs").unlinkSync("/target/receipts/sentinel")']).status, 0);
    assert.equal(docker([...base, '--mount', `type=bind,src=${directory},dst=/package,readonly`, '--entrypoint', 'node', image,
      '/opt/clawbot/docker/import-migration.mjs', 'rehearsal', project, sourceSha, targetCommit]).status, 0);
    assert.equal(docker([...base, '--user', '1000:1000', '--entrypoint', 'node', image, '-e',
      'const D=require("node:sqlite").DatabaseSync,d=new D("/target/receipts/message-receipts.sqlite");d.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0");d.prepare("INSERT INTO future_unknown_table VALUES(?,?)").run(42,Buffer.from("committed-wal-record"));process.exit(0)']).status, 0);
    assert.equal(docker([...base, '--entrypoint', 'node', image, '-e',
      'require("node:assert/strict").ok(require("node:fs").statSync("/target/receipts/message-receipts.sqlite-wal").size>0)']).status, 0);
    const walBackup = await backupNineVolumes({ project, image, backupRoot: join(directory, 'wal-backup-check'),
      keyRoot: join(directory, 'wal-backup-keys'), assertQuiescent: async () => {
        assert.equal(docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`]).stdout.trim(), '');
      } });
    assert.equal(walBackup.volumes, 9); assert.equal(walBackup.tables.receipts, 5);
    console.log('CLAWBOT_NINE_VOLUME_CRASH_WAL_RESTORE_OK');
    const keyPath = join(directory, 'wal-backup-keys', `${project}.key`);
    const historical = await restoreNineBackup({ directory: walBackup.directory, keyPath, image });
    assert.equal(historical.volumes, 9); assert.equal(historical.tables.receipts, 5); assert.equal(historical.productionActivated, false);
    console.log('CLAWBOT_HISTORICAL_NINE_VOLUME_WAL_RECOVERY_OK');
    const retained = await restoreNineBackup({ directory: walBackup.directory, keyPath, image, retain: true });
    assert.equal(retained.retained, true); assert.match(retained.project, /^clawbot-recovery-[a-f0-9]{12}$/);
    for (const role of MIGRATION_ROLES) recoveryResources.push({ name: `${retained.project}_${role}`, key: 'clawbot.recovery', value: retained.project.slice('clawbot-recovery-'.length) });
    if (process.argv.includes('--verify-generation') || process.argv.includes('--verify-release-update')) {
      const generation = randomUUID(), manifestBytes = readFileSync(join(directory, 'manifest.json'));
      const binding = { project, volumeGeneration: generation, sourceCommit: targetCommit,
        cutoverId: JSON.parse(manifestBytes).target.cutoverId, importManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
        recoverySourceManifestSha256: retained.sourceManifestSha256 };
      const review = generationStageTemplate(binding, retained);
      await assert.rejects(stageRecoveryGeneration({ spec: binding, candidate: retained, review, image, reservePath: directory }));
      review.reviewedAt = new Date().toISOString(); for (const key of Object.keys(review.checks)) review.checks[key] = true;
      for (const role of MIGRATION_ROLES) recoveryResources.push({ name: `${project}-recovery-${generation}_${role}`, key: 'clawbot.generation', value: generation });
      const staged = await stageRecoveryGeneration({ spec: binding, candidate: retained, review, image, reservePath: directory });
      assert.equal(staged.productionActivated, false); assert.deepEqual(staged.stagedAudit.databases, retained.audit.databases);
      assert.equal(staged.stagedAudit.entries, retained.audit.entries + 9);
      await assert.rejects(stageRecoveryGeneration({ spec: binding, candidate: retained, review, image, reservePath: directory }));
      console.log('CLAWBOT_GENERATION_COPY_WAL_SOURCE_UNCHANGED_NINE_PROOFS_AND_REPEAT_REFUSAL_OK');
      const generationBackup = await backupNineVolumes({ project, image, volumeGeneration: generation,
        backupRoot: join(directory, 'generation-backups'), keyRoot: join(directory, 'wal-backup-keys'), assertQuiescent: async () => {
          assert.equal(docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`]).stdout.trim(), '');
        } });
      const secondCandidate = await restoreNineBackup({ directory: generationBackup.directory, keyPath, image, retain: true });
      assert.equal(secondCandidate.sourceVolumeGeneration, generation);
      for (const role of MIGRATION_ROLES) recoveryResources.push({ name: `${secondCandidate.project}_${role}`, key: 'clawbot.recovery', value: secondCandidate.project.slice('clawbot-recovery-'.length) });
      const secondBinding = { ...binding, volumeGeneration: randomUUID(), recoverySourceManifestSha256: secondCandidate.sourceManifestSha256 };
      const secondReview = generationStageTemplate(secondBinding, secondCandidate);
      secondReview.reviewedAt = new Date().toISOString(); for (const key of Object.keys(secondReview.checks)) secondReview.checks[key] = true;
      for (const role of MIGRATION_ROLES) recoveryResources.push({ name: `${project}-recovery-${secondBinding.volumeGeneration}_${role}`, key: 'clawbot.generation', value: secondBinding.volumeGeneration });
      const restaged = await stageRecoveryGeneration({ spec: secondBinding, candidate: secondCandidate, review: secondReview, image, reservePath: directory });
      assert.deepEqual(restaged.stagedAudit.databases, retained.audit.databases);
      assert.equal(restaged.stagedAudit.entries, staged.stagedAudit.entries);
      console.log('CLAWBOT_GENERATION_BACKUP_RESTORE_AND_SECOND_GENERATION_PROOFS_OK');
      if (process.argv.includes('--verify-release-update')) {
        const nextImageResult = docker(['image', 'inspect', 'clawbot-release-update-rehearsal:p5']); assert.equal(nextImageResult.status, 0);
        const nextImage = JSON.parse(nextImageResult.stdout)[0].Id; assert.notEqual(nextImage, image);
        const before = { ...binding, sourceSnapshotSha256: sourceSha, services: { origin: { image: 'same-pinned-origin' }, openclaw: { image }, guard: { image } } };
        const next = { ...before, sourceCommit: 'd'.repeat(40), volumeGeneration: randomUUID(), recoverySourceManifestSha256: secondCandidate.sourceManifestSha256,
          services: { ...before.services, openclaw: { image: nextImage }, guard: { image: nextImage } } };
        const upgradeReview = releaseUpdateStageTemplate(before, next, secondCandidate);
        await assert.rejects(stageRecoveryGeneration({ spec: next, candidate: secondCandidate, review: upgradeReview, image: nextImage,
          reservePath: directory, releaseUpdateFrom: before }));
        upgradeReview.reviewedAt = new Date().toISOString(); for (const k of Object.keys(upgradeReview.checks)) upgradeReview.checks[k] = true;
        for (const role of MIGRATION_ROLES) recoveryResources.push({ name: `${project}-recovery-${next.volumeGeneration}_${role}`, key: 'clawbot.generation', value: next.volumeGeneration });
        const upgraded = await stageRecoveryGeneration({ spec: next, candidate: secondCandidate, review: upgradeReview, image: nextImage,
          reservePath: directory, releaseUpdateFrom: before });
        assert.equal(upgraded.status, 'CLAWBOT_RELEASE_UPDATE_GENERATION_STAGED'); assert.ok(upgraded.filesPreservedExceptSourceBindings);
        assert.deepEqual(upgraded.stagedAudit.databases, secondCandidate.audit.databases);
        assert.equal(upgraded.stagedAudit.entries, secondCandidate.audit.entries);
        console.log('CLAWBOT_RELEASE_UPDATE_NEW_IMAGE_NEW_SOURCE_BINDINGS_AND_ALL_PERSISTENT_DATA_PRESERVED');
        const postUpdatePrefix = `${project}-recovery-${next.volumeGeneration}`;
        assert.equal(docker(['run', '--rm', '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
          '--mount', `type=volume,src=${postUpdatePrefix}_receipts,dst=/receipts`, '--entrypoint', 'node', nextImage, '-e',
          'const D=require("node:sqlite").DatabaseSync,d=new D("/receipts/message-receipts.sqlite");d.prepare("INSERT INTO future_unknown_table VALUES(?,?)").run(43,Buffer.from("post-update-committed-record"));d.close();']).status, 0);
        const updatedBackup = await backupNineVolumes({ project, image: nextImage, volumeGeneration: next.volumeGeneration,
          backupRoot: join(directory, 'updated-backups'), keyRoot: join(directory, 'wal-backup-keys'), assertQuiescent: async () => {
            assert.equal(docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`]).stdout.trim(), '');
          } });
        const currentCandidate = await restoreNineBackup({ directory: updatedBackup.directory, keyPath, image: nextImage, retain: true });
        assert.notDeepEqual(currentCandidate.audit.databases, secondCandidate.audit.databases);
        for (const role of MIGRATION_ROLES) recoveryResources.push({ name: `${currentCandidate.project}_${role}`, key: 'clawbot.recovery', value: currentCandidate.project.slice('clawbot-recovery-'.length) });
        const revert = { ...before, volumeGeneration: randomUUID(), recoverySourceManifestSha256: currentCandidate.sourceManifestSha256 };
        const revertReview = releaseUpdateStageTemplate(next, revert, currentCandidate);
        revertReview.reviewedAt = new Date().toISOString(); for (const k of Object.keys(revertReview.checks)) revertReview.checks[k] = true;
        for (const role of MIGRATION_ROLES) recoveryResources.push({ name: `${project}-recovery-${revert.volumeGeneration}_${role}`, key: 'clawbot.generation', value: revert.volumeGeneration });
        const reverted = await stageRecoveryGeneration({ spec: revert, candidate: currentCandidate, review: revertReview, image,
          reservePath: directory, releaseUpdateFrom: next });
        assert.deepEqual(reverted.stagedAudit.databases, currentCandidate.audit.databases);
        assert.equal(reverted.sourceCommit, before.sourceCommit); assert.notEqual(reverted.volumeGeneration, before.volumeGeneration);
        console.log('CLAWBOT_OLD_CODE_NEW_GENERATION_PRESERVES_POST_UPDATE_COMMITTED_RECORD');

      }

    }
    for (const role of MIGRATION_ROLES) {
      const name = `${retained.project}_${role}`, volume = JSON.parse(docker(['volume', 'inspect', name]).stdout)[0];
      assert.equal(volume.Labels['clawbot.recovery'], retained.project.slice('clawbot-recovery-'.length));
      assert.equal(volume.Labels['clawbot.project'], undefined);
    }
    console.log('CLAWBOT_RECOVERY_CANDIDATE_RETAINED_WITHOUT_PRODUCTION_LABELS');
    const copyRoot = join(directory, 'copy-check'); mkdirSync(copyRoot, { mode: 0o700 });
    const copied = await copyVerifiedBackup({ source: walBackup.directory, destination: copyRoot, keyPath });
    assert.equal(copied.keyIncluded, false);
    assert.deepEqual(readdirSync(copied.directory).sort(), ['copy-receipt.json', 'manifest.json', 'state.enc', 'verified.json']);
    console.log('CLAWBOT_BACKUP_COPY_VERIFIED_WITHOUT_KEY');
    const invalidKey = join(directory, 'invalid-backup-key'); writeFileSync(invalidKey, Buffer.alloc(32), { mode: 0o600 });
    await assert.rejects(restoreNineBackup({ directory: walBackup.directory, keyPath: invalidKey, image }));
    const archivePath = join(walBackup.directory, 'state.enc'), encrypted = readFileSync(archivePath);
    encrypted[20] ^= 1; writeFileSync(archivePath, encrypted);
    await assert.rejects(restoreNineBackup({ directory: walBackup.directory, keyPath, image }));
    const countBeforeRefusal = readdirSync(copyRoot).length;
    await assert.rejects(copyVerifiedBackup({ source: walBackup.directory, destination: copyRoot, keyPath }));
    assert.equal(readdirSync(copyRoot).length, countBeforeRefusal);
    console.log('CLAWBOT_HISTORICAL_RECOVERY_WRONG_KEY_AND_TAMPER_REFUSED');
  } finally {
    try {
      for (const item of recoveryResources.reverse()) {
        const check = docker(['volume', 'inspect', item.name]);
        if (check.status !== 0) continue;
        assert.equal(JSON.parse(check.stdout)[0].Labels[item.key], item.value);
        assert.equal(docker(['volume', 'rm', item.name]).status, 0);
      }
      for (const name of created) {
      const check = docker(['volume', 'inspect', name]);
      assert.equal(check.status, 0); assert.equal(JSON.parse(check.stdout)[0].Labels['clawbot.project'], project);
      assert.equal(docker(['volume', 'rm', name]).status, 0);
    } } finally { unlock(); }
  }
}

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-migration-fixture-'))), payload = join(directory, 'payload');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const sourceSha = 'b'.repeat(64), targetCommit = 'c'.repeat(40), cutoverId = '11111111-2222-3333-4444-555555555555';
try {
  for (const role of MIGRATION_ROLES) mkdirSync(join(payload, role), { recursive: true, mode: 0o700 });
  function put(path, data) { const target = join(payload, path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, data, { mode: 0o600 }); }
  function json(path, value) { put(path, JSON.stringify(value)); }
  const agent = JSON.parse(readFileSync(new URL('../../config/weixin-bookkeeper-agent.example.json', import.meta.url)))
    .find((entry) => entry.path === 'agents.entries.bookkeeper').value;
  Object.assign(agent, { workspace: '/opt/clawbot/workspace', bootstrapMaxChars: 8000, bootstrapTotalMaxChars: 16000 });
  const config = { agents: { entries: { bookkeeper: agent } }, commands: { ownerAllowFrom: ['openclaw-weixin:fixture-owner'] },
    bindings: [{ type: 'route', agentId: 'bookkeeper', match: { channel: 'openclaw-weixin', accountId: 'fixture-account' }, session: { dmScope: 'per-account-channel-peer' } }],
    gateway: { mode: 'local', bind: 'loopback', port: 18789, auth: { mode: 'token', token: 'synthetic-gateway-'.repeat(4) } },
    channels: { 'openclaw-weixin': { enabled: true } }, plugins: { allow: ['clawbot-bookkeeping', 'openclaw-weixin', 'codex'],
      load: { paths: ['/opt/clawbot/plugins/clawbot-bookkeeping', '/opt/clawbot/plugins/openclaw-weixin-stable-id'] },
      entries: { 'clawbot-bookkeeping': { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: true },
        config: { deploymentProfile: 'production', serverBaseUrl: 'http://127.0.0.1:8888', tokenPath: '/var/lib/clawbot/secrets/http-token',
          mcpTokenPath: '/var/lib/clawbot/secrets/mcp-token', stateDbPath: '/var/lib/clawbot/receipts/message-receipts.sqlite', accountName: '日常支出', ledgerDisplayName: '日常账本' } },
        'openclaw-weixin': { enabled: true }, codex: { enabled: true, config: { codexDynamicToolsLoading: 'direct' } } } },
    hooks: { internal: { enabled: true, entries: { 'session-memory': { enabled: true } } } } };
  json('runtime-config/openclaw.json', config);
  const secret = 'synthetic-ledger-key-for-import-only';
  const ini = readFileSync(new URL('../../deploy/docker/ezbookkeeping.test.ini', import.meta.url), 'utf8')
    .replaceAll('/var/lib/clawbot-test', '/var/lib/clawbot').replaceAll('18888', '8888')
    .replaceAll('ezbookkeeping-test', 'ezbookkeeping').replace('__GENERATE_LOCAL_TEST_SECRET__', secret);
  put('ledger-config/ezbookkeeping.ini', ini);
  const tunnel = canonicalTunnelConfig(cutoverId); json('tunnel-config/config.json', tunnel);
  json('tunnel-config/credentials.json', { TunnelID: cutoverId, AccountTag: '0'.repeat(32), TunnelSecret: Buffer.alloc(32, 7).toString('base64') });
  json('guard-config/policy.json', { version: 1, profile: 'production', root: '/var/lib/clawbot', port: 8888,
    configPath: '/var/lib/clawbot/config/ezbookkeeping.ini', dbPath: '/var/lib/clawbot/ledger/data/ezbookkeeping.db',
    sourceSnapshotSha256: sourceSha, sourceCommit: targetCommit, configSha256: hash(ini), openclawConfigSha256: hash(JSON.stringify(config)),
    tunnelId: cutoverId, tunnelConfigSha256: hash(JSON.stringify(tunnel)) });
  json('guard-config/activation.json', { version: 1, project: 'clawbot-production', cutoverId,
    windowsReceiverStopped: true, windowsTunnelStopped: true, windowsLedgerStopped: true,
    sourceSnapshotSha256: sourceSha, sourceCommit: targetCommit });
  put('secrets/http-token', 'synthetic-http'); put('secrets/mcp-token', 'synthetic-mcp');
  json('openclaw-state/openclaw-weixin/accounts.json', ['fixture-account']);
  json('openclaw-state/openclaw-weixin/accounts/fixture-account.json', { token: 'synthetic-weixin' });
  json('openclaw-state/openclaw-weixin/accounts/fixture-account.sync.json', { get_updates_buf: 'synthetic-cursor' });
  json('openclaw-state/openclaw-weixin/accounts/fixture-account.context-tokens.json', { 'fixture-owner': 'synthetic-context' });
  json('openclaw-state/credentials/openclaw-weixin-fixture-account-allowFrom.json', { version: 1, allowFrom: ['fixture-owner'] });
  put('codex-state/synthetic-auth-state.txt', 'This is not a usable credential.');
  put('ledger-data/storage/fixture.txt', 'Synthetic attachment retained byte for byte.');
  mkdirSync(join(payload, 'ledger-data/data'), { recursive: true, mode: 0o700 });
  for (const [path, receipt] of [['ledger-data/data/ezbookkeeping.db', false], ['receipts/message-receipts.sqlite', true]]) {
    const db = new DatabaseSync(join(payload, path));
    for (const name of receipt ? ['message_receipts', 'processed_expense_confirmations', 'ended_trusted_runs', 'receipt_store_migrations', 'future_unknown_table'] : ['ledger', 'metadata']) {
      db.exec(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, value BLOB); CREATE INDEX ix_${name} ON ${name}(value)`);
      db.prepare(`INSERT INTO ${name} VALUES(?,?)`).run(9007199254740993n, Buffer.from('synthetic-persistent-record'));
    }
    db.exec('PRAGMA user_version=17'); db.close();
  }
  const entries = [];
  function inventory(path) {
    const stat = lstatSync(join(payload, path));
    if (stat.isDirectory()) { entries.push({ path, type: 'directory' }); for (const name of readdirSync(join(payload, path)).sort()) inventory(`${path}/${name}`); }
    else entries.push({ path, type: 'file', bytes: stat.size, sha256: hash(readFileSync(join(payload, path))) });
  }
  for (const role of MIGRATION_ROLES) inventory(role);
  const manifest = { format: 'clawbot-migration-directory-v1', source: { platform: 'synthetic', codeCommit: 'a'.repeat(40),
    snapshotSha256: sourceSha, ledgerSecretKeySha256: hash(secret), createdAt: new Date().toISOString(), stopped: { receiver: true, tunnel: true, ledger: true } },
    target: { sourceCommit: targetCommit, cutoverId }, entries, databases: {} };
  for (const [kind, path] of [['ledger', 'ledger-data/data/ezbookkeeping.db'], ['receipts', 'receipts/message-receipts.sqlite']]) {
    manifest.databases[kind] = { path, auditSha256: databaseAudit(join(payload, path)).auditSha256 };
  }
  const receiptPath = join(directory, 'source-receipt.json');
  writeFileSync(receiptPath, JSON.stringify({ source: manifest.source, target: manifest.target }), { mode: 0o600 });
  const generated = spawnSync(process.execPath, ['scripts/build-migration-package.mjs', directory, receiptPath, '--synthetic'],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(generated.status, 0, 'Canonical package builder failed');
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'manifest.json'))), manifest);
  const repeated = spawnSync(process.execPath, ['scripts/build-migration-package.mjs', directory, receiptPath, '--synthetic'],
    { encoding: 'utf8', timeout: 30000 });
  assert.notEqual(repeated.status, 0, 'An existing manifest must not be overwritten');
  console.log('CLAWBOT_OFFLINE_PACKAGE_BUILDER_AND_OVERWRITE_REFUSAL_OK');
  const inspected = spawnSync('/Applications/Docker.app/Contents/Resources/bin/docker', ['image', 'inspect',
    process.argv.includes('--verify-release-update') ? 'clawbot-release-update-previous-rehearsal:p5' : process.argv.includes('--verify-generation') ? 'clawbot-generation-rehearsal:p5' : 'clawbot-import-rehearsal:p3'], { encoding: 'utf8' });
  assert.equal(inspected.status, 0); const image = JSON.parse(inspected.stdout)[0].Id;
  const args = ['scripts/mac/import-migration.mjs', 'rehearsal', directory, image, sourceSha, targetCommit, '--verify-backup'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 300000 });
  assert.equal(result.status, 0, 'Synthetic import failed');
  const evidence = JSON.parse(result.stdout.trim()); assert.equal(evidence.status, 'CLAWBOT_MIGRATION_NEW_VOLUMES_VERIFIED');
  assert.equal(evidence.volumes, 9); assert.equal(evidence.tables.receipts, 5); assert.equal(evidence.activated, false);
  assert.equal(evidence.backup?.status, 'CLAWBOT_NINE_VOLUME_BACKUP_RESTORE_VERIFIED');
  assert.equal(evidence.backup.volumes, 9); assert.equal(evidence.backup.tables.receipts, 5);
  console.log('CLAWBOT_NINE_VOLUME_ENCRYPTED_BACKUP_AND_RESTORE_OK');
  console.log(JSON.stringify({ status: 'CLAWBOT_MIGRATION_REHEARSAL_OK', volumes: evidence.volumes, tables: evidence.tables, activated: false }));
  assert.match(evidence.importManifestSha256, /^[a-f0-9]{64}$/);
  await verifyNonemptyDestination(directory, image, sourceSha, targetCommit);
  // Tamper one payload while keeping the claimed inventory: refuse before any
  // destination is created, without printing the payload or private manifest.
  put('ledger-data/storage/fixture.txt', 'tampered');
  const invalid = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000 });
  assert.notEqual(invalid.status, 0); assert.ok(invalid.stderr.includes('CLAWBOT_MIGRATION_FILE'));
  console.log('CLAWBOT_MIGRATION_TAMPER_REFUSED');
} finally { rmSync(directory, { recursive: true, force: true }); }
