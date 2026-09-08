import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATION_ROLES } from './migration-format.mjs';

export function generationReceipt(spec) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (!(spec.project === 'clawbot-production' || /^clawbot-import-check-[a-f0-9]{12}$/.test(spec.project ?? '')) || !uuid.test(spec.volumeGeneration ?? '')
    || !/^[a-f0-9]{64}$/.test(spec.recoverySourceManifestSha256 ?? '') || !/^[a-f0-9]{40}$/.test(spec.sourceCommit ?? '')
    || !uuid.test(spec.cutoverId ?? '') || !/^[a-f0-9]{64}$/.test(spec.importManifestSha256 ?? '')) throw Error('CLAWBOT_GENERATION_RECEIPT_SPEC');
  return { version: 1, project: spec.project, volumeGeneration: spec.volumeGeneration, sourceCommit: spec.sourceCommit,
    cutoverId: spec.cutoverId, importManifestSha256: spec.importManifestSha256, recoverySourceManifestSha256: spec.recoverySourceManifestSha256 };
}
export function verifyGenerationReceipts(root, spec) {
  const expected = JSON.stringify(generationReceipt(spec));
  for (const role of MIGRATION_ROLES) {
    const directory = lstatSync(join(root, role));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('CLAWBOT_GENERATION_RECEIPT_DIRECTORY');
    const path = join(root, role, 'recovery-generation.json'), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o222) || stat.size > 4096
      || readFileSync(path, 'utf8') !== expected) throw Error('CLAWBOT_GENERATION_RECEIPT_MISMATCH');
  }
  return true;
}
