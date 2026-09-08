import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { verifyTestHost } from './verify-test-host.mjs';
import { readManagedHostRelease } from './managed-host-release.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { inspectWeixinAuthorization } from './weixin-authorization-inspection.mjs';
try {
  assert.equal(process.argv.length, 3); const test = process.argv[2] === '--test';
  let inspect, sourceCommit;
  if (test) {
    const base = join(homedir(), 'Library/Application Support/Clawbot');
    sourceCommit = JSON.parse(readFileSync(join(base, 'operations/host-status.json'))).sourceCommit;
    assert.match(sourceCommit, /^[a-f0-9]{40}$/);
    const release = JSON.parse(readFileSync(join(base, 'host-releases', sourceCommit, 'release-runtime.json')));
    inspect = async () => verifyTestHost({ runtimeImage: release.runtimeImage }).openclaw;
  } else {
    const directory = resolve(process.argv[2]), { spec } = readManagedHostRelease(directory);
    sourceCommit = spec.sourceCommit;
    const driver = managedDockerDriver(spec, join(directory, 'compose.json'));
    inspect = async () => {
      const view = await driver.inspect();
      assert.ok(view.identityValid && view.namespaceValid && view.running.openclaw);
      return view.trusted.openclaw;
    };
  }
  const report = await inspectWeixinAuthorization({ inspect, sourceCommit, profile: test ? 'isolated-test' : 'production' });
  console.log(JSON.stringify(report));
  if (!['not-enabled', 'last-poll-accepted'].includes(report.state)) process.exitCode = 2;
} catch {
  console.log(JSON.stringify({ version: 1, state: 'inspection-unavailable', remoteVerified: false, messageAcceptanceVerified: false, restartRecommended: false }));
  process.exitCode = 1;
}
