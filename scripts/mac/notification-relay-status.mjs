// Optional read-only observation; never loads relay credentials or sends notifications.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { request } from 'node:http';

export function validateNotificationConfig(value, now = Date.now()) {
  if (!value || Object.keys(value).some(key => !['healthUrl', 'phoneVerifiedAt'].includes(key))) throw Error('config');
  const url = new URL(value.healthUrl), parts = url.hostname.split('.').map(Number);
  const local = /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && parts.every(n => n >= 0 && n <= 255)
    && (parts[0] === 127 || parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168));
  if (url.protocol !== 'http:' || !local || url.username || url.password || url.search || url.hash
    || url.pathname !== '/healthz' || !url.port || [8888, 18888, 18789, 18990].includes(Number(url.port))) throw Error('endpoint');
  const verified = value.phoneVerifiedAt;
  if (verified != null && (typeof verified !== 'string' || !Number.isFinite(Date.parse(verified)) || Date.parse(verified) > now)) throw Error('date');
  return { healthUrl: url.href, phoneVerifiedAt: verified ? new Date(verified).toISOString() : null };
}
function readConfig() {
  const path = join(homedir(), 'Library/Application Support/Clawbot/notification-relay.json');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096
      || stat.uid !== process.getuid() || (stat.mode & 0o077) || realpathSync(path) !== path) throw Error('permissions');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function probeNotificationRelay(url) {
  return new Promise((resolve, reject) => {
    let bytes = 0; const chunks = [];
    const req = request(url, { method: 'GET', headers: { Accept: 'application/json' }, agent: false }, response => {
      if (response.statusCode !== 200) { response.resume(); req.destroy(Error('status')); return; }
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) req.destroy(Error('size')); else chunks.push(chunk); });
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (body.service !== 'codex-bark-relay' || body.status !== 'ready') throw Error('protocol');
          resolve();
        } catch { reject(Error('protocol')); }
      });
      response.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(Error('timeout')), 1500);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end();
  });
}
export function notificationRelayMonitor({ loadConfig = readConfig, probe = probeNotificationRelay, now = Date.now } = {}) {
  let current = { state: 'checking', checkedAt: null, phoneVerifiedAt: null }, pending = false;
  return {
    async refresh() {
      if (pending) return; pending = true;
      let phoneVerifiedAt = null;
      try {
        const raw = loadConfig();
        if (!raw) { current = { state: 'not-configured', checkedAt: new Date(now()).toISOString(), phoneVerifiedAt: null }; return; }
        const config = validateNotificationConfig(raw, now()); phoneVerifiedAt = config.phoneVerifiedAt;
        await probe(config.healthUrl);
        current = { state: 'online', checkedAt: new Date(now()).toISOString(), phoneVerifiedAt };
      } catch { current = { state: 'unavailable', checkedAt: new Date(now()).toISOString(), phoneVerifiedAt }; }
      finally { pending = false; }
    },
    snapshot() {
      const age = now() - Date.parse(current.checkedAt);
      return !Number.isFinite(age) || age < 0 || age >= 15000 ? { state: 'unknown', checkedAt: null, phoneVerifiedAt: null } : { ...current };
    },
  };
}
