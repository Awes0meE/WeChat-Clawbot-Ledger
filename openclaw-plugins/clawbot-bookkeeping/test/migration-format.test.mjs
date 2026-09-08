import test from 'node:test';
import assert from 'node:assert/strict';
import { MIGRATION_ROLES, migrationPath, validateMigrationManifest } from '../../../deploy/docker/migration-format.mjs';
function fixture() {
  const paths = ['ledger-config/ezbookkeeping.ini', 'ledger-data/data/ezbookkeeping.db', 'runtime-config/openclaw.json',
    'guard-config/policy.json', 'guard-config/activation.json', 'tunnel-config/config.json', 'tunnel-config/credentials.json',
    'receipts/message-receipts.sqlite', 'secrets/http-token', 'secrets/mcp-token'];
  return { format: 'clawbot-migration-directory-v1', source: { platform: 'synthetic', codeCommit: 'a'.repeat(40),
    snapshotSha256: 'b'.repeat(64), ledgerSecretKeySha256: 'd'.repeat(64), createdAt: '2026-09-08T00:00:00Z', stopped: { receiver: true, tunnel: true, ledger: true } },
    target: { sourceCommit: 'c'.repeat(40), cutoverId: '11111111-2222-3333-4444-555555555555' },
    entries: [...MIGRATION_ROLES, 'ledger-data/data'].map((path) => ({ path, type: 'directory' }))
      .concat(paths.map((path) => ({ path, type: 'file', bytes: 1, sha256: 'd'.repeat(64) }))),
    databases: { ledger: { path: paths[1], auditSha256: 'e'.repeat(64) }, receipts: { path: paths[7], auditSha256: 'f'.repeat(64) } } };
}
const options = { rehearsal: true, expectedSourceSha256: 'b'.repeat(64), expectedTargetCommit: 'c'.repeat(40) };
test('Migration intake binds source and target, all nine state roles and both full database audits', () => {
  assert.equal(validateMigrationManifest(fixture(), options).bytes, 10);
  for (const mutate of [
    (m) => m.source.stopped.receiver = false,
    (m) => m.source.snapshotSha256 = 'x',
    (m) => m.target.sourceCommit = 'a'.repeat(40),
    (m) => m.entries.pop(),
    (m) => m.entries.push({ type: 'directory', path: 'openclaw-state/hooks/session-memory' }),
    (m) => m.entries.push({ ...m.entries.at(-1), path: 'secrets/HTTP-TOKEN' }),
    (m) => m.entries.push({ type: 'file', path: 'receipts/message-receipts.sqlite-wal', bytes: 1, sha256: 'd'.repeat(64) }),
    (m) => m.databases.receipts.auditSha256 = null,
    (m) => m.databases.extra = { path: '../../outside.db', auditSha256: 'f'.repeat(64) },
  ]) { const m = fixture(); mutate(m); assert.throws(() => validateMigrationManifest(m, options)); }
  assert.throws(() => validateMigrationManifest(fixture(), { ...options, rehearsal: false }));
});
test('Migration paths reject traversal, alternate streams, case aliases and symlink-like types', () => {
  for (const path of ['../secrets/key', '/ledger-data/x', 'ledger-data/a/../b', 'ledger-data/a\\b', 'secrets/token:stream',
    'ledger-data/a\0x', 'ledger-data//x', 'ledger-data/file.', 'ledger-data/.clawbot-import.json']) assert.throws(() => migrationPath(path));
  const m = fixture(); m.entries[0].type = 'symlink'; assert.throws(() => validateMigrationManifest(m, options));
});
