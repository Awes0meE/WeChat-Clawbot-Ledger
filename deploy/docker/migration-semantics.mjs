import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { assertProductionConfig } from './production-policy.mjs';
import { validateGuardPolicy, validateOriginConfig, parseIni } from '../guard/origin-identity.mjs';
import { validateTunnelFiles } from '../guard/tunnel-policy.mjs';
import { migrationPath } from './migration-format.mjs';

// The directory contract is deliberately canonical. A legacy Windows layout
// must be mapped and audited on Windows, not silently guessed during import.
export function verifyMigrationSemantics(root, manifest) {
  const text = (path) => readFileSync(join(root, migrationPath(path)), 'utf8');
  const json = (path) => JSON.parse(text(path));
  const config = json('runtime-config/openclaw.json'); assertProductionConfig(config);
  const policy = validateGuardPolicy(json('guard-config/policy.json'));
  if (policy.profile !== 'production' || policy.sourceCommit !== manifest.target.sourceCommit
    || policy.sourceSnapshotSha256 !== manifest.source.snapshotSha256) throw new Error('CLAWBOT_MIGRATION_RELEASE_BINDING');
  const ini = text('ledger-config/ezbookkeeping.ini'); validateOriginConfig(ini, policy);
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  if (hash(ini) !== policy.configSha256 || hash(text('runtime-config/openclaw.json')) !== policy.openclawConfigSha256
    || hash(parseIni(ini).get('security.secret_key') ?? '') !== manifest.source.ledgerSecretKeySha256) throw new Error('CLAWBOT_MIGRATION_CONFIG_BINDING');
  const activation = json('guard-config/activation.json');
  if (activation.cutoverId !== manifest.target.cutoverId) throw new Error('CLAWBOT_MIGRATION_CUTOVER_BINDING');
  validateTunnelFiles(policy, text('tunnel-config/config.json'), text('tunnel-config/credentials.json'), activation);
  const api = text('secrets/http-token').trim(), mcp = text('secrets/mcp-token').trim();
  if (!api || !mcp || api === mcp || /[\r\n]/.test(api + mcp)) throw new Error('CLAWBOT_MIGRATION_TOKEN_PAIR');
  const account = config.bindings[0].match.accountId;
  if (!/^[A-Za-z0-9@._-]+$/.test(account) || account.includes('..')) throw new Error('CLAWBOT_MIGRATION_ACCOUNT_LAYOUT');
  const index = json('openclaw-state/openclaw-weixin/accounts.json');
  if (!Array.isArray(index) || index.length !== 1 || index[0] !== account) throw new Error('CLAWBOT_MIGRATION_ACCOUNT_INDEX');
  const prefix = `openclaw-state/openclaw-weixin/accounts/${account}`;
  if (typeof json(`${prefix}.json`).token !== 'string' || !json(`${prefix}.json`).token.trim()
    || typeof json(`${prefix}.sync.json`).get_updates_buf !== 'string') throw new Error('CLAWBOT_MIGRATION_CHANNEL_STATE');
  const pairing = json(`openclaw-state/credentials/openclaw-weixin-${account.toLowerCase()}-allowFrom.json`);
  const owner = config.commands.ownerAllowFrom[0].slice('openclaw-weixin:'.length);
  if (!Array.isArray(pairing.allowFrom) || pairing.allowFrom.length !== 1 || pairing.allowFrom[0] !== owner) throw new Error('CLAWBOT_MIGRATION_PAIRING');
  const db = new DatabaseSync(join(root, 'receipts/message-receipts.sqlite'), { readOnly: true });
  try {
    const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
    for (const required of ['message_receipts', 'processed_expense_confirmations', 'ended_trusted_runs', 'receipt_store_migrations']) {
      if (!names.has(required)) throw new Error('CLAWBOT_MIGRATION_RECEIPT_SCHEMA');
    }
  } finally { db.close(); }
}
