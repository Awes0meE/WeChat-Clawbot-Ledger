import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { assertLedgerRotationComplete } from './ledger-token-rotation.mjs';
import { probeLedgerAuthorization } from './ledger-authorization.mjs';
try {
  assertLedgerRotationComplete('/verification-secrets');
  const report = await probeLedgerAuthorization({ origin:'http://127.0.0.1:18888', readToken(role) {
    const path = `/verification-secrets/${role}-token`, stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid()
      || (stat.mode & 0o077) || stat.size > 16384 || realpathSync(path) !== path) throw Error('credential unavailable');
    return readFileSync(path,'utf8');
  } });
  console.log(JSON.stringify(report));
} catch { console.error('CLAWBOT_LEDGER_SAVED_TOKEN_PROBE_UNAVAILABLE'); process.exitCode = 1; }
