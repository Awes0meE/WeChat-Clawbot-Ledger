import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireOperationLock } from './operation-lock.mjs';
acquireOperationLock('bootstrap');

const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const env = { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}` };
function run(args, input) {
  const result = spawnSync(docker, args, { cwd: root, env, input, encoding: 'utf8', timeout: 90_000 });
  if (result.status !== 0) throw new Error(`CLAWBOT_TEST_BOOTSTRAP_STEP_FAILED:${args[0]}`);
  return result.stdout;
}
const compose = ['compose', '-f', 'deploy/docker/compose.test.yml'];
const id = run([...compose, 'ps', '-q', 'origin']).trim();
if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Expected one test origin');
const inspected = JSON.parse(run(['inspect', id]))[0];
if (inspected.Config.Labels['com.docker.compose.project'] !== 'clawbot-test'
  || inspected.Config.Labels['com.docker.compose.service'] !== 'origin'
  || inspected.Config.Image !== 'mayswind/ezbookkeeping@sha256:1043c95201f0432cd30328f6feb9a5b57359449400ea54fdf9a0c6138ab4c227'
  || Object.keys(inspected.HostConfig.PortBindings ?? {}).length) throw new Error('Test origin identity mismatch');
const tokenStatus = run([...compose, '--profile', 'setup', 'run', '--rm', '-T', 'init', 'token-status']).trim();
if (tokenStatus === 'READY') {
  console.log('CLAWBOT_TEST_TOKENS_ALREADY_PRESENT_NO_NEW_SESSIONS');
  process.exit(0);
}
if (tokenStatus !== 'EMPTY') throw new Error('Incomplete test credentials require manual recovery; no sessions created');
// Password expansion happens only inside the test container; no secret appears
// in a host argument, output, configuration template, or repository file.
const create = 'if [ ! -f /var/lib/clawbot-test/ledger/.test-user-created ]; then /ezbookkeeping/ezbookkeeping --conf-path /var/lib/clawbot-test/config/ezbookkeeping.ini --no-boot-log userdata user-add --username clawbot-test --email clawbot-test@example.invalid --nickname clawbot-test --default-currency SGD --password "$(cat /var/lib/clawbot-test/bootstrap/password)" && touch /var/lib/clawbot-test/ledger/.test-user-created; fi';
run(['exec', id, '/bin/sh', '-c', create]);
const tokens = {};
for (const type of ['api', 'mcp']) {
  const output = run(['exec', id, '/ezbookkeeping/ezbookkeeping', '--conf-path', '/var/lib/clawbot-test/config/ezbookkeeping.ini', '--no-boot-log', 'userdata', 'user-session-new', '--username', 'clawbot-test', '--type', type, '--expiresInSeconds', '604800']);
  const matches = output.match(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g);
  if (matches?.length !== 1) throw new Error('CLAWBOT_TEST_TOKEN_RESPONSE_INVALID');
  tokens[type] = matches[0];
}
run([...compose, '--profile', 'setup', 'run', '--rm', '-T', 'init', 'tokens'], JSON.stringify(tokens));
console.log('CLAWBOT_TEST_ACCOUNT_AND_SEPARATE_TOKENS_READY');
