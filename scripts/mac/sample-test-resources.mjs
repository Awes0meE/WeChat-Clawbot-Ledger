import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const docker = '/Applications/Docker.app/Contents/Resources/bin/docker';
const started = Date.now();
const seconds = Number(process.argv[2] ?? 30);
if (!Number.isInteger(seconds) || seconds < 5 || seconds > 60) throw new Error('Sample duration must be 5..60 seconds');
const peaks = {}, latest = {};
let samples = 0;
function bytes(value) {
  const m = value.trim().match(/^([\d.]+)\s*(B|kB|KiB|MB|MiB|GB|GiB)$/);
  if (!m) throw new Error('Unrecognized memory units');
  return Math.round(Number(m[1]) * ({ B: 1, kB: 1000, KiB: 1024, MB: 1e6, MiB: 2 ** 20, GB: 1e9, GiB: 2 ** 30 })[m[2]]);
}
while (Date.now() - started < seconds * 1000) {
  const result = spawnSync(docker, ['stats', '--no-stream', '--format', '{{json .}}', 'clawbot-test-origin-1', 'clawbot-test-openclaw-1'], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) throw new Error('Test resource sampling failed');
  for (const line of result.stdout.trim().split('\n')) {
    const row = JSON.parse(line), service = row.Name.replace(/^clawbot-test-/, '').replace(/-1$/, '');
    const memoryBytes = bytes(row.MemUsage.split('/')[0]), cpuPercent = parseFloat(row.CPUPerc);
    if (!Number.isFinite(cpuPercent)) throw new Error('Invalid CPU sample');
    latest[service] = { memoryBytes, cpuPercent };
    peaks[service] = { memoryBytes: Math.max(peaks[service]?.memoryBytes ?? 0, memoryBytes), cpuPercent: Math.max(peaks[service]?.cpuPercent ?? 0, cpuPercent) };
  }
  samples++;
  await setTimeout(1500);
}
console.log(JSON.stringify({ sampledAt: new Date().toISOString(), durationMs: Date.now() - started, samples, latest, peaks }));
