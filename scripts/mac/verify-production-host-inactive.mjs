import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { HOST_FILES } from './managed-host-release.mjs';
import { managedRuntimeSpec, managedCompose } from './managed-runtime-spec.mjs';
import { operationsRoot } from './operation-lock.mjs';

const releasePath = process.argv[2];
if (!releasePath) throw new Error('Supply the inactive production release.json path');
const release = JSON.parse(readFileSync(releasePath));
assert.equal(release.project, 'clawbot-production');
assert.ok(!existsSync(join(operationsRoot, 'production-enabled.json')), 'Production enable gate exists');
assert.notEqual(spawnSync('/bin/launchctl', ['list', 'com.clawbot.mac-production-host'], { encoding: 'utf8' }).status, 0, 'Production host is installed');
assert.ok(!existsSync(join(homedir(), 'Library', 'LaunchAgents', 'com.clawbot.mac-production-host.plist')), 'Production task file exists');
function projectContainers() {
  const result = spawnSync('/Applications/Docker.app/Contents/Resources/bin/docker', ['ps', '-a', '-q', '--filter', 'label=com.docker.compose.project=clawbot-production'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0); return result.stdout.trim();
}
assert.equal(projectContainers(), '', 'Production containers exist; refusing fixture');
const fixtureBase = join(homedir(), 'Library', 'Application Support', 'Clawbot', 'production-host-releases');
mkdirSync(fixtureBase, { recursive: true, mode: 0o700 });
const directory = realpathSync(mkdtempSync(join(fixtureBase, 'inactive-fixture-')));
let reviewPath;
try {
  const target = { profile: 'production', project: 'clawbot-production', runtimeImage: release.images.runtime,
    guardImage: release.images.guard, sourceCommit: release.sourceCommit,
    cutoverId: randomUUID(), sourceSnapshotSha256: 'a'.repeat(64), importManifestSha256: 'd'.repeat(64) }, files = {};
  for (const name of [...HOST_FILES, 'compose.json']) {
    const data = name === 'compose.json' ? Buffer.from(JSON.stringify(managedCompose(managedRuntimeSpec(target)))) : readFileSync(new URL(name, import.meta.url));
    writeFileSync(join(directory, name), data, { mode: 0o400 }); files[name] = createHash('sha256').update(data).digest('hex');
  }
  writeFileSync(join(directory, 'host-release.json'), JSON.stringify({ version: 1, target, files }), { mode: 0o400 });
  const result = spawnSync(process.execPath, [join(directory, 'production-host.mjs'), '--once'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, 'Inactive host entry failed');
  const state = JSON.parse(readFileSync(join(operationsRoot, 'production-host-status.json')));
  assert.equal(state.state, 'disabled'); assert.equal(projectContainers(), '');
  console.log('CLAWBOT_PRODUCTION_HOST_INACTIVE_GATE_VERIFIED');
  const inspected = spawnSync(process.execPath, ['scripts/mac/inspect-production-status.mjs', directory], { encoding: 'utf8', timeout: 30000 });
  assert.equal(inspected.status, 0);
  const overview = JSON.parse(inspected.stdout);
  assert.equal(overview.state, 'disabled'); assert.equal(overview.boundaryHealthy, false);
  assert.equal(overview.businessWrites, false); assert.equal(overview.remoteAcceptanceVerified, false);
  assert.equal(overview.modelAuthorization.state, 'inspection-unavailable');
  assert.equal(overview.ledgerAuthorization.state, 'inspection-unavailable');
  assert.equal(projectContainers(), '');
  console.log('CLAWBOT_DISABLED_PRODUCTION_OVERVIEW_VERIFIED_WITHOUT_ACTIVATION');
  const prepared = spawnSync(process.execPath, ['scripts/mac/activate-production.mjs', 'prepare', directory], { encoding: 'utf8', timeout: 30000 });
  assert.equal(prepared.status, 0); reviewPath = join(operationsRoot, `activation-review-${target.cutoverId}.json`);
  assert.equal(JSON.parse(prepared.stdout).path, reviewPath);
  const review = JSON.parse(readFileSync(reviewPath)); assert.ok(Object.values(review.checks).every((v) => v === false));
  review.reviewedAt = new Date().toISOString(); writeFileSync(reviewPath, JSON.stringify(review));
  const refused = spawnSync(process.execPath, ['scripts/mac/activate-production.mjs', 'enable', directory, reviewPath], { encoding: 'utf8', timeout: 30000 });
  assert.notEqual(refused.status, 0); assert.ok(!existsSync(join(operationsRoot, 'production-enabled.json')));
  assert.equal(projectContainers(), '');
  assert.ok(!existsSync(join(homedir(), 'Library', 'LaunchAgents', 'com.clawbot.mac-production-host.plist')));
  console.log('CLAWBOT_UNCONFIRMED_ACTIVATION_REVIEW_REFUSED_WITHOUT_SIDE_EFFECTS');
} finally { if (reviewPath) unlinkSync(reviewPath); rmSync(directory, { recursive: true, force: true }); }
