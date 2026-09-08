import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCodexThreadPathCopy } from '../../../scripts/codex-thread-paths.mjs';
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-native-path-'))), mountedHome = join(root, 'home');
  mkdirSync(join(mountedHome, 'sessions'), { recursive: true }); writeFileSync(join(mountedHome, 'sessions/one.jsonl'), 'unchanged transcript\n');
  const sourceDatabase = join(root, 'state.sqlite'), db = new DatabaseSync(sourceDatabase);
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT,note TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?)').run('one', '\\\\?\\C:\\old\\sessions\\one.jsonl', '\\\\?\\D:\\workspace', 'C:\\keep-this-in-the-conversation'); db.close();
  return { root, sourceDatabase, outputDatabase: join(root, 'candidate.sqlite'), sourcePlatform: 'win32', targetPlatform: 'posix',
    sourceHome: 'C:\\old', targetHome: '/new/home', mountedHome, workspaces: { '\\\\?\\D:\\workspace': '/new/workspace' } };
}
test('only reviewed thread path columns change; source and transcript remain byte-identical', async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.sourceDatabase); assert.equal((await prepareCodexThreadPathCopy(f)).threads, 1);
    assert.deepEqual(readFileSync(f.sourceDatabase), before); assert.equal(readFileSync(join(f.mountedHome, 'sessions/one.jsonl'), 'utf8'), 'unchanged transcript\n');
    const d = new DatabaseSync(f.outputDatabase, { readOnly: true }), r = d.prepare('SELECT * FROM threads').get();
    assert.equal(r.rollout_path, '/new/home/sessions/one.jsonl'); assert.equal(r.cwd, '/new/workspace'); assert.equal(r.note, 'C:\\keep-this-in-the-conversation'); d.close();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('unknown workspace or missing rollout refuses before producing a candidate', async () => {
  const f = fixture();
  try {
    await assert.rejects(prepareCodexThreadPathCopy({ ...f, workspaces: {} }), /explicit mapping/);
    assert.equal(existsSync(f.outputDatabase), false);
    rmSync(join(f.mountedHome, 'sessions/one.jsonl'));
    await assert.rejects(prepareCodexThreadPathCopy(f)); assert.equal(existsSync(f.outputDatabase), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
