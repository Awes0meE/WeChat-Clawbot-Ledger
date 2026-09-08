import { readFileSync, lstatSync, writeFileSync, renameSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { validateGuardPolicy, verifyOrigin } from './origin-identity.mjs';
import { readTunnelActivation, TUNNEL_CONFIG_PATH } from './tunnel-policy.mjs';
import { observeTunnelChild } from './tunnel-diagnostics.mjs';

const policyPath = '/run/clawbot-guard/policy.json';
const stat = lstatSync(policyPath);
if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o222)) throw new Error('Guard policy must be a read-only file');
const policy = validateGuardPolicy(JSON.parse(readFileSync(policyPath)));
const test = process.argv[2] === '--test-publisher';
if ((test && policy.profile !== 'isolated-test') || (!test && (process.argv[2] !== '--tunnel' || policy.profile !== 'production'))) throw new Error('Guard mode mismatch');
if (!test && JSON.parse(readFileSync('/etc/clawbot-release.json')).sourceCommit !== policy.sourceCommit) throw new Error('Guard source identity mismatch');
let child, stop = false, stable = 0, lastState, restartAfter = 0;
let tunnelDiagnostics;
const report = (state) => {
  const tunnel=!test?{...(tunnelDiagnostics?.()??{authorization:'not-checked',authorizationObservedAt:null,
    diagnostic:'not-started',diagnosticObservedAt:null}),publisherRunning:!!child}:undefined;
  writeFileSync('/tmp/clawbot-guard-status.json.tmp', JSON.stringify({ version:1,state, updatedAt: Date.now(),...(tunnel?{tunnel}:{}) }), { mode: 0o600 });
  renameSync('/tmp/clawbot-guard-status.json.tmp', '/tmp/clawbot-guard-status.json');
  const summary=JSON.stringify({state,...(tunnel?{authorization:tunnel.authorization,diagnostic:tunnel.diagnostic}:{})});
  if (lastState !== summary) { console.log(summary); lastState = summary; }
};
function closeChild() {
  // Fail closed immediately. A draining Tunnel could otherwise keep publishing
  // a failed origin. Only this guardian's exact child handle is signalled.
  child?.kill('SIGKILL'); child = undefined;
}
function startChild() {
  let executable, args;
  if (test) { executable = process.execPath; args = ['/opt/clawbot-guard/test-publisher.mjs']; }
  else {
    executable = '/usr/local/bin/cloudflared';
    const actual = createHash('sha256').update(readFileSync(executable)).digest('hex');
    if (actual !== '4bcfd35521a7cbc545ebfd5d57334a71ee180e2a64874981f374c81472118391') throw new Error('tunnel-binary');
    readTunnelActivation(policy);
    const checked = spawnSync(executable, ['tunnel', '--config', TUNNEL_CONFIG_PATH, 'ingress', 'validate'],
      { timeout: 5000, stdio: 'ignore', env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' } });
    if (checked.status !== 0) throw new Error('tunnel-config-validation');
    args = ['tunnel', '--config', TUNNEL_CONFIG_PATH, '--no-autoupdate', '--grace-period', '0s', '--loglevel', 'info', '--output', 'json', 'run', policy.tunnelId];
  }
  const launched = spawn('/usr/bin/python3', ['/opt/clawbot-guard/exec-with-parent.py', String(process.pid), executable, ...args], {
    stdio: ['ignore', 'ignore', test?'ignore':'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TZ: 'Asia/Singapore' },
  });
  child = launched;
  if(!test)tunnelDiagnostics=observeTunnelChild(launched,()=>child===launched);
  launched.on('error', () => { if (child === launched) { child = undefined; stable = 0; restartAfter = Date.now() + 30000; report('publisher-failed'); } });
  launched.on('exit', () => { if (child === launched) { child = undefined; stable = 0; restartAfter = Date.now() + 30000; report('publisher-exited'); } });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop = true; closeChild(); });
try {
  while (!stop) {
    try {
      await verifyOrigin(policy);
      if (!test) readTunnelActivation(policy);
      if (stop) break;
      stable++;
      if (stable >= 2 && !child && Date.now() >= restartAfter) startChild();
      let connected = false;
      if (child && !test) {
        try { connected = (await fetch('http://127.0.0.1:20241/ready', { signal: AbortSignal.timeout(1000), redirect: 'error' })).ok; } catch { /* Retry without changing the origin boundary. */ }
      }
      report(child ? test ? 'publishing-test' : connected ? 'tunnel-ready' : 'tunnel-connecting' : 'verifying');
    } catch { stable = 0; closeChild(); report('blocked'); }
    await delay(1000);
  }
} finally { closeChild(); }
