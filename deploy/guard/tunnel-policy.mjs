import { readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
export const TUNNEL_CONFIG_PATH = '/run/clawbot-tunnel/config.json';
export const TUNNEL_CREDENTIAL_PATH = '/run/clawbot-tunnel/credentials.json';
export function canonicalTunnelConfig(tunnelId) {
  if (!UUID.test(tunnelId ?? '')) throw new Error('tunnel-identity');
  return { tunnel: tunnelId, 'credentials-file': TUNNEL_CREDENTIAL_PATH, 'no-autoupdate': true,
    'grace-period': '0s', metrics: '127.0.0.1:20241', ingress: [
      { hostname: 'ledger.66ccff-labs.com', service: 'http://127.0.0.1:8888' }, { service: 'http_status:404' },
    ] };
}
export function validateActivation(activation, policy) {
  // This receipt is issued by the operator after verified Windows quiescence;
  // it is not independent proof of the remote machine's ongoing state.
  if (policy.profile !== 'production' || !HASH.test(policy.sourceSnapshotSha256 ?? '')
    || !/^[a-f0-9]{40}$/.test(policy.sourceCommit ?? '')
    || activation?.version !== 1 || activation.project !== 'clawbot-production'
    || !UUID.test(activation.cutoverId ?? '') || activation.windowsReceiverStopped !== true
    || activation.windowsTunnelStopped !== true || activation.windowsLedgerStopped !== true
    || activation.sourceSnapshotSha256 !== policy.sourceSnapshotSha256
    || activation.sourceCommit !== policy.sourceCommit) throw new Error('cutover-activation');
}
export function validateTunnelFiles(policy, configText, credentialText, activation) {
  validateActivation(activation, policy);
  const expected = canonicalTunnelConfig(policy.tunnelId);
  if (!HASH.test(policy.tunnelConfigSha256 ?? '') || createHash('sha256').update(configText).digest('hex') !== policy.tunnelConfigSha256) throw new Error('tunnel-config-hash');
  const config = JSON.parse(configText);
  // Exact structure also forbids wildcard routes, private routing, additional
  // hostnames and environment/command substitutions in operator input.
  if (JSON.stringify(config) !== JSON.stringify(expected)) throw new Error('tunnel-ingress');
  const credential = JSON.parse(credentialText);
  if (credential.TunnelID !== policy.tunnelId || !/^[a-f0-9]{32}$/.test(credential.AccountTag ?? '')
    || typeof credential.TunnelSecret !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(credential.TunnelSecret)
    || Buffer.from(credential.TunnelSecret, 'base64').length !== 32) throw new Error('tunnel-credential');
  return expected;
}
export function readTunnelActivation(policy) {
  function read(path, max, secret = false) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max || (stat.mode & 0o222)
      || (secret && (stat.mode & 0o077))) throw new Error('tunnel-file-policy');
    return readFileSync(path, 'utf8');
  }
  return validateTunnelFiles(policy, read(TUNNEL_CONFIG_PATH, 16384), read(TUNNEL_CREDENTIAL_PATH, 4096, true),
    JSON.parse(read('/run/clawbot-guard/activation.json', 4096)));
}
