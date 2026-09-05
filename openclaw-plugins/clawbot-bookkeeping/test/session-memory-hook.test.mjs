import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  createSessionMemoryGuard,
  loadVerifiedUpstreamHandler,
} from '../../../openclaw-hooks/session-memory/guard.mjs';

const verificationError = 'CLAWBOT_SESSION_MEMORY_UPSTREAM_VERIFICATION_FAILED';
const hookDirectory = fileURLToPath(new URL('../../../openclaw-hooks/session-memory/', import.meta.url));

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fakeUpstream(t) {
  const directory = mkdtempSync(join(tmpdir(), 'clawbot-session-memory-test-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('clawbot-session-memory-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const packageRoot = join(directory, 'npm', 'node_modules', 'openclaw');
  const hookRoot = join(packageRoot, 'dist', 'bundled', 'session-memory');
  mkdirSync(hookRoot, { recursive: true });
  const packagePath = join(packageRoot, 'package.json');
  const handlerPath = join(hookRoot, 'handler.js');
  const descriptorPath = join(hookRoot, 'HOOK.md');
  const executionMarker = join(hookRoot, 'upstream-executed');
  writeFileSync(packagePath, JSON.stringify({ name: 'openclaw', version: '2026.8.2', type: 'module' }));
  writeFileSync(handlerPath, [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(new URL('./upstream-executed', import.meta.url), 'synthetic');",
    'export default function upstream(event) { return event.result; }',
  ].join('\n'));
  writeFileSync(descriptorPath, '---\nname: session-memory\n---\nSynthetic test hook only.\n');
  return {
    directory, packagePath, handlerPath, descriptorPath, executionMarker,
    options: {
      packageRoot,
      expectedVersion: '2026.8.2',
      handlerSha256: sha256(handlerPath),
      descriptorSha256: sha256(descriptorPath),
    },
  };
}

for (const [type, action] of [['command', 'new'], ['command', 'reset'], ['session', 'auto-reset']]) {
  test(`skips bookkeeper session memory for ${type}:${action}`, () => {
    const guarded = createSessionMemoryGuard(() => assert.fail('bookkeeper must not reach upstream'));
    assert.equal(guarded({ type, action, context: { agentId: 'bookkeeper' } }), undefined);
  });
}

for (const agentId of ['main', 'another-agent', 'Bookkeeper', undefined]) {
  test(`preserves the original event and synchronous return for ${agentId ?? 'missing agent id'}`, () => {
    const event = { context: { agentId } };
    const result = { result: 'unchanged' };
    let calls = 0;
    const guarded = createSessionMemoryGuard((received) => {
      assert.equal(received, event);
      calls += 1;
      return result;
    });
    assert.equal(guarded(event), result);
    assert.equal(calls, 1);
  });
}

test('preserves a delegated Promise without wrapping it', async () => {
  const result = Promise.resolve('unchanged');
  const guarded = createSessionMemoryGuard(() => result);
  assert.equal(guarded({ context: { agentId: 'main' } }), result);
  await result;
});

test('preserves a delegated synchronous exception', () => {
  const failure = new Error('synthetic delegate failure');
  const guarded = createSessionMemoryGuard(() => { throw failure; });
  assert.throws(() => guarded({ context: { agentId: 'main' } }), (error) => error === failure);
});

test('loads a verified temporary upstream module and preserves its export', async (t) => {
  const fixture = fakeUpstream(t);
  const upstream = await loadVerifiedUpstreamHandler(fixture.options);
  const result = { synthetic: true };
  assert.equal(existsSync(fixture.executionMarker), true);
  assert.equal(upstream({ result }), result);
});

for (const drift of ['version', 'handler', 'descriptor']) {
  test(`rejects upstream ${drift} drift before executing its module`, async (t) => {
    const fixture = fakeUpstream(t);
    if (drift === 'version') {
      writeFileSync(fixture.packagePath, JSON.stringify({ name: 'openclaw', version: '2026.8.3', type: 'module' }));
    } else {
      const changedPath = drift === 'handler' ? fixture.handlerPath : fixture.descriptorPath;
      writeFileSync(changedPath, `${readFileSync(changedPath, 'utf8')}\n// changed\n`);
    }
    await assert.rejects(loadVerifiedUpstreamHandler(fixture.options), (error) => {
      assert.equal(error.message, verificationError);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(existsSync(fixture.executionMarker), false);
  });
}

test('production entry rejects a fake APPDATA installation without executing upstream', {
  skip: process.platform !== 'win32',
}, (t) => {
  const fixture = fakeUpstream(t);
  const script = [
    'try {',
    '  await import(process.argv[1]);',
    "  process.stdout.write('UNEXPECTED_IMPORT_SUCCESS');",
    '  process.exitCode = 1;',
    '} catch (error) { process.stdout.write(error.message); }',
  ].join('\n');
  const output = execFileSync(process.execPath, [
    '--input-type=module', '--eval', script,
    pathToFileURL(join(hookDirectory, 'handler.js')).href,
  ], {
    env: { ...process.env, APPDATA: fixture.directory },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(output, verificationError);
  assert.equal(existsSync(fixture.executionMarker), false);
});
