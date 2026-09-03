import test from 'node:test';
import assert from 'node:assert/strict';

import { weixinMessageToMsgContext } from '../dist/src/messaging/inbound.js';

function textMessage(overrides = {}) {
  return {
    message_id: 745418,
    from_user_id: 'owner-user-id',
    create_time_ms: 1_788_385_600_123,
    item_list: [{ type: 1, text_item: { text: 'NTUC购物8.25' } }],
    ...overrides,
  };
}

test('uses the upstream Weixin message_id as the stable OpenClaw message id', () => {
  const first = weixinMessageToMsgContext(textMessage(), 'default');
  const replay = weixinMessageToMsgContext(textMessage(), 'default');

  assert.equal(first.MessageSid, '745418');
  assert.equal(replay.MessageSid, first.MessageSid);
  assert.equal(first.Timestamp, 1_788_385_600_123);
});

test('different Weixin messages keep distinct ids even when text is identical', () => {
  const first = weixinMessageToMsgContext(textMessage({ message_id: 745418 }), 'default');
  const second = weixinMessageToMsgContext(textMessage({ message_id: 745419 }), 'default');

  assert.notEqual(first.MessageSid, second.MessageSid);
});

test('falls back to a generated id only when Weixin omitted message_id', () => {
  const withoutId = textMessage();
  delete withoutId.message_id;

  const context = weixinMessageToMsgContext(withoutId, 'default');

  assert.match(context.MessageSid, /^openclaw-weixin:/);
});
