import assert from 'node:assert/strict';
export function evaluateScreenSamples(samples) {
  let prior, started = null, lastLocked = null, unlockedBefore = false, complete = false;
  for (const sample of samples) {
    const at = Date.parse(sample.at);
    assert.ok(Number.isFinite(at) && (prior === undefined || (at > prior && at - prior <= 20000)), 'Screen observation gap or reversed clock');
    assert.ok(typeof sample.locked === 'boolean' && sample.healthy === true && sample.egress === true);
    if (!sample.locked) {
      if (started !== null) { complete = lastLocked - started >= 60000; if (!complete) { started = null; lastLocked = null; } }
      unlockedBefore = true;
    } else if (unlockedBefore) { started ??= at; lastLocked = at; }
    prior = at;
  }
  return { complete, lockedMs: started === null ? 0 : lastLocked - started };
}
