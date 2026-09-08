import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerAuthorizationFailure, probeLedgerAuthorization } from '../../../deploy/docker/ledger-authorization.mjs';
const origin = 'http://127.0.0.1:18888';
const readToken = role => `${role}-synthetic-token`;
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
test('pinned codes distinguish expiry, wrong type, source policy and throttling without error text', () => {
  for (const [status, code, state] of [[401,202002,'credential-rejected'],[401,202003,'credential-expired'],
    [401,202004,'credential-type-mismatch'],[400,202011,'credential-expired'],[400,200020,'source-denied'],
    [400,200018,'rate-limited'],[403,202015,'api-token-disabled']]) {
    assert.equal(ledgerAuthorizationFailure(status, {success:false,errorCode:code,errorMessage:'PRIVATE'}), state);
  }
  assert.equal(ledgerAuthorizationFailure(400,{success:false,errorCode:999,errorMessage:'token expired'}),'unrecognized-response');
  assert.equal(ledgerAuthorizationFailure(500,{}),'service-unavailable');
  assert.equal(ledgerAuthorizationFailure(400,{success:false,errorCode:202002}),'unrecognized-response');
});
test('read-only acceptance discards account data and only discovers MCP tools', async () => {
  const calls = []; let closed = false;
  const result = await probeLedgerAuthorization({ origin, readToken,
    fetchImpl: async (url, init) => { calls.push([url,init]); return json({success:true,result:[{id:'PRIVATE',name:'SECRET'}]}); },
    clientFactory: async () => ({connect:async()=>{},tools:async()=>({tools:[{name:'query_transactions'}]}),close:async()=>{closed=true;}}) });
  assert.equal(result.http.state,'accepted-read-only'); assert.equal(result.mcp.state,'accepted-read-only'); assert.ok(closed);
  assert.equal(calls.length,1); assert.equal(calls[0][0], origin+'/api/v1/accounts/list.json');
  assert.equal(calls[0][1].method,'GET'); assert.equal(calls[0][1].redirect,'error');
  assert.equal(result.businessWrites,false); assert.equal(result.accountIdentityVerified,false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET|synthetic-token/);
});
test('missing and duplicated credentials do not trigger automatic login or unsafe MCP reuse', async () => {
  const missing = await probeLedgerAuthorization({origin,readToken:()=>{throw Error('SECRET');},fetchImpl:()=>assert.fail()});
  assert.equal(missing.http.state,'credential-unavailable'); assert.equal(missing.mcp.state,'credential-unavailable');
  const malformed = await probeLedgerAuthorization({origin,readToken:()=> 'bad\0token',fetchImpl:()=>assert.fail()});
  assert.equal(malformed.http.state,'credential-unavailable'); assert.equal(malformed.mcp.state,'credential-unavailable');
  const duplicate = await probeLedgerAuthorization({origin,readToken:()=> 'same',fetchImpl:async()=>json({success:true,result:[]}),clientFactory:()=>assert.fail()});
  assert.equal(duplicate.mcp.state,'credential-configuration-mismatch');
});
test('MCP rejection retains explicit status despite SDK wrapper, and closes its session', async () => {
  let closed = false;
  const result = await probeLedgerAuthorization({origin,readToken,
    fetchImpl:async url => url.endsWith('/mcp') ? new Response(JSON.stringify({success:false,errorCode:202004}),{status:401}) : json({success:true,result:[]}),
    clientFactory:async (url,token,fetch) => ({connect:async()=>{try {await fetch(url,{method:'POST'});}catch{throw Error('SDK PRIVATE');}},
      tools:()=>assert.fail(),close:async()=>{closed=true;}}) });
  assert.equal(result.mcp.state,'credential-type-mismatch'); assert.ok(closed); assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
});
test('transport failures and oversized success responses never become authorization acceptance', async () => {
  const unavailable = await probeLedgerAuthorization({origin,readToken:role=>role==='http'?'token':null,fetchImpl:async()=>{throw Error('ECONNREFUSED PRIVATE');}});
  assert.equal(unavailable.http.state,'transport-unavailable');
  const oversized = await probeLedgerAuthorization({origin,readToken:role=>role==='http'?'token':null,fetchImpl:async()=>json({success:true,result:['x'.repeat(128001)]})});
  assert.equal(oversized.http.state,'unrecognized-response');
  await assert.rejects(probeLedgerAuthorization({origin:'https://example.com',readToken:()=>assert.fail()}));
});
