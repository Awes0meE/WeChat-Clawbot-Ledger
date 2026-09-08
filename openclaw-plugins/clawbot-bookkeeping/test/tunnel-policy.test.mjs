import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalTunnelConfig, validateTunnelFiles } from '../../../deploy/guard/tunnel-policy.mjs';
const id = '11111111-2222-3333-4444-555555555555';
const credential = JSON.stringify({ TunnelID: id, AccountTag: 'a'.repeat(32), TunnelSecret: Buffer.alloc(32, 1).toString('base64') });
function fixture(config = canonicalTunnelConfig(id)) {
  const text = JSON.stringify(config);
  const policy = { profile: 'production', tunnelId: id, sourceCommit: 'a'.repeat(40), sourceSnapshotSha256: 'b'.repeat(64),
    tunnelConfigSha256: createHash('sha256').update(text).digest('hex') };
  const activation = { version: 1, project: 'clawbot-production', cutoverId: id, windowsReceiverStopped: true,
    windowsTunnelStopped: true, windowsLedgerStopped: true, sourceCommit: policy.sourceCommit, sourceSnapshotSha256: policy.sourceSnapshotSha256 };
  return { text, policy, activation };
}
test('Tunnel activation requires a consistent stopped-Windows receipt and exact ledger ingress', () => {
  const f = fixture();
  assert.doesNotThrow(() => validateTunnelFiles(f.policy, f.text, credential, f.activation));
  for (const field of ['windowsReceiverStopped', 'windowsTunnelStopped', 'windowsLedgerStopped']) {
    assert.throws(() => validateTunnelFiles(f.policy, f.text, credential, { ...f.activation, [field]: false }));
  }
  assert.throws(() => validateTunnelFiles(f.policy, f.text, credential, { ...f.activation, sourceSnapshotSha256: 'c'.repeat(64) }));
  for (const config of [
    { ...canonicalTunnelConfig(id), 'warp-routing': { enabled: true } },
    { ...canonicalTunnelConfig(id), ingress: [{ hostname: '*.66ccff-labs.com', service: 'http://127.0.0.1:8888' }, { service: 'http_status:404' }] },
    { ...canonicalTunnelConfig(id), metrics: '0.0.0.0:20241' },
  ]) { const invalid = fixture(config); assert.throws(() => validateTunnelFiles(invalid.policy, invalid.text, credential, invalid.activation)); }
});
