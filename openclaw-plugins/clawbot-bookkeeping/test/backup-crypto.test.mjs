import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { encryptArchive, decryptArchive } from '../../../scripts/mac/backup-crypto.mjs';

test('backup encryption authenticates data, key and release metadata', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-backup-'));
  try {
    const file = join(directory, 'state.enc'), key = randomBytes(32), manifest = { project: 'clawbot-test', version: 1 };
    const source = Buffer.from('synthetic fixture '.repeat(10000));
    await encryptArchive(Readable.from([source]), file, key, manifest);
    const pieces = [];
    await decryptArchive(file, key, manifest, new Writable({ write(chunk, _enc, done) { pieces.push(chunk); done(); } }));
    assert.deepEqual(Buffer.concat(pieces), source);
    assert.equal(readFileSync(file).includes(Buffer.from('synthetic fixture')), false);
    await assert.rejects(decryptArchive(file, randomBytes(32), manifest));
    await assert.rejects(decryptArchive(file, key, { ...manifest, version: 2 }));
    const corrupted = readFileSync(file); corrupted[30] ^= 1; writeFileSync(file, corrupted);
    await assert.rejects(decryptArchive(file, key, manifest));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
