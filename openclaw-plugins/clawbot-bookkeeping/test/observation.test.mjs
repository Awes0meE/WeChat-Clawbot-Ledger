import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeObservation, observationRecorder } from '../../../scripts/mac/observation.mjs';
test('Observed health requires elapsed samples; gaps, failures and clock rollback reset the continuous window', () => {
  const start = Date.parse('2026-09-08T00:00:00Z');
  const sample = (minute, healthy = true) => ({ at: new Date(start + minute * 60000).toISOString(), healthy });
  const window = Array.from({ length: 181 }, (_, i) => sample(i));
  assert.equal(summarizeObservation(window).requiredMs, 3 * 3600000);
  assert.equal(summarizeObservation(window.slice(0, -1)).reachedTarget, false);
  assert.equal(summarizeObservation(window).reachedTarget, true);
  assert.equal(summarizeObservation([sample(0), sample(180)]).reachedTarget, false);
  const failed = summarizeObservation([...window, sample(181, false)]);
  assert.equal(failed.continuousMs, 0);
  assert.equal(failed.reachedTarget, false);
  assert.equal(failed.longestMs, 3 * 3600000);
  assert.equal(summarizeObservation([sample(1), sample(0)]).gaps, 1);
});
test('Observation survives restart and binds one release without counting a process downtime as healthy', { skip: process.platform === 'win32' ? 'Requires macOS host uid and POSIX permissions' : false }, () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'clawbot-observation-')));
  try {
    const commit = 'a'.repeat(40), image = `sha256:${'b'.repeat(64)}`, time = Date.now();
    const record = observationRecorder(directory, commit, image);
    record({ healthy: true }, time); record({ healthy: true }, time + 60000);
    const restarted = observationRecorder(directory, commit, image);
    const result = restarted({ healthy: true }, time + 240000);
    assert.equal(result.samples, 3); assert.equal(result.gaps, 1); assert.equal(result.continuousMs, 0);
    assert.throws(() => observationRecorder(directory, commit, `sha256:${'c'.repeat(64)}`));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
