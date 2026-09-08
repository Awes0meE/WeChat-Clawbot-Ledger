import assert from 'node:assert/strict';
export const AUTH_STAGE_ROOT = '/var/lib/clawbot-auth';
export function authorizationStageConfig() {
  return { plugins: { allow: ['openai', 'codex'], entries: { openai: { enabled: true }, codex: { enabled: true } } },
    agents: { defaults: { model: { primary: 'openai/gpt-5.6-sol', fallbacks: [] } }, entries: {
      bookkeeper: { workspace: `${AUTH_STAGE_ROOT}/workspace`, model: { primary: 'openai/gpt-5.6-sol', fallbacks: [] },
        models: { 'openai/gpt-5.6-sol': { agentRuntime: { id: 'codex' } } },
        thinkingDefault: 'low', tools: { profile: 'full', deny: ['*'] }, skills: [] },
    } }, channels: {} };
}
export function validateAuthorizationStage(stage) {
  assert.equal(stage?.version, 1);
  assert.match(stage.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(stage.volume, `clawbot-auth-stage-${stage.id}`);
  assert.match(stage.runtimeImage, /^sha256:[a-f0-9]{64}$/);
  assert.match(stage.hostSourceCommit, /^[a-f0-9]{40}$/);
  assert.ok(['isolated-test', 'production'].includes(stage.targetProfile));
  assert.ok(Number.isFinite(Date.parse(stage.createdAt)));
  return stage;
}
export function authorizationStageArgs(stage, { interactive = false } = {}) {
  validateAuthorizationStage(stage);
  return ['run', '--rm', ...(interactive ? ['-it'] : []), '--log-driver', 'none', '--network', 'bridge',
    '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777',
    '--mount', `type=volume,src=${stage.volume},dst=${AUTH_STAGE_ROOT}`,
    '--env', `HOME=${AUTH_STAGE_ROOT}/openclaw`, '--env', `CODEX_HOME=${AUTH_STAGE_ROOT}/codex`,
    '--env', `OPENCLAW_STATE_DIR=${AUTH_STAGE_ROOT}/openclaw`,
    '--env', `OPENCLAW_CONFIG_PATH=${AUTH_STAGE_ROOT}/openclaw/openclaw.json`,
    '--env', 'CLAWBOT_DEPLOYMENT_PROFILE=authorization-stage',
    '--entrypoint', 'node', stage.runtimeImage, '/app/openclaw.mjs'];
}
