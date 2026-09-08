// Both the production host and the isolated three-service rehearsal use this
// controller. The driver verifies identities; only verified handles are stopped.
export function storageDecision(sample, wasStopped = false) {
  if (!sample || sample.error || !['hostFreeBytes', 'volumeFreeBytes'].every((key) =>
    Number.isSafeInteger(sample[key]) && sample[key] >= 0)) return 'fault';
  const GiB = 2 ** 30;
  if (sample.hostFreeBytes < 5 * GiB || sample.volumeFreeBytes < 2 * GiB) return 'stop';
  if (sample.hostFreeBytes < 10 * GiB || sample.volumeFreeBytes < 4 * GiB) return wasStopped ? 'hold' : 'warn';
  return 'ok';
}

export async function reconcileRuntime(driver, state, { now = Date.now(), storage, maintenance = false } = {}) {
  if (maintenance) return 'maintenance';
  const view = await driver.inspect();
  if (!view.available) return 'waiting-for-docker';
  const stop = async (roles) => {
    // Sequential stop is deliberate: close publication first, then quiesce
    // ingestion, then stop the local ledger. No wildcard/unknown process stop.
    for (const role of roles) if (view.trusted[role]) await driver.stop(role, view.trusted[role]);
  };
  if (!view.identityValid) {
    await stop(['guard', 'openclaw']);
    return 'identity-needs-attention';
  }
  let allowed;
  try { allowed = await driver.validateInputs(); } catch { allowed = false; }
  if (!allowed) { await stop(['guard', 'openclaw']); return 'activation-needs-attention'; }
  const disk = storageDecision(storage, state.storageStopped);
  if (disk === 'fault') {
    state.storageFault = true;
    // Persist the latch before stopping if possible. If a full host disk also
    // prevents this write, remain stopped and keep the in-memory latch.
    try { await driver.latchStorageFault(); } catch {}
  }
  if (state.storageFault || disk === 'stop' || disk === 'hold') {
    state.storageStopped = true;
    await stop(['guard', 'openclaw', 'origin']);
    return state.storageFault ? 'storage-fault-latched' : 'stopped-low-disk';
  }
  if (disk === 'warn' && !view.healthy) return 'low-disk-no-restart';
  if (view.healthy && view.namespaceValid) {
    state.storageStopped = false;
    return disk === 'warn' ? 'healthy-low-disk' : 'healthy';
  }
  // A connected process can be temporarily unready while cloudflared retries
  // the network. Do not restart a healthy ledger to mask an upstream outage.
  if (view.namespaceValid && view.ready.origin && view.ready.openclaw && view.running.guard) return 'guard-unready';
  if (now < (state.retryAt ?? 0)) return 'recovery-backoff';
  state.retryAt = now + 5 * 60000;
  await stop(['guard', 'openclaw']);
  try {
    if (!view.ready.origin) {
      await stop(['origin']);
      await driver.start('origin', false);
    }
    await driver.requireReady('origin');
    // Recreate the dependants after any origin restart/replacement so both
    // network and PID namespaces bind to the currently verified owner.
    await driver.start('openclaw', true);
    await driver.requireReady('openclaw');
    if (!await driver.validateInputs()) throw new Error('Activation changed');
    await driver.start('guard', true);
    await driver.requireReady('guard');
    const after = await driver.inspect();
    if (!after.identityValid || !after.namespaceValid || !after.healthy) throw new Error('Recovery identity mismatch');
    state.storageStopped = false;
    return 'healthy';
  } catch {
    const current = await driver.inspect();
    for (const role of ['guard', 'openclaw']) if (current.trusted?.[role]) await driver.stop(role, current.trusted[role]);
    return 'recovery-needs-attention';
  }
}
