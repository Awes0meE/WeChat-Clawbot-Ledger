import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync, realpathSync, mkdirSync, copyFileSync, statfsSync, constants } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { fileSha256 } from '../../deploy/docker/migration-files.mjs';
import { decryptArchive } from './backup-crypto.mjs';

export async function copyVerifiedBackup({ source, destination, keyPath }) {
  const files = ['manifest.json', 'state.enc', 'verified.json'];
  for (const directory of [source, destination]) {
    const stat = lstatSync(directory);
    assert.ok(stat.isDirectory() && realpathSync(directory) === directory && stat.uid === process.getuid() && !(stat.mode & 0o077));
  }
  const hashes = {}; let bytes = 0;
  for (const file of [...files, keyPath]) {
    const path = files.includes(file) ? join(source, file) : file, stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077));
    assert.ok(stat.size <= (file === 'state.enc' ? 20 * 2 ** 30 : file === keyPath ? 32 : 65536));
    if (files.includes(file)) { hashes[file] = await fileSha256(path); bytes += stat.size; }
  }
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'))), verified = JSON.parse(readFileSync(join(source, 'verified.json')));
  assert.ok(['clawbot-offline-aes256gcm-v1', 'clawbot-nine-volume-aes256gcm-v1'].includes(manifest.format));
  assert.ok(manifest.project === 'clawbot-test' || manifest.project === 'clawbot-production' || /^clawbot-import-check-[a-f0-9]{12}$/.test(manifest.project));
  assert.equal(verified.status, 'restored-and-verified'); assert.equal(verified.fileInventory, true);
  assert.equal(verified.ledgerAndReceiptIntegrity, true); assert.equal(verified.restoreNetwork, 'none');
  const key = readFileSync(keyPath); await decryptArchive(join(source, 'state.enc'), key, manifest);
  const disk = statfsSync(destination); assert.ok(disk.bavail * disk.bsize >= bytes * 2 + 2 ** 30, 'Copy reserve is insufficient');
  const target = join(destination, `${manifest.project}-copy-${randomUUID()}`); mkdirSync(target, { mode: 0o700 });
  for (const file of files) {
    copyFileSync(join(source, file), join(target, file), constants.COPYFILE_EXCL);
    assert.equal(await fileSha256(join(target, file)), hashes[file]);
  }
  await decryptArchive(join(target, 'state.enc'), key, JSON.parse(readFileSync(join(target, 'manifest.json'))));
  const receipt = { status: 'CLAWBOT_ENCRYPTED_BACKUP_COPY_VERIFIED', copiedAt: new Date().toISOString(),
    archiveSha256: hashes['state.enc'], copiedFiles: files, keyIncluded: false };
  writeFileSync(join(target, 'copy-receipt.json'), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  return { ...receipt, directory: target };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [sourceArg, destinationArg, keyArg] = process.argv.slice(2);
    if (!sourceArg || !destinationArg || !keyArg) throw Error();
    const repository = fileURLToPath(new URL('../../', import.meta.url));
    for (const arg of [sourceArg, destinationArg, keyArg]) {
      const path = realpathSync(resolve(arg)), local = relative(repository, path);
      assert.ok(local.startsWith('..') || isAbsolute(local));
    }
    console.log(JSON.stringify(await copyVerifiedBackup({ source: realpathSync(resolve(sourceArg)),
      destination: realpathSync(resolve(destinationArg)), keyPath: realpathSync(resolve(keyArg)) })));
  } catch { console.error('CLAWBOT_BACKUP_COPY_FAILED'); process.exitCode = 1; }
}
