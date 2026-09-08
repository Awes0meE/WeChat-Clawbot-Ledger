import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { readManagedHostRelease } from './managed-host-release.mjs';
import { managedDockerDriver } from './managed-docker-driver.mjs';
import { waitForOperationLock, operationsRoot } from './operation-lock.mjs';
if (!process.argv[2]) throw new Error('Usage: provision-production.mjs <immutable-host-directory>');
const directory = resolve(process.argv[2]), base = join(homedir(), 'Library', 'Application Support', 'Clawbot', 'production-host-releases');
assert.ok(directory.startsWith(base + '/') && realpathSync(directory) === directory);
const { spec } = readManagedHostRelease(directory), unlock = await waitForOperationLock('production-provision');
try {
  assert.ok(!existsSync(join(operationsRoot, 'production-enabled.json')), 'Initial provisioning requires a disabled host');
  assert.ok(!existsSync(join(operationsRoot, 'production-storage-fault.json')), 'Storage fault requires reconciliation');
  await managedDockerDriver(spec, join(directory, 'compose.json')).createStopped();
  console.log('CLAWBOT_PRODUCTION_CONTAINERS_PREPARED_NOT_STARTED');
} finally { unlock(); }
