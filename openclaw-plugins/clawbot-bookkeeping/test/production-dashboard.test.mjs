import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const code = readFileSync(new URL('../../../deploy/dashboard/production.js', import.meta.url), 'utf8');
async function render({ age = 0, profile = 'production', offline = false, ...overrides } = {}) {
  const elements = new Map();
  const element = () => ({ textContent: '', children: [], classList: { toggle() {}, remove() {} },
    append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; } });
  const state = { version: 1, profile, updatedAt: new Date(Date.now() - age).toISOString(), state: 'healthy', boundaryHealthy: true,
    services: [{ name: 'origin', running: true, health: 'healthy' }], modelAuthorization: { state: 'credentials-present', warnings: [] },
    ledgerAuthorization: { state: 'observed', http: { state: 'accepted-read-only' }, mcp: { state: 'credential-expired' } },
    weixinAuthorization: { state: 'reauthorization-required' }, tunnelAuthorization: { state: 'observed', diagnostic: 'transport-unavailable', authorization: 'credential-rejected' },
    ...overrides };
  const context = vm.createContext({ document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element },
    Date, Number, Map, AbortSignal, setInterval() {}, fetch: async () => { if (offline) throw Error(); return { ok: true, json: async () => state }; } });
  vm.runInContext(code, context); await new Promise(resolve => setImmediate(resolve));
  return elements;
}
test('production page distinguishes local health from each authorization and retained Tunnel rejection', async () => {
  const nodes = await render();
  assert.match(nodes.get('overall').textContent, /需要处理/);
  assert.match(nodes.get('host-state').textContent, /微信需要重新登录/);
  assert.match(nodes.get('model').textContent, /云端调用未验证/);
  assert.match(nodes.get('ledger-http').textContent, /授权检查通过/);
  assert.match(nodes.get('ledger-mcp').textContent, /授权已过期/);
  assert.match(nodes.get('weixin').textContent, /重新授权/);
  assert.match(nodes.get('tunnel').textContent, /网络暂不可用.*凭据拒绝/);
});
test('stale, future, test-profile and disconnected pages remove all current service and authorization claims', async () => {
  for (const options of [{ age: 30000 }, { age: -30000 }, { profile: 'isolated-test' }, { offline: true }]) {
    const nodes = await render(options);
    for (const id of ['overall', 'model', 'ledger-http', 'weixin', 'tunnel']) assert.match(nodes.get(id).textContent, /无法确认/);
    assert.equal(nodes.get('services').children.length, 0);
  }
});
test('unknown backend text is not displayed and cleanup failure remains visible', async () => {
  const nodes = await render({ modelAuthorization: { state: 'SECRET', warnings: ['PRIVATE'] },
    weixinAuthorization: { state: 'SECRET' }, tunnelAuthorization: { state: 'observed', diagnostic: 'SECRET' },
    ledgerAuthorization: { state: 'observed', http: { state: 'accepted-read-only' }, mcp: { state: 'accepted-read-only', sessionCleanup: 'not-confirmed' } } });
  assert.doesNotMatch([...nodes.values()].map(n => n.textContent).join(' '), /SECRET|PRIVATE/);
  assert.match(nodes.get('ledger-mcp').textContent, /清理未确认/);
});

test('a background operation distinguishes observed running services from a stopped host', async () => {
  const base = { state: 'another-operation', boundaryHealthy: false, weixinAuthorization: {}, tunnelAuthorization: {},
    ledgerAuthorization: {}, services: ['origin', 'openclaw', 'guard'].map(name => ({ name, running: true, health: 'healthy' })) };
  assert.match((await render(base)).get('host-state').textContent, /服务仍在运行/);
  assert.doesNotMatch((await render({ ...base, services: base.services.map(s => ({ ...s, running: false })) })).get('host-state').textContent, /服务仍在运行/);
});
