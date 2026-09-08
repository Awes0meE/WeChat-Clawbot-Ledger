import assert from 'node:assert/strict';
// ezBookkeeping 1.6.1, revision 6ccd0c462100828c78e203792a5b2feb8d569039.
// Match explicit status/code pairs, not human-readable server errors.
const failures = new Map([
  ['401:202001', 'credential-rejected'], ['401:202002', 'credential-rejected'],
  ['401:202003', 'credential-expired'], ['401:202004', 'credential-type-mismatch'],
  ['401:202005', 'interactive-auth-required'], ['400:202011', 'credential-expired'],
  ['400:202012', 'credential-missing'], ['403:202015', 'api-token-disabled'],
  ['400:200018', 'rate-limited'], ['400:200020', 'source-denied'],
]);
export function ledgerAuthorizationFailure(status, payload) {
  if (payload?.success === false && Number.isSafeInteger(payload.errorCode)) {
    const known = failures.get(`${status}:${payload.errorCode}`); if (known) return known;
  }
  if (status === 429) return 'rate-limited';
  if (status >= 500 && status <= 599) return 'service-unavailable';
  return 'unrecognized-response';
}
class ProbeFailure extends Error {
  constructor(state) { super('CLAWBOT_LEDGER_AUTH_CHECK_FAILED'); this.state = state; }
}
async function boundedJson(response) {
  if (!response.body) throw new ProbeFailure('unrecognized-response');
  const reader = response.body.getReader(); let bytes = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > 128000) throw new ProbeFailure('unrecognized-response');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
async function mcpClient(url, token, fetchImpl, signal) {
  const { Client } = await import('/opt/clawbot/plugins/clawbot-bookkeeping/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { StreamableHTTPClientTransport } = await import('/opt/clawbot/plugins/clawbot-bookkeeping/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js');
  const client = new Client({ name: 'clawbot-authorization-check', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }, fetch: fetchImpl,
    reconnectionOptions: { maxRetries: 0 },
  });
  return {
    connect: () => client.connect(transport, { signal, timeout: 10000 }),
    tools: () => client.listTools({}, { signal, timeout: 10000 }),
    close: async () => {
      try { await transport.terminateSession(); } finally { await client.close(); }
    },
  };
}
export async function probeLedgerAuthorization({ origin, readToken, fetchImpl = globalThis.fetch, clientFactory = mcpClient }) {
  assert.ok(['http://127.0.0.1:18888', 'http://127.0.0.1:8888'].includes(origin));
  const report = { version: 1, http: { state: 'credential-unavailable' }, mcp: { state: 'credential-unavailable' },
    businessWrites: false, accountIdentityVerified: false, restartRecommended: false };
  const tokens = {};
  for (const role of ['http', 'mcp']) {
    try {
      const value = await readToken(role);
      if (typeof value !== 'string' || !value.trim() || value.length > 16384 || /[^\x21-\x7e]/.test(value.trim())) continue;
      tokens[role] = value.trim();
    } catch { /* Do not publish paths, token contents or file errors. */ }
  }
  async function guardedFetch(url, init, signal) {
    let response;
    try { response = await fetchImpl(url, { ...init, redirect: 'error', signal }); }
    catch { throw new ProbeFailure(signal.aborted ? 'request-timeout' : 'transport-unavailable'); }
    if (!response.ok) {
      let payload; try { payload = await boundedJson(response); } catch { /* Still classify 429/5xx. */ }
      throw new ProbeFailure(ledgerAuthorizationFailure(response.status, payload));
    }
    return response;
  }
  const stateFor = (error, signal) => error instanceof ProbeFailure ? error.state
    : signal.aborted ? 'request-timeout' : 'unrecognized-response';
  if (tokens.http) {
    const signal = AbortSignal.timeout(10000);
    try {
      const response = await guardedFetch(`${origin}/api/v1/accounts/list.json`,
        { method: 'GET', headers: { Authorization: `Bearer ${tokens.http}`, 'X-Timezone-Name': 'Asia/Singapore' } }, signal);
      const payload = await boundedJson(response);
      if (payload?.success !== true || !Array.isArray(payload.result)) throw new ProbeFailure('unrecognized-response');
      report.http = { state: 'accepted-read-only' };
    } catch (error) { report.http = { state: stateFor(error, signal) }; }
  }
  if (tokens.mcp && tokens.mcp === tokens.http) report.mcp = { state: 'credential-configuration-mismatch' };
  else if (tokens.mcp) {
    const signal = AbortSignal.timeout(10000), url = `${origin}/mcp`; let client, failure;
    try {
      client = await clientFactory(url, tokens.mcp, async (input, init = {}) => {
        if ((input instanceof Request ? input.url : String(input)) !== url) throw new ProbeFailure('endpoint-mismatch');
        const combined = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
        try {
          const response = await guardedFetch(input, init, combined);
          if (!response.body) return response;
          let bytes = 0;
          const body = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (bytes > 128000) { controller.error(new ProbeFailure('unrecognized-response')); return; }
            controller.enqueue(chunk);
          } }));
          return new Response(body, { status: response.status, headers: response.headers });
        } catch (error) { failure = stateFor(error, combined); throw error; }
      }, signal);
      await client.connect(); const result = await client.tools();
      if (!Array.isArray(result?.tools) || !result.tools.some(t => t?.name === 'query_transactions')) {
        throw new ProbeFailure('required-tool-unavailable');
      }
      report.mcp = { state: 'accepted-read-only' };
    } catch (error) { report.mcp = { state: error instanceof ProbeFailure ? error.state : failure ?? stateFor(error, signal) }; }
    finally {
      if (client) { try { await client.close(); } catch { report.mcp.sessionCleanup = 'not-confirmed'; } }
    }
  }
  return { ...report, observedAt: new Date().toISOString() };
}
