import { readdirSync, lstatSync, readlinkSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { MIGRATION_ROLES } from './migration-format.mjs';
import { databaseAudit } from './database-audit.mjs';
try {
  if (process.argv.length > 3 || (process.argv[2] && !['--exclude-ledger-rotation','--exclude-openclaw-state','--exclude-tunnel-credential'].includes(process.argv[2]))) throw new Error();
  const rotation = process.argv[2] === '--exclude-ledger-rotation';
  const excludeOpenclaw = process.argv[2] === '--exclude-openclaw-state';
  const tunnelCredential = process.argv[2] === '--exclude-tunnel-credential';
  const excluded = rotation ? ['secrets/http-token', 'secrets/mcp-token', 'secrets/.ledger-token-rotation.json',
    'secrets/.ledger-token-rotation-http.tmp', 'secrets/.ledger-token-rotation-mcp.tmp'] : tunnelCredential ? ['tunnel-config/credentials.json'] : [];
  const entries = []; let bytes = 0;
  async function walk(relative) {
    if (excluded.includes(relative)) return;
    if (entries.length >= 100000 || relative.length > 4096 || relative.split('/').length > 64) throw new Error();
    const path = join('/state', relative), stat = lstatSync(path);
    if (stat.isSocket()) return; // Not persistent state; tar also skips sockets.
    const item = { path: relative, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
    if (stat.isSymbolicLink()) entries.push({ ...item, type: 'symlink', target: readlinkSync(path) });
    else if (stat.isDirectory()) {
      entries.push({ ...item, type: 'directory' });
      for (const name of readdirSync(path).sort()) await walk(`${relative}/${name}`);
    } else {
      if (!stat.isFile() || stat.size > 4 * 2 ** 30) throw new Error();
      const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk);
      bytes += stat.size; if (bytes > 40 * 2 ** 30) throw new Error();
      entries.push({ ...item, type: 'file', bytes: stat.size, sha256: hash.digest('hex') });
    }
  }
  for (const role of MIGRATION_ROLES) if (!(excludeOpenclaw && role === 'openclaw-state')) await walk(role);
  const databases = {};
  for (const [name, path] of [['ledger', 'ledger-data/data/ezbookkeeping.db'], ['receipts', 'receipts/message-receipts.sqlite']]) {
    databases[name] = databaseAudit(join('/state', path), { requireDelete: false, offlineWithoutWal: true });
  }
  console.log(JSON.stringify({ version: 1, ...(rotation ? { scope: 'excluding-ledger-rotation' } : {}),
    ...(excludeOpenclaw ? { scope: 'excluding-openclaw-state' } : {}), entries: entries.length, bytes,
    ...(tunnelCredential ? { scope: 'excluding-tunnel-credential' } : {}),
    inventorySha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), databases }));
} catch { console.error('CLAWBOT_NINE_VOLUME_AUDIT_FAILED'); process.exit(1); }
