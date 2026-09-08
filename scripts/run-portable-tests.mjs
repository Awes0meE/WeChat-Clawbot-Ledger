import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// These files execute Windows PowerShell/ACL/task/process APIs. Keep npm test
// unchanged for the complete Windows suite and report this subset separately.
const windows = new Set([
  'background-task-policy.test.mjs', 'ledger-crud-script.test.mjs',
  'ledger-environment-migration.test.mjs', 'ledger-listener-exit.test.mjs',
  'ledger-public-scripts.test.mjs', 'ledger-restart-arguments.test.mjs',
  'ledger-restart-child.test.mjs', 'ledger-runtime-scripts.test.mjs',
  'ledger-tunnel-scripts.test.mjs', 'openclaw-release-scripts.test.mjs',
  'runtime-scripts.test.mjs',
]);
const root = fileURLToPath(new URL('../openclaw-plugins/clawbot-bookkeeping/', import.meta.url));
const files = readdirSync(`${root}/test`).filter((x) => x.endsWith('.test.mjs') && !windows.has(x)).sort();
console.log(`Portable subset: ${files.length} files; ${windows.size} Windows operation files excluded explicitly.`);
const result = spawnSync(process.execPath, ['--test', ...files.map((x) => `test/${x}`)], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
