import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { productionStatusAdapter } from './production-status-adapter.mjs';
try {
  assert.equal(process.argv.length, 3);
  const directory = resolve(process.argv[2]);
  assert.ok(directory.startsWith(join(homedir(), 'Library/Application Support/Clawbot/production-host-releases') + '/'));
  const result = await productionStatusAdapter(directory).collect();
  console.log(JSON.stringify(result));
  if (!['healthy', 'disabled', 'maintenance'].includes(result.state)) process.exitCode = 2;
} catch {
  console.log(JSON.stringify({ version: 1, profile: 'production', state: 'inspection-unavailable', boundaryHealthy: false,
    businessWrites: false, remoteAcceptanceVerified: false }));
  process.exitCode = 1;
}
