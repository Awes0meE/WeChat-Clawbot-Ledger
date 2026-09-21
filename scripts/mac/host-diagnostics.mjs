import { constants, mkdirSync, lstatSync, realpathSync, openSync, closeSync, fstatSync, writeSync,
  readFileSync, renameSync, unlinkSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { freemem, totalmem, loadavg, uptime } from 'node:os';

// Never persist command arguments, stdout/stderr, environment, credentials or
// application logs. Only this closed diagnostic schema may reach disk.
const codeSet = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EROFS', 'EMFILE', 'ENFILE',
  'ENOMEM', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ABORT_ERR']);
const signalSet = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV']);
const textKinds = [
  ['disk-full', /ENOSPC|no space left on device/i], ['io-error', /\bEIO\b|input\/output error/i],
  ['read-only-filesystem', /EROFS|read-only file system/i], ['permission-denied', /permission denied|EACCES|operation not permitted/i],
  ['daemon-unavailable', /cannot connect to the docker daemon|is the docker daemon running|connection refused/i],
  ['missing-resource', /no such (?:container|volume|image|file)|not found/i],
  ['out-of-memory', /out of memory|cannot allocate memory|ENOMEM/i], ['timeout', /timed out|timeout|deadline exceeded/i],
];
export function diagnosticError(error, { elapsedMs = 0, timeoutMs = 0 } = {}) {
  const output = `${error?.stderr ?? ''}\n${error?.stdout ?? ''}\n${error?.message ?? ''}`;
  const timedOut = error?.killed === true && timeoutMs > 0 && elapsedMs >= timeoutMs;
  return { kind: timedOut ? 'timeout' : textKinds.find(([, pattern]) => pattern.test(output))?.[0] ?? 'unclassified',
    code: Number.isInteger(error?.code) ? error.code : codeSet.has(error?.code) ? error.code : null,
    signal: signalSet.has(error?.signal) ? error.signal : null, timedOut, elapsedMs, timeoutMs,
    outputBytes: Buffer.byteLength(output), outputSha256: createHash('sha256').update(output).digest('hex') };
}
export function hostResources() {
  return { freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(), loadAverage: loadavg(),
    uptimeSeconds: Math.floor(uptime()), processRssBytes: process.memoryUsage().rss };
}
export function containerDiagnostics(container) {
  const state = container.State ?? {}, health = state.Health ?? {};
  return { id: /^[a-f0-9]{64}$/.test(container.Id ?? '') ? container.Id : null,
    running: state.Running === true, oomKilled: state.OOMKilled === true,
    exitCode: Number.isInteger(state.ExitCode) ? state.ExitCode : null,
    restartCount: Number.isSafeInteger(container.RestartCount) ? container.RestartCount : null,
    startedAt: validDate(state.StartedAt), finishedAt: validDate(state.FinishedAt),
    health: ['healthy', 'unhealthy', 'starting'].includes(health.Status) ? health.Status : 'unknown',
    failingStreak: Number.isSafeInteger(health.FailingStreak) ? health.FailingStreak : null,
    lastHealthExitCode: Number.isInteger(health.Log?.at(-1)?.ExitCode) ? health.Log.at(-1).ExitCode : null };
}
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const token = value => typeof value === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(value) ? value : 'unknown';
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
function safeError(error) {
  if (!error) return undefined;
  return { kind: ['unclassified', ...textKinds.map(([kind]) => kind)].includes(error.kind) ? error.kind : 'unclassified',
    code: Number.isInteger(error.code) || codeSet.has(error.code) ? error.code : null,
    signal: signalSet.has(error.signal) ? error.signal : null, timedOut: error.timedOut === true,
    elapsedMs: number(error.elapsedMs), timeoutMs: number(error.timeoutMs), outputBytes: number(error.outputBytes),
    outputSha256: /^[a-f0-9]{64}$/.test(error.outputSha256 ?? '') ? error.outputSha256 : null };
}
function safeRecord(input) {
  const out = { at: validDate(input.at) ?? new Date().toISOString(), event: token(input.event), phase: token(input.phase),
    sequence: number(input.sequence), pid: number(input.pid) ?? process.pid, elapsedMs: number(input.elapsedMs), tickGapMs: number(input.tickGapMs) };
  if (input.state !== undefined) out.state = token(input.state);
  if (/^[a-f0-9]{64}$/.test(input.codeFingerprint ?? '')) out.codeFingerprint = input.codeFingerprint;
  if (input.error) out.error = safeError(input.error);
  if ('storage' in input) out.storageAvailable = input.storage != null;
  if (input.storage) out.storage = { hostFreeBytes: number(input.storage.hostFreeBytes), volumeFreeBytes: number(input.storage.volumeFreeBytes),
    error: ['STORAGE_UNAVAILABLE', 'STORAGE_IDENTITY_INVALID'].includes(input.storage.error) ? input.storage.error : null,
    diagnostic: safeError(input.storage.diagnostic) };
  if (input.view) {
    out.view = Object.fromEntries(['available', 'identityValid', 'namespaceValid', 'healthy'].map(k => [k, input.view[k] === true]));
    out.containers = {};
    for (const role of ['origin', 'openclaw', 'guard']) {
      const c = input.view.diagnostics?.[role] ?? input.containers?.[role];
      if (c) out.containers[role] = containerDiagnostics({ Id: c.id, RestartCount: c.restartCount,
        State: { Running: c.running, OOMKilled: c.oomKilled, ExitCode: c.exitCode, StartedAt: c.startedAt, FinishedAt: c.finishedAt,
          Health: { Status: c.health, FailingStreak: c.failingStreak, Log: [{ ExitCode: c.lastHealthExitCode }] } } });
    }
  }
  if (input.resources) {
    out.resources = Object.fromEntries(['freeMemoryBytes', 'totalMemoryBytes', 'uptimeSeconds', 'processRssBytes'].map(k => [k, number(input.resources[k])]));
    out.resources.loadAverage = (input.resources.loadAverage ?? []).slice(0, 3).map(number);
  }
  if (input.stats) {
    out.statsObservedAt = validDate(input.statsObservedAt);
    out.stats = {};
    for (const role of ['origin', 'openclaw', 'guard']) {
      const row = input.stats[role]; if (!row) continue;
      out.stats[role] = Object.fromEntries(['cpuPercent', 'memoryPercent', 'pids'].map(k => [k, number(row[k])]));
      // Docker's human-readable usage is deliberately restricted to units and numbers.
      out.stats[role].memoryUsage = typeof row.memoryUsage === 'string' && /^[\d. kKMGTiB/]+$/.test(row.memoryUsage) && row.memoryUsage.length < 80 ? row.memoryUsage : null;
    }
  }
  return out;
}
export const diagnosticSnapshot = input => safeRecord(input);

// One writer (the verified production host). 32 MiB of samples, 4 MiB of
// events, eight bounded incident files and a crash-progress marker.
export function hostDiagnostics(directory, { sampleBytes = 4 * 2 ** 20, eventBytes = 2 ** 20,
  sampleFiles = 8, eventFiles = 4, incidentFiles = 8, incidentBytes = 256 * 1024 } = {}) {
  let failures = 0, lastFailure = null, history = [], previousProgress = null;
  function directoryReady() {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const s = lstatSync(directory);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || s.mode & 0o077 || realpathSync(directory) !== directory) throw Error('private-directory');
  }
  function check(path) {
    try { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid() || s.mode & 0o077) throw Error('private-file'); return s; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function rotate(name, files) {
    for (let i = 0; i < files; i++) check(join(directory, i ? `${name}.${i}` : name));
    const oldest = join(directory, `${name}.${files - 1}`);
    if (check(oldest)) unlinkSync(oldest);
    for (let i = files - 2; i >= 0; i--) {
      const src = join(directory, i ? `${name}.${i}` : name);
      if (check(src)) renameSync(src, join(directory, `${name}.${i + 1}`));
    }
  }
  function write(path, text, append = false, durable = false) {
    check(path);
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (append ? constants.O_APPEND : constants.O_TRUNC), 0o600);
    try {
      const s = fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid() || s.mode & 0o077) throw Error('private-file');
      const bytes = Buffer.from(text); let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      if (durable) fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  function guarded(action) {
    try { directoryReady(); action(); return true; }
    catch (error) { failures++; lastFailure = diagnosticError(error); return false; }
  }
  guarded(() => {
    const progress = join(directory, 'progress.json'), ps = check(progress);
    if (ps && ps.size <= 65536) previousProgress = safeRecord(JSON.parse(readFileSync(progress, 'utf8')));
    for (let i = 0; i < sampleFiles && history.length < 120; i++) {
      const p = join(directory, i ? `samples.jsonl.${i}` : 'samples.jsonl'), s = check(p);
      if (!s || s.size > sampleBytes) continue;
      const rows = readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-120).flatMap(line => {
        try { const r = JSON.parse(line); return r.event === 'sample' ? [safeRecord(r)] : []; } catch { return []; }
      });
      history = [...rows, ...history].slice(-120);
    }
  });
  return {
    previousProgress,
    status: () => ({ healthy: failures === 0, failures, lastFailure }),
    progress(input) { return guarded(() => {
      const temp = join(directory, 'progress.tmp'), path = join(directory, 'progress.json'); check(path);
      write(temp, JSON.stringify(safeRecord({ ...input, event: 'progress' })) + '\n'); renameSync(temp, path);
    }); },
    record(input, { incident = false } = {}) { return guarded(() => {
      const row = safeRecord(input), text = JSON.stringify(row) + '\n', sample = row.event === 'sample';
      const name = sample ? 'samples.jsonl' : 'events.jsonl', limit = sample ? sampleBytes : eventBytes;
      if (Buffer.byteLength(text) > limit) throw Error('record-too-large');
      const path = join(directory, name), s = check(path);
      if (s && s.size + Buffer.byteLength(text) > limit) rotate(name, sample ? sampleFiles : eventFiles);
      write(path, text, true, incident);
      if (incident) {
        const incidentPath = join(directory, 'incident.json'); rotate('incident.json', incidentFiles);
        let before = [...history], payload;
        do { payload = JSON.stringify({ version: 1, trigger: row, before }); if (Buffer.byteLength(payload) <= incidentBytes) break; before.shift(); } while (before.length);
        if (Buffer.byteLength(payload) > incidentBytes) throw Error('incident-too-large');
        write(incidentPath, payload + '\n', false, true);
        const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      }
      if (sample) { history.push(row); if (history.length > 120) history.shift(); }
    }); },
  };
}
