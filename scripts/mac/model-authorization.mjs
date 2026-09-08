// Only project explicit status enums from the pinned upstream inspector. Raw
// profile IDs, credentials, error text, account labels and paths never escape.
const warningByReason = new Map([
  ['auth', 'reauthorization-required'], ['auth_permanent', 'reauthorization-required'],
  ['session_expired', 'reauthorization-required'], ['billing', 'billing-unavailable'],
  ['rate_limit', 'rate-limited'], ['overloaded', 'rate-limited'],
  ['timeout', 'temporarily-unavailable'], ['server_error', 'temporarily-unavailable'],
]);
export function summarizeModelAuthorization(raw, now = Date.now()) {
  const base = { version: 1, state: 'unknown', remoteVerified: false, restartRecommended: false, warnings: [] };
  if (raw?.agentId !== 'bookkeeper' || raw?.resolvedDefault !== 'openai/gpt-5.6-sol'
    || !Array.isArray(raw.fallbacks) || raw.fallbacks.length || !Array.isArray(raw.auth?.runtimeAuthRoutes)) return base;
  if (!Number.isFinite(now) || !Array.isArray(raw.auth.unusableProfiles ?? [])
    || !Array.isArray(raw.auth.oauth?.profiles ?? [])) return base;
  const routes = raw.auth.runtimeAuthRoutes.filter(r => r?.provider === 'openai');
  if (routes.length !== 1 || routes[0].runtime !== 'codex') return base;
  const state = new Map([['usable', 'credentials-present'], ['missing', 'login-required'],
    ['unavailable', 'runtime-unavailable'], ['indeterminate', 'unknown']]).get(routes[0].status) ?? 'unknown';
  const warnings = new Set();
  for (const row of raw.auth.unusableProfiles ?? []) {
    if (row?.provider !== 'openai' || !Number.isFinite(row.until) || row.until <= now
      || !['disabled', 'cooldown'].includes(row.kind)) continue;
    warnings.add(warningByReason.get(row.reason) ?? 'profile-needs-inspection');
  }
  // An expired access token with native refresh support is not proof that the
  // OAuth session was revoked. Neither metadata nor /readyz proves a live call.
  for (const row of raw.auth.oauth?.profiles ?? []) {
    if (row?.provider === 'openai' && ['expired', 'expiring'].includes(row.status)) warnings.add('expiry-metadata-needs-verification');
  }
  return { ...base, state, warnings: [...warnings].sort() };
}

// Project cached diagnostics into the page; never spread subprocess output.
export function visibleModelAuthorization(report, expected, now = Date.now()) {
  const base = { state: 'inspection-unavailable', warnings: [], observedAt: null, remoteVerified: false, restartRecommended: false };
  const states = new Set(['credentials-present', 'login-required', 'runtime-unavailable', 'unknown']);
  const warnings = new Set([...warningByReason.values(), 'profile-needs-inspection', 'expiry-metadata-needs-verification']);
  const profile = expected?.profile ?? 'isolated-test';
  if (!['isolated-test', 'production'].includes(profile) || !report || report.version !== 1 || report.profile !== profile
    || report.remoteVerified !== false || report.restartRecommended !== false
    || !states.has(report.state) || !Array.isArray(report.warnings) || report.warnings.some(w => !warnings.has(w))
    || !expected || !/^[a-f0-9]{40}$/.test(expected.sourceCommit ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expected.runtimeImage ?? '') || !/^[a-f0-9]{64}$/.test(expected.containerId ?? '')
    || !Number.isFinite(Date.parse(expected.containerStartedAt))
    || report.hostSourceCommit !== expected.sourceCommit || report.runtimeImage !== expected.runtimeImage
    || report.containerId !== expected.containerId || report.containerStartedAt !== expected.containerStartedAt) return base;
  const time = Date.parse(report.observedAt), age = now - time;
  if (!Number.isFinite(age) || age < 0 || time < Date.parse(expected.containerStartedAt)) return base;
  if (age > 6 * 60000) return { ...base, state: 'stale', observedAt: new Date(time).toISOString() };
  return { ...base, state: report.state, warnings: [...new Set(report.warnings)], observedAt: new Date(time).toISOString() };
}
