import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditSqliteData } from './codex-migration-checksums.mjs';

// Offline copy only. The caller supplies reviewed source/target homes and an
// exact workspace map; unknown paths are never rewritten by text substitution.
export async function prepareCodexThreadPathCopy({ sourceDatabase, outputDatabase, sourcePlatform, targetPlatform,
  sourceHome, targetHome, mountedHome, workspaces }) {
  assert.ok(['win32', 'posix'].includes(sourcePlatform) && ['win32', 'posix'].includes(targetPlatform));
  const sourcePath = sourcePlatform === 'win32' ? win32 : posix, targetPath = targetPlatform === 'win32' ? win32 : posix;
  const clean = value => sourcePlatform === 'win32' ? value.replace(/^\\\\\?\\/, '') : value;
  assert.ok(sourcePath.isAbsolute(clean(sourceHome)) && targetPath.isAbsolute(targetHome));
  assert.equal(realpathSync(mountedHome), mountedHome);
  assert.ok(!existsSync(outputDatabase));
  const stat = lstatSync(sourceDatabase); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  const db = new DatabaseSync(existsSync(sourceDatabase + '-wal') ? sourceDatabase : `${pathToFileURL(sourceDatabase).href}?immutable=1`, { readOnly: true });
  let dataSha256, changes;
  try {
    dataSha256 = auditSqliteData(db, { threads: ['rollout_path', 'cwd'] });
    changes = db.prepare('SELECT id, rollout_path, cwd FROM threads ORDER BY id').all().map(row => {
      const relative = sourcePath.relative(clean(sourceHome), clean(row.rollout_path));
      const segments = relative.split(sourcePath.sep);
      assert.ok(!sourcePath.isAbsolute(relative) && segments.length > 1 && segments.every(part => part && part !== '.' && part !== '..')
        && ['sessions', 'archived_sessions'].includes(segments[0]) && segments.at(-1).endsWith('.jsonl'), 'Unrecognized rollout path');
      const actual = join(mountedHome, ...segments), s = lstatSync(actual);
      assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && realpathSync(actual) === actual, 'Missing or linked rollout');
      assert.ok(Object.hasOwn(workspaces, row.cwd) && targetPath.isAbsolute(workspaces[row.cwd]), 'Workspace needs explicit mapping');
      return { ...row, nextRollout: targetPath.join(targetHome, ...segments), nextCwd: workspaces[row.cwd] };
    });
    await backup(db, outputDatabase); chmodSync(outputDatabase, 0o600);
  } finally { db.close(); }
  const output = new DatabaseSync(outputDatabase);
  try {
    assert.equal(auditSqliteData(output, { threads: ['rollout_path', 'cwd'] }), dataSha256);
    output.exec('BEGIN IMMEDIATE');
    try {
      const statement = output.prepare('UPDATE threads SET rollout_path=?,cwd=? WHERE id=? AND rollout_path=? AND cwd=?');
      for (const row of changes) assert.equal(statement.run(row.nextRollout, row.nextCwd, row.id, row.rollout_path, row.cwd).changes, 1);
      assert.equal(auditSqliteData(output, { threads: ['rollout_path', 'cwd'] }), dataSha256, 'Non-path data changed');
      output.exec('COMMIT');
    } catch (error) { output.exec('ROLLBACK'); throw error; }
    output.exec('PRAGMA journal_mode=DELETE');
  } finally { output.close(); }
  return { status: 'CLAWBOT_CODEX_THREAD_PATH_COPY_VERIFIED', threads: changes.length, dataSha256 };
}
