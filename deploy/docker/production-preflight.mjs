import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyProductionActivation } from './production-activation.mjs';
import { validateGuardPolicy, validateOriginConfig } from '../guard/origin-identity.mjs';
import { readTunnelActivation } from '../guard/tunnel-policy.mjs';
import { verifyImportReceipts } from './import-receipts.mjs';
import { assertLedgerRotationComplete } from './ledger-token-rotation.mjs';
try {
  assertLedgerRotationComplete('/proof/secrets');
  verifyImportReceipts('/proof', { project: 'clawbot-production', cutoverId: process.argv[2],
    sourceSnapshotSha256: process.argv[3], importManifestSha256: process.argv[5] });
  verifyProductionActivation();
  const policy = validateGuardPolicy(JSON.parse(readFileSync('/run/clawbot-guard/policy.json')));
  const activation = JSON.parse(readFileSync('/run/clawbot-guard/activation.json'));
  if (activation.cutoverId !== process.argv[2] || policy.sourceSnapshotSha256 !== process.argv[3]
    || policy.sourceCommit !== process.argv[4]) throw new Error('Deployment receipt mismatch');
  const ini = readFileSync(policy.configPath);
  if (createHash('sha256').update(ini).digest('hex') !== policy.configSha256) throw new Error('Origin config changed');
  validateOriginConfig(ini.toString('utf8'), policy); readTunnelActivation(policy);
  console.log('CLAWBOT_PRODUCTION_INPUTS_OK');
} catch { console.error('CLAWBOT_PRODUCTION_INPUTS_REFUSED'); process.exit(1); }
