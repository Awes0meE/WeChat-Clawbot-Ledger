import assert from 'node:assert/strict';
import { lstatSync, readdirSync, readFileSync, readSync, readlinkSync, realpathSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, chownSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MIGRATION_ROLES } from './migration-format.mjs';
import { generationReceipt } from './generation-receipts.mjs';
import { validateGuardPolicy } from '../guard/origin-identity.mjs';
import { validateActivation } from '../guard/tunnel-policy.mjs';

export function releaseUpdateContract(before, after) {
  for (const key of ['project', 'cutoverId', 'sourceSnapshotSha256', 'importManifestSha256']) assert.equal(after[key], before[key]);
  assert.ok([before.sourceCommit, after.sourceCommit].every(v => /^[a-f0-9]{40}$/.test(v ?? '')));
  assert.notEqual(after.sourceCommit, before.sourceCommit, 'A release update selects a different source version');
  assert.ok(after.volumeGeneration && after.volumeGeneration !== (before.volumeGeneration ?? null));
  assert.equal(after.services.origin.image, before.services.origin.image, 'Database engine changes need a separate migration');
  for (const role of ['openclaw', 'guard']) {
    assert.ok([before.services[role].image, after.services[role].image].every(v => /^sha256:[a-f0-9]{64}$/.test(v ?? '')));
    assert.notEqual(after.services[role].image, before.services[role].image, 'Both source-labelled images must belong to the new release');
  }
  if (after.profile === 'rehearsal') {
    assert.equal(before.profile, 'rehearsal'); assert.match(after.project, /^clawbot-rehearsal-[a-f0-9]{12}$/);
    assert.match(after.volumeGeneration, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    assert.match(after.recoverySourceManifestSha256, /^[a-f0-9]{64}$/);
  } else generationReceipt(after);
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fileDigest(path) {
  const fd = openSync(path, 'r'), hash = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024);
  try { let n; while ((n = readSync(fd, chunk, 0, chunk.length, null))) hash.update(chunk.subarray(0, n)); }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
function inventory(root) {
  assert.equal(realpathSync(root), root);
  const rows = new Map(); let bytes = 0;
  function walk(relative) {
    assert.ok(rows.size < 100000 && relative.length < 4096 && relative.split('/').length < 64);
    const path = join(root, relative), s = lstatSync(path);
    if (s.isSocket()) return;
    const row = { mode: s.mode & 0o7777, uid: s.uid, gid: s.gid };
    if (s.isDirectory()) {
      rows.set(relative, { ...row, type: 'directory' });
      for (const name of readdirSync(path).sort()) walk(`${relative}/${name}`);
    } else if (s.isSymbolicLink()) rows.set(relative, { ...row, type: 'symlink', target: readlinkSync(path) });
    else {
      assert.ok(s.isFile() && s.size <= 4 * 2 ** 30); bytes += s.size; assert.ok(bytes <= 40 * 2 ** 30);
      rows.set(relative, { ...row, type: 'file', bytes: s.size, sha256: fileDigest(path) });
    }
  }
  for (const role of MIGRATION_ROLES) {
    const s = lstatSync(join(root, role)); assert.ok(s.isDirectory() && !s.isSymbolicLink()); walk(role);
  }
  return rows;
}
function replacements(source, before, after) {
  const result = new Map();
  const read = relative => {
    const path = join(source, relative), stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && !(stat.mode & 0o222) && stat.size < 16384);
    return JSON.parse(readFileSync(path));
  };
  const policy = validateGuardPolicy(read('guard-config/policy.json'));
  assert.equal(policy.sourceCommit, before.sourceCommit); assert.equal(policy.sourceSnapshotSha256, before.sourceSnapshotSha256);
  const activation = read('guard-config/activation.json'); validateActivation(activation, policy); assert.equal(activation.cutoverId, before.cutoverId);
  // No identity, token, route, model, cursor or database is rewritten.
  for (const [path, value] of [['guard-config/policy.json', policy], ['guard-config/activation.json', activation]]) {
    result.set(path, Buffer.from(JSON.stringify({ ...value, sourceCommit: after.sourceCommit })));
  }
  return result;
}
export function verifyReleaseUpdateData(source, target, before, after, { final = true, unchanged = false } = {}) {
  releaseUpdateContract(before, after);
  assert.ok(source !== target && !source.startsWith(target + '/') && !target.startsWith(source + '/'));
  const original = inventory(source), actual = inventory(target), expected = new Map(original);
  if (!unchanged) for (const [path, bytes] of replacements(source, before, after)) {
    expected.set(path, { ...original.get(path), bytes: bytes.length, sha256: digest(bytes) });
  }
  if (final && !unchanged) for (const role of MIGRATION_ROLES) {
    const path = `${role}/recovery-generation.json`, bytes = Buffer.from(JSON.stringify(generationReceipt(after)));
    if (before.volumeGeneration) {
      assert.equal(readFileSync(join(source, path), 'utf8'), JSON.stringify(generationReceipt(before)));
      const st = lstatSync(join(source, path)); assert.ok(st.nlink === 1 && !(st.mode & 0o222));
    } else assert.ok(!original.has(path), 'Unexpected source generation receipt');
    const st = lstatSync(join(target, path)); assert.ok(st.nlink === 1);
    expected.set(path, { mode: 0o400, uid: 1000, gid: 1000, type: 'file', bytes: bytes.length, sha256: digest(bytes) });
  }
  assert.deepEqual([...actual.entries()].sort(), [...expected.entries()].sort(), 'Unexpected release update data change');
  return { persistentFilesPreserved: true, changedConfigPaths: unchanged ? [] : [...replacements(source, before, after).keys()], generationReceiptsVerified: final && !unchanged };
}
export function rebindReleaseUpdateData(source, target, before, after) {
  verifyReleaseUpdateData(source, target, before, after, { final: false, unchanged: true });
  for (const [relative, bytes] of replacements(source, before, after)) {
    const path = join(target, relative), stat = lstatSync(path);
    assert.ok(stat.nlink === 1 && !stat.isSymbolicLink());
    const temporary = `${path}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', stat.mode & 0o7777);
    try { writeFileSync(fd, bytes); chownSync(temporary, stat.uid, stat.gid); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const dir = openSync(join(target, 'guard-config'), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  return verifyReleaseUpdateData(source, target, before, after, { final: false });
}
