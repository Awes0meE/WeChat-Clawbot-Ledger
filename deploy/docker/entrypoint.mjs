import { readFileSync, existsSync, readdirSync, mkdirSync, lstatSync, readlinkSync, unlinkSync, copyFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveDeploymentProfile } from '/opt/clawbot/plugins/clawbot-bookkeeping/deployment-profile.mjs';
import { assertBookkeeperRuntimePolicy } from './runtime-policy.mjs';
import { verifyProductionActivation } from './production-activation.mjs';
import { assertLedgerRotationComplete } from './ledger-token-rotation.mjs';

const production = process.env.CLAWBOT_DEPLOYMENT_PROFILE === 'production';
const state = production ? '/var/lib/clawbot/openclaw' : '/var/lib/clawbot-test/openclaw';
const secrets = production ? '/var/lib/clawbot/secrets' : '/var/lib/clawbot-test/secrets';
assertLedgerRotationComplete(secrets);
const config = production ? verifyProductionActivation() : JSON.parse(readFileSync(`${state}/openclaw.json`));
resolveDeploymentProfile(config.plugins.entries['clawbot-bookkeeping'].config, config);
assertBookkeeperRuntimePolicy(config, ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md']
  .map((name) => readFileSync(`/opt/clawbot/workspace/${name}`, 'utf8').length));
const accounts = `${state}/openclaw-weixin/accounts`;
if (!production && existsSync(accounts) && readdirSync(accounts).length) throw new Error('Test receiver state must be empty');
mkdirSync(`${state}/hooks`, { recursive: true });
const hook = `${state}/hooks/session-memory`;
if (existsSync(hook) && lstatSync(hook).isSymbolicLink()) {
  if (readlinkSync(hook) !== '/opt/clawbot/hooks/session-memory') throw new Error('Unknown managed hook symlink');
  unlinkSync(hook);
}
mkdirSync(hook, { recursive: true });
for (const file of ['handler.js', 'guard.mjs', 'HOOK.md']) {
  const source = `/opt/clawbot/hooks/session-memory/${file}`, target = `${hook}/${file}`;
  if (!existsSync(target)) { copyFileSync(source, target); chmodSync(target, 0o444); }
  const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  if (lstatSync(target).isSymbolicLink() || hash(target) !== hash(source)) throw new Error('Managed hook integrity mismatch');
}
await import('/opt/clawbot/hooks/session-memory/handler.js');
const child = spawn(process.execPath, ['/app/openclaw.mjs', ...process.argv.slice(2)], { stdio: 'inherit' });
if (production) setInterval(() => {
  try { verifyProductionActivation(); assertLedgerRotationComplete(secrets); }
  catch { child.kill('SIGKILL'); }
}, 1000).unref();
child.on('error', () => { console.error('CLAWBOT_TEST_GATEWAY_START_FAILED'); process.exit(1); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
