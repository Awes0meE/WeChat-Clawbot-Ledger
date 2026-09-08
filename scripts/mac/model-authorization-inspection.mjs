import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { summarizeModelAuthorization } from './model-authorization.mjs';
const exec = promisify(execFile);
async function docker(args, timeout = 30000) {
  try {
    return (await exec('/Applications/Docker.app/Contents/Resources/bin/docker', args,
      { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  } catch { throw new Error('CLAWBOT_AUTH_INSPECT_UNAVAILABLE'); }
}
// The caller validates the complete managed container identity. Recheck it
// after the read so a replaced or restarted runtime cannot inherit the result.
export async function inspectModelAuthorization({ inspect, profile, sourceCommit, run = docker }) {
  assert.ok(['isolated-test', 'production'].includes(profile));
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  const id = await inspect(); assert.match(id, /^[a-f0-9]{64}$/);
  const startedAt = async () => JSON.parse(await run(['inspect', '--format', '{{json .State.StartedAt}}', id]));
  const before = await startedAt();
  assert.ok(Number.isFinite(Date.parse(before)));
  const runtimeImage = JSON.parse(await run(['inspect', '--format', '{{json .Image}}', id]));
  assert.match(runtimeImage, /^sha256:[a-f0-9]{64}$/);
  const upstream = '/app/dist/list.status-command-BciSAaZC.js';
  const digest = await run(['exec', id, 'node', '-e', 'const fs=require("node:fs"),c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))', upstream]);
  assert.equal(digest, '5a37cd8f591c608e1e352b32dfb9e3ffc84aefbb0829f811adcc7dee4e20bbec');
  // Pinned read-only status. --probe overrides the official harness upstream.
  const raw = JSON.parse(await run(['exec', id, 'node', '/app/openclaw.mjs', 'models', 'status', '--agent', 'bookkeeper', '--json'], 90000));
  assert.equal(await inspect(), id); assert.equal(await startedAt(), before);
  return { ...summarizeModelAuthorization(raw), profile, hostSourceCommit: sourceCommit, runtimeImage,
    containerId: id, containerStartedAt: before, observedAt: new Date().toISOString() };
}
