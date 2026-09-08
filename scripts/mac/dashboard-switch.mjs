// All external actions operate on exact, previously verified job handles.
// A durable started record precedes retirement. Rollback only restores UI
// jobs; it never changes production activation, containers, data or routing.
export async function switchDashboard(actions) {
  try {
    await actions.preflight();
    await actions.record('started');
    try {
      await actions.retirePrevious();
      await actions.assertVacant();
      await actions.installNext();
      await actions.releaseLock();
      await actions.verifyNext();
      await actions.verifyProductionUnchanged();
      await actions.record('completed');
      return { status: 'CLAWBOT_DASHBOARD_SWITCHED', productionChanged: false };
    } catch {
      try {
        await actions.acquireLock();
        await actions.removeNextIfOwned();
        // Retirement can fail while the exact previous listener still runs.
        // Restoration must accept that listener, or require a free port.
        await actions.restorePrevious();
        await actions.releaseLock();
        await actions.verifyPrevious();
        await actions.verifyProductionUnchanged();
        await actions.record('rolled-back');
        return { status: 'CLAWBOT_DASHBOARD_PREVIOUS_RESTORED', productionChanged: false };
      } catch {
        await actions.record('needs-attention');
        throw Error('CLAWBOT_DASHBOARD_SWITCH_NEEDS_ATTENTION');
      }
    }
  } finally { await actions.releaseLock(); }
}
