import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const image = 'sha256:1d3fa022e1259ecee4a5bde1a5763ac5b7b32b7dc85373154b704ea0d10beebd';
const id = randomUUID(), prefix = `clawbot-auth-import-check-${id}`, created = [];
const paths = { source: '/authorization-source', target: '/var/lib/clawbot/openclaw', config: '/run/clawbot-runtime' };
const scripts = fileURLToPath(new URL('../../deploy/docker', import.meta.url));
function run(args, { input, fails = false } = {}) {
  const r = spawnSync(docker, args, { input, encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
  assert.ok(!r.error && Number.isInteger(r.status), 'CLAWBOT_AUTH_IMPORT_REHEARSAL_INCOMPLETE');
  const phase = r.stderr?.match(/CLAWBOT_AUTH_IMPORT_REFUSED_OR_FAILED_MAINTENANCE_REQUIRED:[a-z-]+/)?.[0] ?? '';
  assert.ok(fails ? r.status !== 0 : r.status === 0, `CLAWBOT_AUTH_IMPORT_REHEARSAL_COMMAND:${phase}`);
  return r.stdout.trim();
}
const common = ['run', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777'];
const mounts = (writable = []) => Object.entries(paths).flatMap(([role, path]) =>
  ['--mount', `type=volume,src=${prefix}-${role},dst=${path}${writable.includes(role) ? '' : ',readonly'}`]);
const env = root => ['--env', `HOME=${root}`, '--env', `OPENCLAW_STATE_DIR=${root}`,
  '--env', 'OPENCLAW_CONFIG_PATH=/run/clawbot-runtime/openclaw.json', '--env', 'CODEX_HOME=/tmp/unused-codex'];
function helper(action, binding, fails = false) {
  return run([...common, '--user', '1000:1000', ...mounts(action === 'apply' ? ['target'] : []),
    ...env(paths.target), '--mount', `type=bind,src=${scripts},dst=/checks,readonly`, '--entrypoint', 'node', image,
    '/checks/import-model-authorization.mjs', action, ...(binding ? [binding] : [])], { fails });
}
try {
  for (const role of Object.keys(paths)) {
    const name = `${prefix}-${role}`;
    assert.equal(run(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${name}$`]), '');
    run(['volume', 'create', '--label', `clawbot.auth-import-check=${id}`, name]); created.push(name);
  }
  run([...common, '--user', '0:0', '--cap-add', 'CHOWN', ...mounts(Object.keys(paths)), '--entrypoint', 'node', image, '--input-type=module', '-'], { input: `
    import fs from 'node:fs';
    const roots=${JSON.stringify(Object.values(paths))};
    for(const root of roots) if(fs.readdirSync(root).length)throw Error('nonempty');
    fs.writeFileSync('/run/clawbot-runtime/openclaw.json',JSON.stringify({agents:{entries:{bookkeeper:{}}}}),{mode:0o444});
    for(const root of roots){fs.chmodSync(root,0o700);fs.chownSync(root,1000,1000)}
  ` });
  for (const role of ['target', 'source']) {
    const root = role === 'target' ? paths.target : paths.source + '/openclaw';
    run([...common, '--user', '1000:1000', ...mounts([role]), ...env(root), '--entrypoint', 'node', image, '--input-type=module', '-'], { input: `
      import fs from 'node:fs';import{DatabaseSync}from'node:sqlite';
      const agent=process.env.OPENCLAW_STATE_DIR+'/agents/bookkeeper/agent';fs.mkdirSync(agent,{recursive:true,mode:0o700});
      const{u:save}=await import('/app/dist/profiles-DV3Jcdeb.js');
      await save({agentDir:agent,profileId:'openai:synthetic',credential:{provider:'openai',type:'oauth',accountId:'synthetic-account',
        access:'synthetic-${role}',refresh:'synthetic-refresh-${role}',expires:Date.now()+3600000}});
      const db=new DatabaseSync(agent+'/openclaw-agent.sqlite');db.exec('CREATE TABLE unknown_records(id INTEGER PRIMARY KEY, data BLOB)');
      db.prepare('INSERT INTO unknown_records VALUES(?,?)').run(9007199254740993n,Buffer.from([0,1,255]));
      db.exec('CREATE TABLE unknown_types(value); INSERT INTO unknown_types VALUES(42)');db.close();
    ` });
  }
  const before = JSON.parse(helper('inspect')); assert.equal(before.status, 'CLAWBOT_AUTH_IMPORT_READY_FOR_REVIEW');
  helper('apply', '0'.repeat(64), true);
  assert.equal(JSON.parse(helper('inspect')).binding, before.binding, 'Rejected import changed state');
  const result = JSON.parse(helper('apply', before.binding));
  assert.equal(result.status, 'CLAWBOT_AUTH_IMPORTED_MAINTENANCE_REQUIRED'); assert.equal(result.remoteVerified, false);
  helper('apply', before.binding, true); // The original reviewed target no longer matches.
  const reviewed = JSON.parse(helper('inspect'));
  run([...common, '--user', '1000:1000', ...mounts(['target']), '--entrypoint', 'node', image,
    '--input-type=module', '-'], { input: `
      import fs from 'node:fs';
      fs.writeFileSync('/var/lib/clawbot/openclaw/synthetic-message-state', 'newer synthetic message', {mode:0o600});
    ` });
  const changed = JSON.parse(helper('inspect'));
  assert.notEqual(changed.binding, reviewed.binding, 'Unrelated state change escaped binding');
  helper('apply', reviewed.binding, true);
  assert.equal(JSON.parse(helper('inspect')).binding, changed.binding, 'Stale review changed newer state');
  run([...common, '--user', '1000:1000', ...mounts(['target']), '--entrypoint', 'node', image,
    '--input-type=module', '-'], { input: `
      import {DatabaseSync} from 'node:sqlite';
      const db = new DatabaseSync('/var/lib/clawbot/openclaw/agents/bookkeeper/agent/openclaw-agent.sqlite');
      db.prepare('UPDATE unknown_types SET value = ?').run('42n'); db.close();
    ` });
  assert.notEqual(JSON.parse(helper('inspect')).binding, changed.binding, 'SQLite integer/text change escaped binding');
  helper('apply', changed.binding, true);
  run([...common, '--user', '1000:1000', ...mounts(['source']), '--entrypoint', 'node', image,
    '--input-type=module', '-'], { input: `
      import fs from 'node:fs';
      fs.writeFileSync('/authorization-source/openclaw/agents/bookkeeper/agent/openclaw-agent.sqlite-journal', 'synthetic recovery data');
    ` });
  helper('inspect', undefined, true);
  console.log('CLAWBOT_AUTH_IMPORT_READONLY_REVIEW_STALE_BINDING_AND_PERSISTENCE_VERIFIED');
} finally {
  for (const name of created.reverse()) {
    const volume = JSON.parse(run(['volume', 'inspect', name]))[0];
    assert.equal(volume.Labels?.['clawbot.auth-import-check'], id);
    assert.equal(run(['ps', '-a', '-q', '--filter', `volume=${name}`]), '');
    run(['volume', 'rm', name]);
  }
}
