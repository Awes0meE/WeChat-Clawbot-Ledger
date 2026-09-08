import { readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateActivation } from '../guard/tunnel-policy.mjs';
import { assertProductionConfig } from './production-policy.mjs';

export function verifyProductionActivation() {
  const read = (path, max) => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max || (stat.mode & 0o222)) throw new Error('CLAWBOT_ACTIVATION_FILE_INVALID');
    return readFileSync(path);
  };
  if (process.env.CLAWBOT_DEPLOYMENT_PROFILE !== 'production'
    || process.env.OPENCLAW_STATE_DIR !== '/var/lib/clawbot/openclaw'
    || process.env.OPENCLAW_CONFIG_PATH !== '/run/clawbot-runtime/openclaw.json') throw new Error('CLAWBOT_PRODUCTION_ENV_INVALID');
  const policy = JSON.parse(read('/run/clawbot-guard/policy.json', 16384));
  if (JSON.parse(read('/etc/clawbot-release.json', 4096)).sourceCommit !== policy.sourceCommit) throw new Error('CLAWBOT_PRODUCTION_SOURCE_MISMATCH');
  validateActivation(JSON.parse(read('/run/clawbot-guard/activation.json', 4096)), policy);
  const configText = read('/run/clawbot-runtime/openclaw.json', 65536);
  if (createHash('sha256').update(configText).digest('hex') !== policy.openclawConfigSha256) throw new Error('CLAWBOT_PRODUCTION_CONFIG_HASH');
  const config = JSON.parse(configText);
  assertProductionConfig(config, ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md']
    .map((name) => readFileSync(`/opt/clawbot/workspace/${name}`, 'utf8').length));
  return config;
}
