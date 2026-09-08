import assert from 'node:assert/strict';
import { lstatSync, realpathSync, readFileSync, readdirSync, createReadStream, openSync,
  writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateLedgerTokenPairInDatabase } from './ledger-token-validation.mjs';

const roles = ['http', 'mcp'];
export const rotationMarker = '.ledger-token-rotation.json';
const temporaryName = role => `.ledger-token-rotation-${role}.tmp`;
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value);
const refused = 'CLAWBOT_LEDGER_ROTATION_REFUSED_MAINTENANCE_REQUIRED';
function privateFile(path, max = 16384) {
  const s = lstatSync(path);
  assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === process.getuid() && s.gid === process.getgid()
    && (s.mode & 0o777) === 0o600 && s.size <= max && realpathSync(path) === path);
  return readFileSync(path);
}
function present(path) {
  try { lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
export function assertLedgerRotationComplete(root) {
  // lstat also rejects a dangling marker symlink; existsSync would miss it.
  for (const name of [rotationMarker, ...roles.map(temporaryName)]) {
    if (present(join(root, name))) throw Error('CLAWBOT_LEDGER_ROTATION_INCOMPLETE');
  }
}
function syncDirectory(root) {
  const fd = openSync(root, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableCreate(path, bytes) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
async function inventory(root, excluded = []) {
  assert.equal(realpathSync(root), root);
  const entries = []; let bytes = 0;
  async function walk(relative) {
    assert.ok(entries.length < 100000 && relative.length < 4096 && relative.split('/').length < 64);
    if (excluded.includes(relative)) return;
    const path = join(root, relative), s = lstatSync(path);
    const row = { path: relative, mode: s.mode & 0o7777, uid: s.uid, gid: s.gid };
    assert.ok(!s.isSymbolicLink());
    if (s.isDirectory()) {
      entries.push({ ...row, type: 'directory' });
      for (const name of readdirSync(path).sort()) await walk(relative ? `${relative}/${name}` : name);
    } else {
      assert.ok(s.isFile() && s.nlink === 1 && s.size <= 4 * 2 ** 30);
      bytes += s.size; assert.ok(bytes <= 20 * 2 ** 30);
      const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk);
      entries.push({ ...row, type: 'file', bytes: s.size, hash: digest.digest('hex') });
    }
  }
  await walk(''); return hash(encode(entries));
}

// Internal offline operation only. The host must hold maintenance + exclusive
// operation lock, verify an encrypted backup, and prove no volume consumers.
// expectedUsername comes from a separately reviewed identity, never JWT claims.
// This function neither creates/revokes tokens nor starts any service.
export async function rotateLedgerTokens({ action, ledgerRoot, databaseRelativePath, secretsRoot,
  sourceRoot, expectedUsername, expectedBinding, now }) {
  let temporary, db;
  try {
    assert.ok(['inspect', 'apply', 'resume', 'verify-saved'].includes(action));
    assert.ok(typeof expectedUsername === 'string' && expectedUsername.length > 0 && expectedUsername.length <= 256);
    assert.ok(typeof databaseRelativePath === 'string' && /^[A-Za-z0-9_./-]+$/.test(databaseRelativePath)
      && !databaseRelativePath.startsWith('/') && !databaseRelativePath.split('/').some(p => !p || p === '.' || p === '..'));
    for (const root of [ledgerRoot, secretsRoot, sourceRoot]) {
      assert.equal(realpathSync(root), root); assert.ok(lstatSync(root).isDirectory());
    }
    assert.equal(new Set([ledgerRoot, secretsRoot, sourceRoot]).size, 3);
    for (const left of [ledgerRoot, secretsRoot, sourceRoot]) for (const right of [ledgerRoot, secretsRoot, sourceRoot]) {
      if (left !== right) assert.ok(!left.startsWith(right + '/'));
    }
    const markerPath = join(secretsRoot, rotationMarker);
    if (action !== 'resume') assertLedgerRotationComplete(secretsRoot);
    const sourceBytes = Object.fromEntries(roles.map(role => [role, privateFile(join(sourceRoot, `${role}-token`))]));
    const tokens = Object.fromEntries(roles.map(role => [role, sourceBytes[role].toString('utf8').trim()]));
    const newHashes = Object.fromEntries(roles.map(role => [role, hash(sourceBytes[role])]));
    const currentHashes = Object.fromEntries(roles.map(role => [role, hash(privateFile(join(secretsRoot, `${role}-token`)))]));
    const exclude = [rotationMarker, ...roles.map(temporaryName), ...roles.map(role => `${role}-token`)];
    const evidence = { ledger: await inventory(ledgerRoot), otherSecrets: await inventory(secretsRoot, exclude),
      source: await inventory(sourceRoot), expectedUsernameSha256: hash(expectedUsername), newHashes };
    const databasePath = join(ledgerRoot, databaseRelativePath);
    assert.equal(realpathSync(databasePath), databasePath);
    const journal = databasePath + '-journal';
    if (present(journal)) assert.equal(lstatSync(journal).size, 0);
    // Validate a disposable SQLite copy so a read cannot create/change WAL
    // sidecars on the original. A present WAL is copied, never ignored.
    temporary = mkdtempSync(join(tmpdir(), 'clawbot-ledger-rotation-'));
    let copiedBytes = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      const path = databasePath + suffix;
      if (suffix && !present(path)) continue;
      const s = lstatSync(path); copiedBytes += s.size;
      assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && copiedBytes <= 512 * 2 ** 20);
      copyFileSync(path, join(temporary, 'ledger.sqlite' + suffix));
    }
    db = new DatabaseSync(join(temporary, 'ledger.sqlite'), { readOnly: true }); db.exec('BEGIN');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const query = db.prepare('SELECT uid FROM user WHERE username=? AND disabled=0 AND deleted=0 LIMIT 2'); query.setReadBigInts(true);
    const users = query.all(expectedUsername); assert.equal(users.length, 1);
    const report = validateLedgerTokenPairInDatabase(db, tokens, users[0].uid.toString(), now);
    db.exec('COMMIT'); db.close(); db = null;
    if (action === 'verify-saved') {
      assert.deepEqual(currentHashes, newHashes);
      assert.equal(await inventory(ledgerRoot), evidence.ledger);
      assert.equal(await inventory(sourceRoot), evidence.source);
      assert.equal(await inventory(secretsRoot, exclude), evidence.otherSecrets);
      for (const role of roles) assert.equal(hash(privateFile(join(secretsRoot, `${role}-token`))), newHashes[role]);
      assertLedgerRotationComplete(secretsRoot);
      return { ...report, status: 'CLAWBOT_LEDGER_SAVED_PAIR_VERIFIED', readOnlySavedPair: true };
    }
    let plan = { version: 1, ...evidence, oldHashes: currentHashes };
    if (action === 'resume') {
      plan = JSON.parse(privateFile(markerPath, 8192));
      assert.equal(plan.version, 1);
      for (const [key, value] of Object.entries(evidence)) assert.deepEqual(plan[key], value);
      for (const role of roles) {
        assert.match(plan.oldHashes[role], /^[a-f0-9]{64}$/);
        assert.ok([plan.oldHashes[role], newHashes[role]].includes(currentHashes[role]));
      }
    } else {
      assert.ok(roles.some(role => currentHashes[role] !== newHashes[role]), 'No credential change');
    }
    const binding = hash(encode(plan));
    if (action !== 'inspect') assert.equal(expectedBinding, binding);
    assert.equal(await inventory(ledgerRoot), evidence.ledger);
    assert.equal(await inventory(sourceRoot), evidence.source);
    assert.equal(await inventory(secretsRoot, exclude), evidence.otherSecrets);
    for (const role of roles) assert.equal(hash(privateFile(join(secretsRoot, `${role}-token`))), currentHashes[role]);
    if (action === 'inspect') return { ...report, status: 'CLAWBOT_LEDGER_ROTATION_READY_FOR_REVIEW', binding };

    if (action === 'apply') { durableCreate(markerPath, encode(plan)); syncDirectory(secretsRoot); }
    // The durable marker is written before either token changes. A crash or
    // ENOSPC leaves it in place; startup refuses it. Resume is an explicit
    // operation bound to the exact original reviewed plan, not an auto-rollback.
    for (const role of roles) {
      const target = join(secretsRoot, `${role}-token`), pending = join(secretsRoot, temporaryName(role));
      if (present(pending)) {
        // A crash may leave a partial temporary write. Only this reserved,
        // private regular file is ours to replace under the matching marker.
        privateFile(pending); unlinkSync(pending); syncDirectory(secretsRoot);
      }
      if (hash(privateFile(target)) === newHashes[role]) continue;
      durableCreate(pending, sourceBytes[role]);
      renameSync(pending, target); syncDirectory(secretsRoot);
    }
    for (const role of roles) assert.equal(hash(privateFile(join(secretsRoot, `${role}-token`))), newHashes[role]);
    assert.equal(await inventory(ledgerRoot), evidence.ledger);
    assert.equal(await inventory(sourceRoot), evidence.source);
    assert.equal(await inventory(secretsRoot, exclude), evidence.otherSecrets);
    assert.deepEqual(JSON.parse(privateFile(markerPath)), plan);
    unlinkSync(markerPath); syncDirectory(secretsRoot);
    assertLedgerRotationComplete(secretsRoot);
    return { ...report, status: 'CLAWBOT_LEDGER_TOKENS_SAVED_MAINTENANCE_REQUIRED', binding,
      unrelatedStatePreserved: true };
  } catch { throw Error(refused); }
  finally { try { db?.close(); } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); } }
}
