import { lstatSync, realpathSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { auditReceiptReconciliation } from '../../deploy/docker/reconciliation-audit.mjs';

try {
  if (!process.argv[2]) throw new Error();
  const directory = resolve(process.argv[2]), root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
  if (directory === root || directory.startsWith(root + sep) || realpathSync(directory) !== directory) throw new Error();
  const ds = lstatSync(directory);
  if (!ds.isDirectory() || ds.uid !== process.getuid() || (ds.mode & 0o077)) throw new Error();
  const paths = ['ledger.sqlite', 'receipts.sqlite', 'scope.json'].map((name) => join(directory, name));
  for (const path of paths) {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid()
      || (st.mode & 0o077) || st.size > (path.endsWith('.json') ? 4096 : 512 * 2 ** 20)
      || ['-wal', '-shm', '-journal'].some((suffix) => existsSync(path + suffix))) throw new Error();
  }
  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const before = paths.map(digest), scope = JSON.parse(readFileSync(paths[2]));
  if (JSON.stringify(Object.keys(scope).sort()) !== JSON.stringify(['accountId', 'ownerId'])) throw new Error();
  const result = auditReceiptReconciliation({ ledgerPath: paths[0], receiptsPath: paths[1], ownerId: scope.ownerId, accountId: scope.accountId });
  if (JSON.stringify(before) !== JSON.stringify(paths.map(digest))) throw new Error();
  writeFileSync(join(directory, 'reconciliation-report.json'), JSON.stringify({ ...result,
    checkedAt: new Date().toISOString(), sourceSHA256: before }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: result.status, counts: result.counts, sourcesUnchanged: true, automaticRestartAuthorized: false }));
} catch { console.error('CLAWBOT_RECONCILIATION_AUDIT_FAILED'); process.exitCode = 1; }
