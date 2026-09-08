import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { rotateLedgerTokens, rotationMarker } from './ledger-token-rotation.mjs';

const sourceRoot = '/tmp/clawbot-ledger-token-input';
let owned = false;
try {
  // This helper is only launched by the offline host operation. Sensitive
  // inputs use stdin, never Docker arguments, environment, logs or stdout.
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) { input += chunk; assert.ok(input.length <= 40000); }
  const request = JSON.parse(input);
  assert.deepEqual(Object.keys(request).sort(), ['action', 'expectedBinding', 'expectedUsername', 'http', 'mcp']);
  assert.ok(['inspect', 'apply', 'resume'].includes(request.action));
  for (const role of ['http', 'mcp']) assert.ok(typeof request[role] === 'string' && request[role].length <= 16384);
  mkdirSync(sourceRoot, { mode: 0o700 }); owned = true;
  for (const role of ['http', 'mcp']) writeFileSync(`${sourceRoot}/${role}-token`, request[role], { flag: 'wx', mode: 0o600 });
  const options = { action: request.action, expectedBinding: request.expectedBinding,
    expectedUsername: request.expectedUsername, sourceRoot, ledgerRoot: '/rotation/ledger',
    databaseRelativePath: 'data/ezbookkeeping.db', secretsRoot: '/rotation/secrets' };
  let markerPresent = true;
  try { lstatSync(`/rotation/secrets/${rotationMarker}`); } catch (e) { if (e.code !== 'ENOENT') throw e; markerPresent = false; }
  let report;
  if (request.action === 'resume' && !markerPresent) {
    // The host already checked its durable started record + original review.
    // Recover both sides of the gap between host receipt and volume marker:
    // no write started yet, or the pair was saved before the host receipt.
    try { report = await rotateLedgerTokens({ ...options, action: 'verify-saved' }); }
    catch {
      const inspection = await rotateLedgerTokens({ ...options, action: 'inspect' });
      assert.equal(inspection.binding, request.expectedBinding);
      report = await rotateLedgerTokens({ ...options, action: 'apply' });
    }
  } else report = await rotateLedgerTokens(options);
  console.log(JSON.stringify(report));
} catch { console.error('CLAWBOT_LEDGER_TOKEN_IMPORT_FAILED_MAINTENANCE_REQUIRED'); process.exitCode = 1; }
finally { if (owned) rmSync(sourceRoot, { recursive: true, force: true }); }
