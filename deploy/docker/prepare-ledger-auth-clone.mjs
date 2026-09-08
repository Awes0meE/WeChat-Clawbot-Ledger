import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, lstatSync, realpathSync, readdirSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { parseIni, validateOriginConfig } from '../guard/origin-identity.mjs';
import { fileSha256 } from './migration-files.mjs';

try {
  const profile = process.argv[2]; assert.ok(['production', 'isolated-test'].includes(profile));
  const root = profile === 'production' ? '/var/lib/clawbot' : '/var/lib/clawbot-test';
  const filename = profile === 'production' ? 'ezbookkeeping.db' : 'ezbookkeeping-test.db';
  assert.deepEqual(readdirSync('/verification'), []);
  for (const path of ['/clone-source-ledger', '/clone-source-config', '/verification']) assert.equal(realpathSync(path), path);
  const path = '/clone-source-config/ezbookkeeping.ini', stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 65536);
  const source = readFileSync(path, 'utf8');
  validateOriginConfig(source, { root, port: profile === 'production' ? 8888 : 18888, dbPath: `${root}/ledger/data/${filename}` });
  const values = parseIni(source);
  assert.equal(values.get('server.static_root_path'), '/ezbookkeeping/public');
  const replacements = {
    'server.http_port': '18888', 'server.domain': '127.0.0.1', 'server.root_url': 'http://127.0.0.1:18888/',
    'database.db_path': `/verification/ledger/data/${filename}`,
    'storage.local_filesystem_path': '/verification/ledger/storage',
    'log.log_path': '/verification/ledger/log/authorization-check.log',
    'log.request_log_path': '', 'log.query_log_path': '', 'server.log_request': 'false', 'database.log_query': 'false',
  };
  for (const [key,value] of Object.entries(replacements)) values.set(key,value);
  const sections = new Map();
  for (const [key,value] of values) {
    const [section,name] = key.split('.'); if (!sections.has(section)) sections.set(section, []);
    sections.get(section).push(`${name} = ${value}`);
  }
  const rendered = [...sections].map(([name,rows]) => `[${name}]\n${rows.join('\n')}`).join('\n\n') + '\n';
  const parsed = parseIni(rendered);
  for (const [key,value] of parseIni(source)) assert.equal(parsed.get(key), replacements[key] ?? value);
  let count = 0, bytes = 0;
  async function copy(relative) {
    assert.ok(++count <= 100000 && relative.length < 4096 && relative.split('/').length < 64);
    const from = join('/clone-source-ledger', relative), to = join('/verification/ledger', relative), stat = lstatSync(from);
    assert.ok(!stat.isSymbolicLink());
    if (stat.isDirectory()) {
      mkdirSync(to, { mode: stat.mode & 0o777 });
      for (const name of readdirSync(from).sort()) await copy(relative ? `${relative}/${name}` : name);
    } else {
      bytes += stat.size; assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 4*2**30 && bytes <= 10*2**30);
      const before = await fileSha256(from); copyFileSync(from,to); chmodSync(to,stat.mode & 0o777);
      assert.equal(await fileSha256(to),before); assert.equal(await fileSha256(from),before);
    }
  }
  await copy('');
  writeFileSync('/verification/ezbookkeeping.ini', rendered, {flag:'wx',mode:0o600});
  console.log('CLAWBOT_LEDGER_AUTH_CLONE_PREPARED');
} catch { console.error('CLAWBOT_LEDGER_AUTH_CLONE_PREPARATION_REFUSED'); process.exitCode = 1; }
