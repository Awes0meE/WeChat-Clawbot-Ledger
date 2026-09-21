import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { operationsRoot } from './operation-lock.mjs';

// Private, local-only output. This is not a dashboard HTTP endpoint.
const directory = join(operationsRoot, 'runtime-diagnostics');
try {
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || dir.mode & 0o077) throw Error();
  function read(name, maxBytes) {
    const path = join(directory, name);
    let s; try { s = lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid() || s.mode & 0o077 || s.size > maxBytes) throw Error();
    return readFileSync(path, 'utf8');
  }
  const progress = JSON.parse(read('progress.json', 65536) ?? 'null');
  const samples = (read('samples.jsonl', 4 * 2 ** 20) ?? '').trim().split('\n').filter(Boolean);
  const events = (read('events.jsonl', 2 ** 20) ?? '').trim().split('\n').filter(Boolean).slice(-20).map(JSON.parse);
  const incident = JSON.parse(read('incident.json', 256 * 1024 + 1) ?? 'null');
  console.log(JSON.stringify({ progress, lastSample: samples.length ? JSON.parse(samples.at(-1)) : null,
    recentEvents: events, lastIncident: incident ? { trigger: incident.trigger, precedingSamples: incident.before.length } : null }, null, 2));
} catch { console.error('CLAWBOT_HOST_DIAGNOSTICS_UNAVAILABLE'); process.exitCode = 1; }
