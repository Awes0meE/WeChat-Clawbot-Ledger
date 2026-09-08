import { readFileSync, readlinkSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const ORIGIN_SHA256 = '48c13a3fb056fcb275cab4a1b484065d5af87c500cf4a2b1f50c7f8b7e70fc1f';
export function parseIni(source) {
  const values = new Map(); let section = '';
  for (const original of source.split(/\r?\n/)) {
    const line = original.trim();
    if (!line || /^[;#]/.test(line)) continue;
    const heading = /^\[([a-z0-9_]+)\]$/.exec(line);
    if (heading) { section = heading[1]; continue; }
    const setting = /^([a-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!section || !setting) throw new Error('config-syntax');
    const name = `${section}.${setting[1]}`;
    if (values.has(name)) throw new Error('config-duplicate');
    values.set(name, setting[2].trim());
  }
  return values;
}
export function validateOriginConfig(source, policy) {
  const values = parseIni(source);
  const required = {
    'global.mode': 'production', 'server.protocol': 'http', 'server.http_addr': '127.0.0.1',
    'server.http_port': String(policy.port), 'database.type': 'sqlite3', 'database.db_path': policy.dbPath,
    'storage.type': 'local_filesystem', 'storage.local_filesystem_path': `${policy.root}/ledger/storage`,
    'user.enable_register': 'false', 'auth.enable_forget_password': 'false',
    'security.enable_api_token': 'true', 'security.api_token_allowed_remote_ips': '127.0.0.1',
    'security.trusted_proxy_ips': '127.0.0.1/32', 'mcp.enable_mcp': 'true', 'mcp.mcp_allowed_remote_ips': '127.0.0.1',
  };
  for (const [name, value] of Object.entries(required)) if (values.get(name) !== value) throw new Error('config-policy');
}
export function validateGuardPolicy(policy) {
  const test = policy?.profile === 'isolated-test';
  const root = test ? '/var/lib/clawbot-test' : '/var/lib/clawbot';
  const port = test ? 18888 : 8888;
  if (!['isolated-test', 'production'].includes(policy?.profile) || policy.version !== 1
    || policy.root !== root || policy.port !== port
    || policy.configPath !== `${root}/config/ezbookkeeping.ini`
    || policy.dbPath !== `${root}/ledger/data/${test ? 'ezbookkeeping-test' : 'ezbookkeeping'}.db`
    || !/^[a-f0-9]{64}$/.test(policy.configSha256 ?? '')) throw new Error('guard-policy');
  return policy;
}
export function listeningSockets(tcp, tcp6, port) {
  const wanted = port.toString(16).toUpperCase().padStart(4, '0');
  const rows = [...tcp.trim().split('\n').slice(1), ...tcp6.trim().split('\n').slice(1)]
    .map((line) => line.trim().split(/\s+/)).filter((columns) => columns[3] === '0A' && columns[1]?.endsWith(`:${wanted}`));
  if (rows.length !== 1 || rows[0][1] !== `0100007F:${wanted}`) throw new Error('listener-address');
  return rows[0][9];
}
export async function verifyOrigin(policy) {
  validateGuardPolicy(policy);
  // PID 1 is the immutable ezBookkeeping process in this shared PID namespace.
  if (readlinkSync('/proc/1/exe') !== '/ezbookkeeping/ezbookkeeping') throw new Error('origin-executable');
  const hash = (data) => createHash('sha256').update(data).digest('hex');
  if (hash(readFileSync('/proc/1/exe')) !== ORIGIN_SHA256) throw new Error('origin-binary');
  const command = readFileSync('/proc/1/cmdline', 'utf8').split('\0').filter(Boolean);
  const expected = ['/ezbookkeeping/ezbookkeeping', '--conf-path', policy.configPath, '--no-boot-log', 'server', 'run'];
  if (JSON.stringify(command) !== JSON.stringify(expected)) throw new Error('origin-command');
  if (readFileSync('/proc/1/environ', 'utf8').split('\0').some((line) => /^(EBK_|EBKCFP_)/.test(line))) throw new Error('origin-env-override');
  const config = readFileSync(`/proc/1/root${policy.configPath}`);
  if (hash(config) !== policy.configSha256) throw new Error('origin-config-hash');
  validateOriginConfig(config.toString('utf8'), policy);
  const inode = listeningSockets(readFileSync('/proc/net/tcp', 'utf8'), readFileSync('/proc/net/tcp6', 'utf8'), policy.port);
  const owned = readdirSync('/proc/1/fd').some((fd) => {
    try { return readlinkSync(`/proc/1/fd/${fd}`) === `socket:[${inode}]`; } catch { return false; }
  });
  if (!owned) throw new Error('listener-owner');
  const address = `http://127.0.0.1:${policy.port}`;
  async function bounded(path, max) {
    const response = await fetch(address + path, { redirect: 'error', signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error('origin-http');
    let bytes = 0, parts = [];
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > max) throw new Error('origin-http-size'); parts.push(chunk);
    }
    return Buffer.concat(parts).toString('utf8');
  }
  const health = JSON.parse(await bounded('/healthz.json', 4096));
  if (health.success !== true) throw new Error('origin-health');
  if (!/ezBookkeeping/i.test(await bounded('/', 262144))) throw new Error('origin-page');
  return true;
}
