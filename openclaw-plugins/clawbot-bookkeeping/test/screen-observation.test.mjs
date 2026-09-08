import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScreenSamples } from '../../../scripts/mac/screen-observation.mjs';
const sample = (seconds, locked) => ({ at: new Date(1700000000000 + seconds * 1000).toISOString(), locked, healthy: true, egress: true });
test('lock observation requires actual unlocked, at least sixty locked seconds, then unlocked', () => {
  const rows = [sample(0, false), ...Array.from({ length: 7 }, (_, i) => sample((i + 1) * 10, true))];
  assert.equal(evaluateScreenSamples(rows).complete, false);
  assert.deepEqual(evaluateScreenSamples([...rows, sample(80, false)]), { complete: true, lockedMs: 60000 });
  assert.equal(evaluateScreenSamples(rows.slice(1)).complete, false);
  assert.equal(evaluateScreenSamples([sample(0, false), sample(10, true), sample(20, false)]).complete, false);
});
test('observation gaps and unhealthy or unknown screen samples never count as acceptance', () => {
  assert.throws(() => evaluateScreenSamples([sample(0, false), sample(25, true)]));
  assert.throws(() => evaluateScreenSamples([sample(5, false), sample(5, true)]));
  assert.throws(() => evaluateScreenSamples([{ ...sample(0, false), locked: null }]));
  assert.throws(() => evaluateScreenSamples([{ ...sample(0, false), egress: false }]));
});
