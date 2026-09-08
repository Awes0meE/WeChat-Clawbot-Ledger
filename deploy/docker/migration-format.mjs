export const MIGRATION_ROLES = Object.freeze(['ledger-config', 'ledger-data', 'runtime-config', 'guard-config',
  'tunnel-config', 'openclaw-state', 'codex-state', 'receipts', 'secrets']);
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export function migrationPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || value.normalize('NFC') !== value
    || /[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith('/')
    || value.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))
    || value.split('/').length > 48 || !MIGRATION_ROLES.includes(value.split('/')[0])
    || value.split('/').some((part) => part === '.clawbot-import.json')) throw new Error('CLAWBOT_MIGRATION_PATH');
  return value;
}
export function validateMigrationManifest(manifest, { rehearsal = false, expectedSourceSha256, expectedTargetCommit } = {}) {
  const fail = () => { throw new Error('CLAWBOT_MIGRATION_MANIFEST'); };
  if (manifest?.format !== 'clawbot-migration-directory-v1' || !hash(expectedSourceSha256)
    || manifest.source?.snapshotSha256 !== expectedSourceSha256 || !hash(manifest.source?.ledgerSecretKeySha256) || !commit(expectedTargetCommit)
    || manifest.target?.sourceCommit !== expectedTargetCommit || !commit(manifest.source?.codeCommit)
    || !Number.isFinite(Date.parse(manifest.source?.createdAt ?? ''))
    || manifest.source?.platform !== (rehearsal ? 'synthetic' : 'win32')
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(manifest.target?.cutoverId ?? '')
    || !['receiver', 'tunnel', 'ledger'].every((key) => manifest.source?.stopped?.[key] === true)
    || !Array.isArray(manifest.entries) || manifest.entries.length < 9 || manifest.entries.length > 100000) fail();
  const paths = new Map(), aliases = new Set(); let bytes = 0;
  for (const entry of manifest.entries) {
    const path = migrationPath(entry.path), alias = path.toLowerCase();
    // This is executable platform-specific code, regenerated from the pinned
    // Linux image. Preserve it in the original Windows backup, not the intake.
    if (alias === 'openclaw-state/hooks/session-memory' || alias.startsWith('openclaw-state/hooks/session-memory/')) fail();
    if (aliases.has(alias) || !['file', 'directory'].includes(entry.type)) fail();
    aliases.add(alias); paths.set(path, entry);
    if (entry.type === 'file') {
      if (!hash(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 4 * 2 ** 30) fail();
      bytes += entry.bytes;
      // Source databases must be consistent snapshots, not copied live WALs.
      if (/\.(db|sqlite|sqlite3)-(wal|shm|journal)$/.test(path)) fail();
    }
  }
  if (bytes > 40 * 2 ** 30) fail();
  for (const role of MIGRATION_ROLES) if (paths.get(role)?.type !== 'directory') fail();
  for (const path of paths.keys()) {
    const parent = path.split('/').slice(0, -1).join('/');
    if (parent && paths.get(parent)?.type !== 'directory') fail();
  }
  const required = ['ledger-config/ezbookkeeping.ini', 'ledger-data/data/ezbookkeeping.db',
    'runtime-config/openclaw.json', 'guard-config/policy.json', 'guard-config/activation.json',
    'tunnel-config/config.json', 'tunnel-config/credentials.json', 'receipts/message-receipts.sqlite',
    'secrets/http-token', 'secrets/mcp-token'];
  for (const path of required) if (paths.get(path)?.type !== 'file') fail();
  if (JSON.stringify(Object.keys(manifest.databases ?? {}).sort()) !== JSON.stringify(['ledger', 'receipts'])) fail();
  for (const [kind, path] of [['ledger', required[1]], ['receipts', required[7]]]) {
    const db = manifest.databases?.[kind];
    if (db?.path !== path || !hash(db.auditSha256)) fail();
  }
  return { entries: manifest.entries.length, bytes, paths };
}
export function migrationFileMode(path) {
  return ['ledger-config', 'runtime-config', 'guard-config', 'tunnel-config'].includes(path.split('/')[0]) ? 0o400 : 0o600;
}
