import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, openSync, closeSync, fsyncSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export function archiveReviewedStorageFault({ faultPath, archivePath, faultBytes, reviewBytes }) {
  const parent = dirname(faultPath), directory = lstatSync(parent);
  assert.equal(dirname(archivePath), parent); assert.equal(realpathSync(parent), parent);
  assert.ok(directory.isDirectory() && directory.uid === process.getuid() && !(directory.mode & 0o077));
  const originalMatches = () => {
    const stat = lstatSync(faultPath);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && !(stat.mode & 0o077));
    assert.deepEqual(readFileSync(faultPath), faultBytes, 'Fault changed before archival');
  };
  originalMatches();
  const record = { status: 'reviewed-for-clear', fault: JSON.parse(faultBytes), review: JSON.parse(reviewBytes),
    preparedAt: new Date().toISOString(), reviewSha256: createHash('sha256').update(reviewBytes).digest('hex') };
  const fd = openSync(archivePath, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
  // Persist the archive and its directory entry before removing the latch.
  // A failed sync or changed original leaves the fault present for inspection.
  const dir = openSync(parent, 'r');
  try { fsyncSync(dir); originalMatches(); unlinkSync(faultPath); fsyncSync(dir); }
  finally { closeSync(dir); }
}
