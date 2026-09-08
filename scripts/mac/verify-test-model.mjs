import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireOperationLock } from './operation-lock.mjs';
acquireOperationLock('model-verification');

const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const child = spawn(docker, ['compose', '-f', 'deploy/docker/compose.test.yml', 'exec', '-T', 'openclaw',
  'node', '/app/openclaw.mjs', 'agent', '--agent', 'bookkeeper', '--thinking', 'low',
  '--session-key', 'agent:bookkeeper:p1-model-probe', '--timeout', '120', '--json',
  '--message', '这是隔离环境的模型连通性测试，不是消费请求。不要调用工具，不要记账。请只回复：P1_MODEL_OK'], {
  cwd: fileURLToPath(new URL('../../', import.meta.url)),
  env: { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '', errors = '';
child.stdout.on('data', (b) => { output += b; });
child.stderr.on('data', (b) => { errors += b; });
const timeout = setTimeout(() => child.kill('SIGTERM'), 150_000);
child.on('error', () => { clearTimeout(timeout); console.error('CLAWBOT_MODEL_PROBE_PROCESS_FAILED'); process.exitCode = 1; });
child.on('close', (code) => {
  clearTimeout(timeout);
  // Only explicit synthetic result and whitelisted model metadata leave this
  // process. Never print auth profiles, provider errors, session IDs or logs.
  let result;
  for (let at = output.indexOf('{'); at >= 0; at = output.indexOf('{', at + 1)) {
    try { result = JSON.parse(output.slice(at)); break; } catch {}
  }
  if (code !== 0 || !result) {
    const diagnostic = (errors + '\n' + (result?.error?.message ? `Error: ${result.error.message}` : output)).split('\n').filter((line) => /error|failed|denied|readonly|read-only|ENOENT|EACCES|EROFS/i.test(line)).slice(-6).map((line) => line
      .replace(/https?:\/\/\S+/g, '[URL]')
      .replace(/[\w.+-]+@[\w.-]+/g, '[ADDRESS]')
      .replace(/[A-Za-z0-9_\-.+/=]{20,}/g, '[REDACTED]')).join('\n');
    console.error(JSON.stringify({ status: 'CLAWBOT_MODEL_PROBE_FAILED', exitCode: code,
      authenticationError: /unauthorized|not authenticated|auth.*missing|no.*auth|401/i.test(errors + output),
      timeout: /timeout|timed out/i.test(errors + output), diagnostic }));
    process.exitCode = 1; return;
  }
  const text = (result.payloads ?? result.result?.payloads ?? []).map((p) => p.text ?? '').join('\n');
  const meta = result.meta ?? result.result?.meta ?? {};
  const agent = meta.agentMeta ?? {};
  const passed = text.trim() === 'P1_MODEL_OK' && agent.model === 'gpt-5.6-sol' && agent.agentHarnessId === 'codex';
  console.log(JSON.stringify({ status: passed ? 'CLAWBOT_MODEL_PROBE_OK' : 'CLAWBOT_MODEL_RESPONSE_UNEXPECTED',
    exactSyntheticReply: text.trim() === 'P1_MODEL_OK', provider: agent.provider, model: agent.model,
    harness: agent.agentHarnessId, durationMs: meta.durationMs, aborted: meta.aborted === true,
    tools: meta.systemPromptReport?.tools?.entries?.map((entry) => entry.name),
    toolReportKeys: Object.keys(meta.systemPromptReport?.tools ?? {}) }));
  if (!passed) process.exitCode = 1;
});
