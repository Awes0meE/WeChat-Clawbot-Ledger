// The HTTP page must keep refreshing while a diagnostic waits on the gateway.
// Results remain private until the status collector checks their identities.
export function backgroundAuthorizationChecks({ now = Date.now } = {}) {
  const entries = new Map();
  let epoch = 0, pending = 0;
  return {
    invalidate() { epoch++; entries.clear(); },
    get pending() { return pending > 0; },
    read(name, action, { refreshMs = 5 * 60000 } = {}) {
      if (!Number.isSafeInteger(refreshMs) || refreshMs < 1000 || refreshMs > 5 * 60000) throw Error('Invalid diagnostic refresh interval');
      let entry = entries.get(name);
      if (!entry || (!entry.pending && now() >= entry.nextAt)) {
        const previous = entry?.value, capturedEpoch = epoch;
        entry = { pending: true, nextAt: now() + refreshMs, value: previous };
        entries.set(name, entry); pending++;
        Promise.resolve().then(action)
          .then(value => { if (epoch === capturedEpoch && entries.get(name) === entry) entry.value = value; })
          .catch(() => { if (epoch === capturedEpoch && entries.get(name) === entry) entry.value = undefined; })
          .finally(() => { entry.pending = false; pending--; });
      }
      return entry.value;
    },
  };
}
