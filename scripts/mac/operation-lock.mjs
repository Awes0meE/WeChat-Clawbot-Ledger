import { mkdirSync, lstatSync, realpathSync, writeFileSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const operationsRoot = join(homedir(), 'Library', 'Application Support', 'Clawbot', 'operations');
export async function waitForOperationLock(name, options) {
  const deadline = Date.now() + 10000;
  while (true) {
    try { return acquireOperationLock(name, options); }
    catch (error) {
      if (error.message !== 'CLAWBOT_OPERATION_BUSY' || Date.now() >= deadline) throw error;
      await delay(250);
    }
  }
}
export function acquireOperationLock(name, { directory = operationsRoot } = {}) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('CLAWBOT_OPERATION_NAME_INVALID');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o077) || realpathSync(directory) !== directory) throw new Error('CLAWBOT_OPERATION_DIRECTORY_INVALID');
  const path = join(directory, 'clawbot-test.lock');
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('CLAWBOT_OPERATION_BUSY');
    throw error;
  }
  const owner = JSON.stringify({ version: 1, pid: process.pid, nonce: randomUUID(), name, startedAt: new Date().toISOString() });
  const file = join(path, 'owner.json');
  writeFileSync(file, owner, { flag: 'wx', mode: 0o600 });
  let released = false;
  function release() {
    if (released) return;
    if (lstatSync(path).isSymbolicLink() || lstatSync(file).isSymbolicLink()
      || readFileSync(file, 'utf8') !== owner) throw new Error('CLAWBOT_OPERATION_OWNER_CHANGED');
    unlinkSync(file); rmdirSync(path); released = true;
    process.removeListener('exit', onExit);
  }
  // Never steal a stale lock: an interrupted Docker helper may still be alive.
  const onExit = () => { try { release(); } catch {} };
  process.once('exit', onExit);
  return release;
}
