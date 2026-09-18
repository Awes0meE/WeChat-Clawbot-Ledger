import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { validateNotificationConfig, probeNotificationRelay, notificationRelayMonitor } from '../../../scripts/mac/notification-relay-status.mjs';

const config = { healthUrl: 'http://127.0.0.1:19781/healthz', phoneVerifiedAt: '2026-01-01T00:00:00Z' };
test('notification observation accepts only credential-free private health endpoints', () => {
  assert.equal(validateNotificationConfig(config).healthUrl, config.healthUrl);
  for (const healthUrl of ['https://example.com/healthz', 'http://8.8.8.8:19781/healthz',
    'http://localhost:19781/healthz', 'http://user:secret@127.0.0.1:19781/healthz',
    'http://127.0.0.1:19781/healthz?token=secret', 'http://127.0.0.1:19781/v1/notify',
    ...[8888, 18888, 18789, 18990].map(port => `http://127.0.0.1:${port}/healthz`)]) {
    assert.throws(() => validateNotificationConfig({ healthUrl }));
  }
  assert.throws(() => validateNotificationConfig({ ...config, token: 'fake' }));
  assert.throws(() => validateNotificationConfig({ ...config, phoneVerifiedAt: '2999-01-01' }));
});
test('failed and stale probes clear current green status without exposing endpoint or errors', async () => {
  let now = Date.parse('2026-01-02'), fail = false;
  const monitor = notificationRelayMonitor({ loadConfig: () => config, now: () => now,
    probe: async () => { if (fail) throw Error('PRIVATE ERROR'); } });
  await monitor.refresh(); assert.equal(monitor.snapshot().state, 'online');
  now += 15000; assert.equal(monitor.snapshot().state, 'unknown');
  fail = true; await monitor.refresh(); assert.equal(monitor.snapshot().state, 'unavailable');
  assert.ok(monitor.snapshot().phoneVerifiedAt);
  assert.doesNotMatch(JSON.stringify(monitor.snapshot()), /127\.0|PRIVATE|healthUrl/);
  now -= 1; assert.equal(monitor.snapshot().state, 'unknown');
});
test('missing or invalid configuration never probes and in-flight checks do not overlap', async () => {
  let calls = 0, finish;
  for (const loadConfig of [() => null, () => ({ token: 'fake' }), () => { throw Error(); }]) {
    const monitor = notificationRelayMonitor({ loadConfig, probe: () => { calls++; } });
    await monitor.refresh(); assert.notEqual(monitor.snapshot().state, 'online');
  }
  assert.equal(calls, 0);
  const monitor = notificationRelayMonitor({ loadConfig: () => config, probe: () => {
    calls++; return new Promise(resolve => { finish = resolve; });
  } });
  const first = monitor.refresh(); await monitor.refresh(); assert.equal(calls, 1);
  assert.equal(monitor.snapshot().state, 'unknown'); finish(); await first;
  assert.equal(monitor.snapshot().state, 'online');
});
test('health transport uses GET without authorization and rejects redirects, foreign responses, excess data and timeouts', async () => {
  let mode = 'ready', calls = 0;
  const server = createServer((req, res) => {
    calls++; assert.equal(req.method, 'GET'); assert.equal(req.url, '/healthz');
    assert.equal(req.headers.authorization, undefined);
    if (mode === 'timeout') return;
    if (mode === 'redirect') { res.writeHead(302, { Location: '/must-not-follow' }); res.end(); return; }
    res.end(mode === 'large' ? 'x'.repeat(5000) : JSON.stringify({ service: mode === 'wrong' ? 'another-service' : 'codex-bark-relay', status: 'ready' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/healthz`;
  try {
    await probeNotificationRelay(url);
    for (mode of ['redirect', 'wrong', 'large', 'timeout']) await assert.rejects(probeNotificationRelay(url));
    assert.equal(calls, 5);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
