import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';

// The test supervisor stays alive in the same container while only the parent
// of the publisher is killed. Thus Docker container cleanup cannot mask a
// missing PR_SET_PDEATHSIG implementation.
writeFileSync('/tmp/parent.mjs', `import {spawn} from 'node:child_process';
spawn('/usr/bin/python3', ['/opt/clawbot-guard/exec-with-parent.py', String(process.pid), process.execPath,
  '/opt/clawbot-guard/test-publisher.mjs'], {stdio:'ignore'});`);
const parent = spawn(process.execPath, ['/tmp/parent.mjs'], { stdio: 'ignore' });
async function alive() {
  try { return (await fetch('http://127.0.0.1:18991', { signal: AbortSignal.timeout(500) })).ok; }
  catch { return false; }
}
async function waitFor(expected) {
  const until = Date.now() + 5000;
  while (Date.now() < until) { if (await alive() === expected) return; await delay(100); }
  throw new Error('Parent-death containment failed');
}
try {
  await waitFor(true);
  const exited = once(parent, 'exit'); parent.kill('SIGKILL'); await exited;
  await waitFor(false);
  assert.ok(process.pid > 0);
  console.log('CLAWBOT_KERNEL_PARENT_DEATH_CONTAINMENT_OK');
} finally { parent.kill('SIGKILL'); }
