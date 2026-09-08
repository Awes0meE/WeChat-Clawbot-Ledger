import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { encryptArchive, decryptArchive } from './backup-crypto.mjs';
import { waitForOperationLock } from './operation-lock.mjs';
const unlock = await waitForOperationLock('archive-stream-rehearsal');
const folder = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-archive-stream-')));
try {
  const header = Buffer.alloc(512);
  header.write('fixture.txt'); header.write('0000600\0', 100); header.write('0001750\0', 108); header.write('0001750\0', 116);
  header.write('00000000001\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156); header[156] = 48;
  header.write('ustar\0', 257); header.write('00', 263);
  header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  const data = Buffer.alloc(512); data[0] = 120;
  const key = randomBytes(32), manifest = { synthetic: true, paddedTar: true }, file = join(folder, 'state.enc');
  await encryptArchive(Readable.from([header, data, Buffer.alloc(4 * 2 ** 20)]), file, key, manifest);
  await decryptArchive(file, key, manifest);
  async function extract(ignoreZeros) {
    const child = spawn('/Applications/Docker.app/Contents/Resources/bin/docker', ['run', '--rm', '-i', '--network', 'none',
      '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--tmpfs', '/extract:rw,nosuid,nodev,size=1m,mode=1777', '--entrypoint', 'tar', 'clawbot-release-update-rehearsal:p5',
      '-x', '-p', ...(ignoreZeros ? ['--ignore-zeros'] : []), '-f', '-', '-C', '/extract'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('extract failed'))); }); done.catch(() => {});
    // Slow trailing padding makes early tar EOF deterministic, rather than
    // relying on Docker pipe buffering and scheduling luck.
    const paced = new Transform({ transform(chunk, _encoding, callback) { setTimeout(() => callback(null, chunk), 5); } });
    const forwarding = pipeline(paced, child.stdin); forwarding.catch(() => {});
    try { await Promise.all([decryptArchive(file, key, manifest, paced), forwarding, done]); }
    catch (error) { paced.destroy(); child.stdin.destroy(); await Promise.allSettled([forwarding, done]); throw error; }
  }
  await assert.rejects(extract(false), error => ['ERR_STREAM_PREMATURE_CLOSE', 'EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code));
  console.log('CLAWBOT_TAR_EARLY_EOF_REPRODUCED');
  await extract(true);
  console.log('CLAWBOT_FULL_AUTHENTICATED_STREAM_CONSUMED_BEFORE_EXTRACT_EXIT');
} finally { rmSync(folder, { recursive: true, force: true }); unlock(); }
