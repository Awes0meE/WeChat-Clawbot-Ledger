import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validateGuardPolicy, validateOriginConfig, listeningSockets, parseIni } from '../../../deploy/guard/origin-identity.mjs';
const source = readFileSync(new URL('../../../deploy/docker/ezbookkeeping.test.ini', import.meta.url), 'utf8');
const policy = { version: 1, profile: 'isolated-test', root: '/var/lib/clawbot-test', port: 18888,
  configPath: '/var/lib/clawbot-test/config/ezbookkeeping.ini', dbPath: '/var/lib/clawbot-test/ledger/data/ezbookkeeping-test.db', configSha256: 'a'.repeat(64) };
test('origin policy rejects expanded network permissions and alternate storage', () => {
  assert.doesNotThrow(() => validateGuardPolicy(policy));
  assert.doesNotThrow(() => validateOriginConfig(source, policy));
  for (const [from, to] of [['http_addr = 127.0.0.1', 'http_addr = 0.0.0.0'], ['mcp_allowed_remote_ips = 127.0.0.1', 'mcp_allowed_remote_ips = *'],
    ['enable_register = false', 'enable_register = true'], ['ezbookkeeping-test.db', 'other.db'], ['trusted_proxy_ips = 127.0.0.1/32', 'trusted_proxy_ips = 0.0.0.0/0']]) {
    assert.throws(() => validateOriginConfig(source.replace(from, to), policy));
  }
  assert.throws(() => validateGuardPolicy({ ...policy, port: 8888 }));
  assert.throws(() => parseIni('[server]\nhttp_port=18888\nhttp_port=8888'));
});
test('listener parsing requires one IPv4 loopback socket and rejects wildcard or duplicate listeners', () => {
  const header = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
  const row = '0: 0100007F:49C8 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1';
  assert.equal(listeningSockets(`${header}\n${row}`, header, 18888), '12345');
  assert.throws(() => listeningSockets(`${header}\n${row.replace('0100007F', '00000000')}`, header, 18888));
  assert.throws(() => listeningSockets(`${header}\n${row}\n${row}`, header, 18888));
  assert.throws(() => listeningSockets(header, header, 18888));
});
