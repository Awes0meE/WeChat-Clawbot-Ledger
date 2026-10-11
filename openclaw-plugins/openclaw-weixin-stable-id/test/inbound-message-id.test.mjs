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

test('only a single current image carries provider message identity into media facts', () => {
  const opts = { decryptedPicPath: '/synthetic/media/inbound/image.jpg' };
  const direct = weixinMessageToMsgContext(textMessage({ item_list: [{ type: 2 }] }), 'default', opts);
  assert.equal(direct.Body, '');
  assert.deepEqual(direct.media, [{ path: opts.decryptedPicPath, contentType: 'image/*', messageId: '745418' }]);
  const quoted = weixinMessageToMsgContext(textMessage({ item_list: [{ type: 1, text_item: { text: '看之前的图' }, ref_msg: { message_item: { type: 2 } } }] }), 'default', opts);
  assert.equal(quoted.media[0].messageId, undefined);
  const multiple = weixinMessageToMsgContext(textMessage({ item_list: [{ type: 2 }, { type: 2 }] }), 'default', opts);
  assert.equal(multiple.media[0].messageId, undefined);
});
