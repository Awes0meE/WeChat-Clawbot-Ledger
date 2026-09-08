import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizationStageArgs, authorizationStageConfig, validateAuthorizationStage } from '../../../scripts/mac/authorization-stage.mjs';
const stage = () => ({ version: 1, id: '12345678-1234-4123-8123-123456789abc',
  volume: 'clawbot-auth-stage-12345678-1234-4123-8123-123456789abc', runtimeImage: 'sha256:' + 'a'.repeat(64),
  hostSourceCommit: 'b'.repeat(40), targetProfile: 'production', createdAt: '2026-09-08T00:00:00Z' });
test('login mounts only a new authorization volume and has no service or host attachment', () => {
  const args = authorizationStageArgs(stage(), { interactive: true });
  assert.equal(args.filter(a => a === '--mount').length, 1);
  assert.ok(args.includes('-it'));
  assert.equal(args[args.indexOf('--log-driver') + 1], 'none');
  assert.equal(args[args.indexOf('--network') + 1], 'bridge');
  assert.doesNotMatch(args.join(' '), /clawbot-production_|clawbot-test_|docker\.sock|--privileged|--publish|network.*container:/);
  assert.equal(args[args.indexOf('--entrypoint') + 1], 'node');
  assert.ok(args.includes('CLAWBOT_DEPLOYMENT_PROFILE=authorization-stage'));
});
test('scratch config cannot receive messages or invoke bookkeeping tools', () => {
  const config = authorizationStageConfig();
  assert.deepEqual(config.channels, {});
  assert.deepEqual(config.plugins.allow, ['openai', 'codex']);
  assert.deepEqual(config.agents.entries.bookkeeper.tools.deny, ['*']);
  assert.equal(config.agents.entries.bookkeeper.models['openai/gpt-5.6-sol'].agentRuntime.id, 'codex');
  assert.deepEqual(config.agents.entries.bookkeeper.model.fallbacks, []);
});
test('staging identity rejects a reused production volume, tag, path, or mixed marker', () => {
  for (const bad of [{ volume: 'clawbot-production_openclaw-state' }, { runtimeImage: 'clawbot:latest' },
    { id: '../stolen' }, { targetProfile: 'unknown' }, { createdAt: 'invalid' }]) {
    assert.throws(() => validateAuthorizationStage({ ...stage(), ...bad }));
  }
});
