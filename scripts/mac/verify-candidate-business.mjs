import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, lstatSync, realpathSync, existsSync, rmdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateAuthorizationStage } from './authorization-stage.mjs';
import { operationsRoot } from './operation-lock.mjs';
import { verifyImageSourceFiles } from './production-image-inventory.mjs';

// Same candidate code, explicitly isolated manifest, fresh seven-volume data,
// and the already authorized OpenAI profile copied only into disposable state.
// No production profile, real WeChat identity, live test volume or source mount.
const root = fileURLToPath(new URL('../../', import.meta.url));
const docker = '/Applications/Docker.app/Contents/Resources/bin/docker', exec = promisify(execFile);
const env = { ...process.env, PATH: `/Applications/Docker.app/Contents/Resources/bin:${process.env.PATH}` };
const id = randomUUID(), project = `clawbot-candidate-${id.slice(0, 8)}`;
let directory, release, companion, folder, stageLock, step = 'preflight', failure, cleaned = false, baseline, diagnostic, ownsProject = false;
const volumes = [], passed = [];
async function run(args, { input, timeout = 90000 } = {}) {
  if (input === undefined) {
    try { return (await exec(docker, args, { cwd: root, env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 })).stdout.trim(); }
    catch (error) {
      const text = String(error.stderr ?? '');
      diagnostic = /ERR_MODULE_NOT_FOUND/.test(text) ? 'module-missing' : /ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/.test(text) ? 'typescript-loader'
        : /EACCES|EROFS/.test(text) ? 'permissions' : /unauthorized|401|credentials.*expired/i.test(text) ? 'authentication'
          : error.killed ? 'timeout' : 'command';
      throw Error('CLAWBOT_CANDIDATE_COMMAND_FAILED');
    }
  }
  return await new Promise((yes, no) => {
    const child = spawn(docker, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', size = 0, overflow = false;
    const timer = setTimeout(() => { child.kill('SIGTERM'); no(Error('CLAWBOT_CANDIDATE_COMMAND_TIMEOUT')); }, timeout);
    child.stdout.on('data', b => { size += b.length; if (size < 8 * 1024 * 1024) out += b; else { overflow = true; child.kill('SIGTERM'); } });
    child.stderr.on('data', b => { size += b.length; if (size >= 8 * 1024 * 1024) { overflow = true; child.kill('SIGTERM'); } });
    child.on('error', () => { clearTimeout(timer); no(Error('CLAWBOT_CANDIDATE_COMMAND_FAILED')); });
    child.on('close', code => { clearTimeout(timer); code === 0 && !overflow ? yes(out.trim()) : no(Error('CLAWBOT_CANDIDATE_COMMAND_FAILED')); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
function privateFile(path, limit = 1048576) {
  const s = lstatSync(path);
  assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === process.getuid()
    && !(s.mode & 0o077) && s.size < limit && realpathSync(path) === path);
  return readFileSync(path);
}
async function liveTestBinding() {
  const lines = await run(['inspect', '--format', '{"id":{{json .Id}},"image":{{json .Image}},"start":{{json .State.StartedAt}},"running":{{json .State.Running}},"health":{{json .State.Health.Status}}}',
    'clawbot-test-origin-1', 'clawbot-test-openclaw-1']);
  const rows = lines.split('\n').map(JSON.parse);
  assert.ok(rows.length === 2 && rows.every(r => r.running && r.health === 'healthy')); return rows;
}
try {
  assert.equal(process.argv.length, 4);
  directory = resolve(process.argv[2]);
  assert.ok(directory.startsWith(join(homedir(), 'Library/Application Support/Clawbot/production-releases') + '/') && realpathSync(directory) === directory);
  release = JSON.parse(privateFile(join(directory, 'release.json')));
  companion = JSON.parse(privateFile(join(directory, 'test-image.json')));
  assert.equal(release.project, 'clawbot-production'); assert.equal(release.activated, false);
  assert.equal(companion.version, 1); assert.equal(companion.purpose, 'candidate-validation'); assert.equal(companion.profile, 'isolated-test');
  assert.equal(companion.sourceCommit, release.sourceCommit); assert.equal(companion.productionRuntimeImage, release.images.runtime);
  const image = JSON.parse(await run(['image', 'inspect', companion.image]))[0];
  assert.equal(image.Architecture, 'arm64'); assert.equal(image.Id, companion.image);
  assert.equal(image.Config.Labels['org.opencontainers.image.revision'], release.sourceCommit);
  assert.equal(image.Config.Labels['clawbot.purpose'], 'candidate-validation');
  verifyImageSourceFiles(companion.image, release.files, 'runtime');
  assert.ok(!existsSync(join(operationsRoot, 'production-enabled.json')));
  baseline = await liveTestBinding();
  const receipt = resolve(process.argv[3]);
  assert.equal(join(operationsRoot, 'authorization-stages', receipt.split('/').at(-1)), receipt);
  const stage = validateAuthorizationStage(JSON.parse(privateFile(receipt, 4096)));
  assert.equal(receipt, join(operationsRoot, 'authorization-stages', `${stage.id}.json`));
  const lock = receipt + '.lock'; mkdirSync(lock, { mode: 0o700 }); stageLock = lock;
  const authVolume = JSON.parse(await run(['volume', 'inspect', stage.volume]))[0];
  assert.equal(authVolume.Name, stage.volume); assert.equal(authVolume.Driver, 'local');
  assert.ok(!Object.keys(authVolume.Options ?? {}).length && authVolume.Labels?.['clawbot.purpose'] === 'authorization-stage'
    && authVolume.Labels['clawbot.stage'] === stage.id && !authVolume.Labels['clawbot.project'] && !authVolume.Labels['clawbot.cutover']);
  assert.equal(await run(['ps', '-q', '--filter', `volume=${stage.volume}`]), '');
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-candidate-business-')));
  assert.equal(createHash('sha256').update(readFileSync(join(root, 'deploy/docker/compose.test.yml'))).digest('hex'), release.files['deploy/docker/compose.test.yml']);
  const compose = JSON.parse(await run(['compose', '-f', 'deploy/docker/compose.test.yml', '--profile', 'setup', '--profile', 'tools', 'config', '--format', 'json']));
  compose.name = project;
  assert.equal(await run(['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '');
  assert.equal(await run(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '');
  assert.equal(await run(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '');
  for (const [name, definition] of Object.entries(compose.volumes)) {
    definition.name = `${project}_${name}`;
    assert.equal(await run(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${definition.name}$`]), '');
    volumes.push(definition.name);
  }
  for (const [name, definition] of Object.entries(compose.networks ?? {})) definition.name = `${project}_${name}`;
  for (const [name, service] of Object.entries(compose.services)) {
    if (name !== 'origin') service.image = companion.image;
    delete service.build; service.logging = { driver: 'none' };
    assert.ok(!service.ports?.length);
  }
  const path = join(folder, 'compose.json'); writeFileSync(path, JSON.stringify(compose), { flag: 'wx', mode: 0o400 });
  const dc = ['compose', '-f', path];
  const js = code => ['--entrypoint', 'node', companion.image, '--input-type=module', '-e', code];
  const common = ['run', '--rm', '--log-driver', 'none', '--label', `com.docker.compose.project=${project}`,
    '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777'];
  const mounted = (roles, writable = []) => roles.flatMap(([role, target]) => ['--mount',
    `type=volume,src=${project}_${role},dst=${target}${writable.includes(role) ? '' : ',readonly'}`]);
  step = 'initialize';
  ownsProject = true;
  assert.match(await run([...dc, '--profile', 'setup', 'run', '--rm', '-T', 'init']), /CLAWBOT_TEST_VOLUMES_INITIALIZED/);
  step = 'ledger-start';
  await run([...dc, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '60', 'origin']);
  const origin = (await run([...dc, 'ps', '-q', 'origin'])).trim(); assert.match(origin, /^[a-f0-9]{64}$/);
  step = 'fixture-account';
  await run(['exec', origin, '/bin/sh', '-c', '/ezbookkeeping/ezbookkeeping --conf-path /var/lib/clawbot-test/config/ezbookkeeping.ini --no-boot-log userdata user-add --username clawbot-test --email clawbot-test@example.invalid --nickname clawbot-test --default-currency SGD --password "$(cat /var/lib/clawbot-test/bootstrap/password)"']);
  const tokens = {};
  for (const type of ['api', 'mcp']) {
    const output = await run(['exec', origin, '/ezbookkeeping/ezbookkeeping', '--conf-path', '/var/lib/clawbot-test/config/ezbookkeeping.ini',
      '--no-boot-log', 'userdata', 'user-session-new', '--username', 'clawbot-test', '--type', type, '--expiresInSeconds', '3600']);
    const found = output.match(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g); assert.equal(found?.length, 1); tokens[type] = found[0];
  }
  assert.match(await run([...dc, '--profile', 'setup', 'run', '--rm', '-T', 'init', 'tokens'], { input: JSON.stringify(tokens) }), /CLAWBOT_TEST_TOKENS_READY/);
  step = 'copy-authorized-profile';
  const copied = await run([...common, '--mount', `type=volume,src=${stage.volume},dst=/authorization-source,readonly`,
    ...mounted([['openclaw-state', '/var/lib/clawbot-test/openclaw']], ['openclaw-state']),
    '--env', 'OPENCLAW_STATE_DIR=/tmp/candidate-writer', '--env', 'HOME=/tmp/candidate-writer',
    ...js(`import assert from 'node:assert/strict';import fs from 'node:fs';import{createHash}from'node:crypto';
const marker=JSON.parse(fs.readFileSync('/authorization-source/initialized.json'));
assert.equal(marker.version,1);assert.equal(marker.id,${JSON.stringify(stage.id)});
const source='/authorization-source/openclaw/agents/bookkeeper/agent',copy='/tmp/source/agents/bookkeeper/agent',target='/var/lib/clawbot-test/openclaw/agents/bookkeeper/agent';
fs.mkdirSync(copy,{recursive:true,mode:0o700});fs.mkdirSync(target,{recursive:true,mode:0o700});
assert.ok(!fs.existsSync(target+'/openclaw-agent.sqlite'));let total=0;const hashes=[];
try{assert.equal(fs.lstatSync(source+'/openclaw-agent.sqlite-journal').size,0);}catch(e){if(e.code!=='ENOENT')throw e;}
for(const suffix of ['','-wal','-shm']){const name='openclaw-agent.sqlite'+suffix,p=source+'/'+name;let s;try{s=fs.lstatSync(p);}catch(e){if(suffix&&e.code==='ENOENT')continue;throw e;}
assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1);total+=s.size;assert.ok(total<=64*2**20);const hash=createHash('sha256').update(fs.readFileSync(p)).digest('hex');fs.copyFileSync(p,copy+'/'+name);hashes.push([name,hash]);}
const auth=await import('/app/dist/sqlite-tM5d-2v5.js');const stored=auth.o(copy);assert.equal(stored.status,'readable');
const entries=Object.entries(stored.raw.profiles??{});assert.equal(entries.length,1);const[profileId,credential]=entries[0];
assert.ok(credential.provider==='openai'&&credential.type==='oauth'&&credential.accountId&&credential.expires>Date.now());
const{u:save}=await import('/app/dist/profiles-DV3Jcdeb.js');await save({agentDir:target,profileId,credential});auth.t();
for(const[name,hash]of hashes)assert.equal(createHash('sha256').update(fs.readFileSync(source+'/'+name)).digest('hex'),hash);
console.log('CLAWBOT_AUTHORIZED_PROFILE_COPIED_TO_DISPOSABLE_STATE_SOURCE_UNCHANGED');`) ]);
  assert.equal(copied, 'CLAWBOT_AUTHORIZED_PROFILE_COPIED_TO_DISPOSABLE_STATE_SOURCE_UNCHANGED');
  step = 'gateway-start';
  await run([...dc, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '120', 'openclaw'], { timeout: 150000 });
  const gateway = await run([...dc, 'ps', '-q', 'openclaw']); assert.match(gateway, /^[a-f0-9]{64}$/);
  const shape = JSON.parse(await run(['inspect', gateway]))[0];
  assert.equal(shape.Image, companion.image); assert.equal(shape.HostConfig.NetworkMode, `container:${origin}`);
  assert.ok(shape.HostConfig.ReadonlyRootfs && !Object.keys(shape.HostConfig.PortBindings ?? {}).length);
  async function cli(script, args, marker, timeout = 120000) {
    const output = await run([...dc, '--profile', 'tools', 'run', '--rm', '-T', 'cli', '--input-type=module', '-e',
      `await import(${JSON.stringify(`/opt/clawbot/docker/${script}`)});process.exit(0);`, '--', ...args], { timeout });
    assert.ok(output.includes(marker), 'CLAWBOT_CANDIDATE_RESULT_MISSING'); passed.push(marker); console.log(marker);
  }
  step = 'http-mcp-dedupe'; await cli('verify-runtime.mjs', [], 'CLAWBOT_TEST_HTTP_DEDUPE_AND_MCP_HISTORY_OK');
  step = 'plugin-cross-instance'; await cli('verify-plugin.mjs', [], 'CLAWBOT_REGISTERED_PLUGIN_CROSS_INSTANCE_CONFIRMATION_AND_OWNER_OK');
  step = 'model-six-tools'; await cli('verify-owner-model.mjs', [], 'CLAWBOT_OWNER_MODEL_SIX_TOOLS_OK', 180000);
  step = 'model-eight-turns'; await cli('verify-channel-model.mjs', ['--suite'], 'CLAWBOT_SYNTHETIC_CHANNEL_MODEL_AUTHORITY_OK', 900000);
  step = 'recreate-persistence';
  await run([...dc, 'stop', 'openclaw', 'origin']);
  const stateMounts = mounted([['ledger-config', '/var/lib/clawbot-test/config'], ['ledger-data', '/var/lib/clawbot-test/ledger'], ['receipts', '/var/lib/clawbot-test/receipts']], ['receipts']);
  assert.match(await run([...common, ...stateMounts, '--entrypoint', 'node', companion.image, '/opt/clawbot/docker/verify-state.mjs', 'save']), /CLAWBOT_STATE_SNAPSHOT_SAVED/);
  await run([...dc, 'up', '-d', '--no-build', '--pull', 'never', '--force-recreate', '--wait', '--wait-timeout', '120', 'origin', 'openclaw'], { timeout: 180000 });
  assert.match(await run([...common, ...stateMounts, '--entrypoint', 'node', companion.image, '/opt/clawbot/docker/verify-state.mjs', 'check']), /CLAWBOT_STATE_RECOVERY_INTEGRITY_OK/);
  await cli('verify-runtime.mjs', [], 'CLAWBOT_TEST_HTTP_DEDUPE_AND_MCP_HISTORY_OK');
  assert.deepEqual(await liveTestBinding(), baseline);
  assert.ok(!existsSync(join(operationsRoot, 'production-enabled.json')));
  passed.push('CLAWBOT_CANDIDATE_RECREATE_AND_LIVE_TEST_UNCHANGED');
} catch { failure = step; console.error(`CLAWBOT_CANDIDATE_BUSINESS_CHECK_FAILED:${step}:${diagnostic ?? 'validation'}`); process.exitCode = 1; }
finally {
  try {
    if (ownsProject) {
      const ids = (await run(['ps', '-a', '-q', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`])).split('\n').filter(Boolean);
      for (const container of ids) {
        const c = JSON.parse(await run(['inspect', container]))[0]; assert.equal(c.Config.Labels['com.docker.compose.project'], project);
        await run(['rm', '-f', container]);
      }
      for (const volume of volumes) {
        if (!(await run(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${volume}$`]))) continue;
        const v = JSON.parse(await run(['volume', 'inspect', volume]))[0]; assert.equal(v.Labels['com.docker.compose.project'], project);
        assert.equal(await run(['ps', '-a', '-q', '--filter', `volume=${volume}`]), ''); await run(['volume', 'rm', volume]);
      }
      const networks = (await run(['network', 'ls', '--format', '{{.Name}}', '--filter', `label=com.docker.compose.project=${project}`])).split('\n').filter(Boolean);
      for (const network of networks) { assert.equal(network, `${project}_default`); await run(['network', 'rm', network]); }
    }
    if (folder) rmSync(folder, { recursive: true });
    cleaned = true;
  } catch { console.error('CLAWBOT_CANDIDATE_FIXTURE_CLEANUP_REQUIRED'); process.exitCode = 1; }
  if (stageLock) { try { rmdirSync(stageLock); } catch { failure ??= 'stage-lock-cleanup'; console.error('CLAWBOT_CANDIDATE_AUTH_STAGE_LOCK_REQUIRES_INSPECTION'); process.exitCode = 1; } }
}
if (release && companion && cleaned) {
  const reports = join(operationsRoot, 'candidate-checks'); mkdirSync(reports, { recursive: true, mode: 0o700 });
  assert.equal(realpathSync(reports), reports); assert.ok(!(lstatSync(reports).mode & 0o077));
  const result = { version: 1, sourceCommit: release.sourceCommit, productionRuntimeImage: release.images.runtime,
    validationImage: companion.image, status: failure ? 'failed' : 'verified-isolated-candidate', failure: failure ?? null,
    passed, cleaned, realWeChatUsed: false, productionServiceAcceptance: false, observedAt: new Date().toISOString() };
  const receipt = join(reports, `${id}.json`); writeFileSync(receipt, JSON.stringify(result), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ ...result, receipt }));
}
