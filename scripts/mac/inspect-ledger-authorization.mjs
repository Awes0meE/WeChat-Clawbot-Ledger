import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { verifyTestHost } from './verify-test-host.mjs';
import { readManagedHostRelease } from './managed-host-release.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { inspectLedgerAuthorization } from './ledger-authorization-inspection.mjs';
try {
  assert.equal(process.argv.length, 3); const test = process.argv[2] === '--test';
  let inspect, sourceCommit;
  if (test) {
    const base = join(homedir(), 'Library/Application Support/Clawbot');
    sourceCommit = JSON.parse(readFileSync(join(base, 'operations/host-status.json'))).sourceCommit;
    assert.match(sourceCommit, /^[a-f0-9]{40}$/);
    const release = JSON.parse(readFileSync(join(base, 'host-releases', sourceCommit, 'release-runtime.json')));
    inspect = async () => verifyTestHost({ runtimeImage: release.runtimeImage });
  } else {
    const directory = resolve(process.argv[2]), { spec } = readManagedHostRelease(directory);
    sourceCommit = spec.sourceCommit;
    const driver = managedDockerDriver(spec, join(directory, 'compose.json'));
    inspect = async () => {
      const view = await driver.inspect();
      assert.ok(view.identityValid && view.namespaceValid && view.running.openclaw && view.running.origin);
      return { openclaw: view.trusted.openclaw, origin: view.trusted.origin };
    };
  }
  const report = await inspectLedgerAuthorization({ inspect, sourceCommit, profile: test ? 'isolated-test' : 'production' });
  console.log(JSON.stringify(report));
  if ([report.http, report.mcp].some(r => r.state !== 'accepted-read-only' || r.sessionCleanup)) process.exitCode = 2;
} catch {
  console.log(JSON.stringify({ version: 1, state: 'inspection-unavailable', businessWrites: false, restartRecommended: false }));
  process.exitCode = 1;
}
