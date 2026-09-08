import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizationStatusForPoll } from '../dist/src/monitor/authorization-status.js';

test('explicit server success confirms polling; local timeout and unknown data do not', () => {
  assert.deepEqual(authorizationStatusForPoll({ret:0}),{connected:true,lastError:null});
  for(const value of [{},{ret:'0'},{ret:NaN},null,{ret:0,localTransportTimeout:true}])assert.equal(authorizationStatusForPoll(value).connected,false);
  assert.equal(authorizationStatusForPoll({ret:0,localTransportTimeout:true}).lastError,'CLAWBOT_WEIXIN_POLL_TIMEOUT');
});
test('successful iLink poll envelopes can omit both zero-valued status codes', () => {
  for (const msgs of [[], [{ message_id: 'synthetic-message' }]]) {
    assert.deepEqual(authorizationStatusForPoll({ msgs, get_updates_buf: 'synthetic-cursor', sync_buf: '' }),
      { connected: true, lastError: null });
  }
});
test('an incomplete poll envelope cannot turn unknown data into accepted authorization', () => {
  for (const value of [{ msgs: [] }, { get_updates_buf: 'cursor' }, { msgs: [], get_updates_buf: '' },
    { msgs: [], get_updates_buf: ' ' }, { msgs: {}, get_updates_buf: 'cursor' },
    { msgs: [], get_updates_buf: 123 }]) {
    assert.deepEqual(authorizationStatusForPoll(value), { connected: false, lastError: 'CLAWBOT_WEIXIN_RESPONSE_UNRECOGNIZED' });
  }
});
test('poll data never overrides explicit errors, malformed codes or local timeouts', () => {
  const envelope = { msgs: [], get_updates_buf: 'synthetic-cursor' };
  for (const override of [{ ret: -14 }, { errcode: 503 }, { ret: '0' }, { errcode: null }, { localTransportTimeout: true }]) {
    assert.equal(authorizationStatusForPoll({ ...envelope, ...override }).connected, false);
  }
});
test('only exact stale-token codes request reauthorization; raw errors never escape', () => {
  for(const value of [{ret:-14},{errcode:-14},{ret:0,errcode:-14}])assert.equal(authorizationStatusForPoll(value).lastError,'CLAWBOT_WEIXIN_REAUTHORIZATION_REQUIRED');
  for(const value of [{ret:401},{errcode:503},{ret:-1,errmsg:'secret token account'}, {ret:'-14'}]){
    const report=authorizationStatusForPoll(value);assert.equal(report.connected,false);
    assert.notEqual(report.lastError,'CLAWBOT_WEIXIN_REAUTHORIZATION_REQUIRED');
    assert.ok(!JSON.stringify(report).includes('secret'));
  }
});
