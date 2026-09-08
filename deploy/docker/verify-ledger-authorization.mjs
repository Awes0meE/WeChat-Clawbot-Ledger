import assert from 'node:assert/strict';
import http from 'node:http';
import { probeLedgerAuthorization } from './ledger-authorization.mjs';
const origin = 'http://127.0.0.1:18888', active = new Set();
let fault, sequence = 0, calls = 0;
const server = http.createServer(async (req, res) => {
  const send = (status, value, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value));
  };
  if (req.url === '/mcp' && req.method === 'DELETE') {
    active.delete(req.headers['mcp-session-id']); send(200, {}); return;
  }
  // Streamable HTTP may try an optional server event stream after initialize.
  if (req.url === '/mcp' && req.method === 'GET') { res.writeHead(405); res.end(); return; }
  if (fault?.stall) return;
  if (fault) { send(fault.status, { success: false, errorCode: fault.code, errorMessage: 'synthetic private diagnostic' }); return; }
  if (req.url === '/api/v1/accounts/list.json' && req.method === 'GET') {
    assert.equal(req.headers.authorization, 'Bearer synthetic-http'); send(200, {success:true,result:[]}); return;
  }
  assert.equal(req.url, '/mcp'); assert.equal(req.method, 'POST');
  assert.equal(req.headers.authorization, 'Bearer synthetic-mcp');
  let body = ''; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body); calls++;
  if (request.method === 'initialize') {
    const session = `synthetic-session-${++sequence}`; active.add(session);
    send(200, {jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},
      serverInfo:{name:'synthetic-ledger',version:'1.0'}}}, {'mcp-session-id':session});
  } else if (request.method === 'notifications/initialized') { res.writeHead(202); res.end(); }
  else {
    assert.equal(request.method, 'tools/list', 'The check must not call business tools');
    send(200,{jsonrpc:'2.0',id:request.id,result:{tools:[{name:'query_transactions',inputSchema:{type:'object'}}]}});
  }
});
const listen = () => new Promise(resolve => server.listen(18888, '127.0.0.1', resolve));
const close = () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const probe = () => probeLedgerAuthorization({origin,readToken:role=>`synthetic-${role}`});
try {
  await listen();
  for (const [status, code, state] of [[401,202003,'credential-expired'],[401,202004,'credential-type-mismatch'],
    [400,200020,'source-denied'],[400,200018,'rate-limited'],[503,0,'service-unavailable']]) {
    fault = {status,code}; const result = await probe();
    assert.equal(result.http.state,state); assert.equal(result.mcp.state,state);
    assert.doesNotMatch(JSON.stringify(result),/private diagnostic|synthetic-http|synthetic-mcp/);
    assert.equal(active.size,0);
  }
  fault = {stall:true}; const timedOut = await probe();
  assert.equal(timedOut.http.state,'request-timeout'); assert.equal(timedOut.mcp.state,'request-timeout');
  assert.equal(active.size,0);
  fault = null; const valid = await probe();
  assert.equal(valid.http.state,'accepted-read-only'); assert.equal(valid.mcp.state,'accepted-read-only');
  assert.equal(valid.mcp.sessionCleanup,undefined); assert.equal(active.size,0); assert.equal(calls,3);
  await close(); const disconnected = await probe();
  assert.equal(disconnected.http.state,'transport-unavailable'); assert.equal(disconnected.mcp.state,'transport-unavailable');
  await listen(); const recovered = await probe();
  assert.equal(recovered.http.state,'accepted-read-only'); assert.equal(recovered.mcp.state,'accepted-read-only');
  assert.equal(active.size,0); assert.equal(calls,6);
  console.log('CLAWBOT_LEDGER_AUTH_SDK_FAILURE_CLASSIFICATION_AND_RECONNECT_VERIFIED');
} finally { if (server.listening) await close(); }
