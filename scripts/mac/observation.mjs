import { mkdirSync, lstatSync, realpathSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

// User-approved acceptance window, updated 2026-09-08. Keep the actual
// sampling, interruption and release-identity requirements unchanged.
export const OBSERVATION_REQUIRED_MS = 3 * 3600000;

export function summarizeObservation(samples) {
  let previous, since = null, longestMs = 0, gaps = 0, unhealthy = 0;
  let minFreeBytes = Infinity, peakMemoryBytes = 0;
  for (const sample of samples) {
    const time = Date.parse(sample.at);
    if (!Number.isFinite(time)) throw new Error('CLAWBOT_OBSERVATION_TIME');
    const gap = previous !== undefined && (time <= previous || time - previous > 90000);
    if (gap) { gaps++; since = null; }
    if (sample.healthy !== true) { unhealthy++; since = null; }
    else { since ??= time; longestMs = Math.max(longestMs, time - since); }
    if (Number.isSafeInteger(sample.freeBytes)) minFreeBytes = Math.min(minFreeBytes, sample.freeBytes);
    if (Number.isSafeInteger(sample.memoryBytes)) peakMemoryBytes = Math.max(peakMemoryBytes, sample.memoryBytes);
    previous = time;
  }
  const continuousMs = since === null || previous === undefined ? 0 : previous - since;
  return { samples: samples.length, firstAt: samples[0]?.at ?? null, lastAt: samples.at(-1)?.at ?? null,
    continuousMs, longestMs, gaps, unhealthy, minFreeBytes: Number.isFinite(minFreeBytes) ? minFreeBytes : null,
    peakMemoryBytes, requiredMs: OBSERVATION_REQUIRED_MS, reachedTarget: continuousMs >= OBSERVATION_REQUIRED_MS };
}

// Store only operational measurements, never configs, Docker inspect output,
// message IDs, logs or credentials. Reaching the fixed budget stops recording;
// it does not erase the evidence or claim the unseen interval was healthy.
export function observationRecorder(directory, sourceCommit, runtimeImage) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || !/^sha256:[a-f0-9]{64}$/.test(runtimeImage)) throw new Error('CLAWBOT_OBSERVATION_RELEASE');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (realpathSync(directory) !== directory || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('CLAWBOT_OBSERVATION_DIRECTORY');
  const path = join(directory, `${sourceCommit}.jsonl`);
  let samples = [], last = 0;
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid() || (file.mode & 0o077) || file.size > 8 * 1024 * 1024) throw new Error('CLAWBOT_OBSERVATION_FILE');
    samples = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    if (samples.some((s) => s.sourceCommit !== sourceCommit || s.runtimeImage !== runtimeImage)) throw new Error('CLAWBOT_OBSERVATION_SOURCE');
    summarizeObservation(samples); last = Date.parse(samples.at(-1)?.at ?? '') || 0;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return (value, now = Date.now()) => {
    if (now - last >= 60000 || now < last) {
      if (samples.length >= 6000) return { ...summarizeObservation(samples), status: 'budget-reached' };
      const sample = { version: 1, at: new Date(now).toISOString(), sourceCommit, runtimeImage,
        healthy: value.healthy === true, hostState: value.hostState, acPower: value.acPower === true,
        freeBytes: Number.isSafeInteger(value.freeBytes) ? value.freeBytes : null,
        memoryBytes: Number.isSafeInteger(value.memoryBytes) ? value.memoryBytes : null };
      appendFileSync(path, JSON.stringify(sample) + '\n', { mode: 0o600 }); samples.push(sample); last = now;
    }
    return { ...summarizeObservation(samples), status: 'recording' };
  };
}
