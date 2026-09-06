import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { after, beforeEach } from 'node:test';

// Exercise the built message pipeline and real slash-command handlers, replacing
// only host services, credentials, network sends and persistent debug state.
const fixtureKey = Symbol.for('clawbot.stable-id.slash-command-authorization');
const fixture = {};
globalThis[fixtureKey] = fixture;
const fixturePrelude = `const fixture = globalThis[Symbol.for('clawbot.stable-id.slash-command-authorization')];\n`;
const modules = new Map();
function replaceModule(specifier, source) {
  const key = specifier.startsWith('openclaw/') ? specifier : new URL(specifier, import.meta.url).href;
  modules.set(key, `data:text/javascript,${encodeURIComponent(fixturePrelude + source)}`);
}

replaceModule('openclaw/plugin-sdk/channel-message', 'export const createTypingCallbacks = () => ({});');
replaceModule('openclaw/plugin-sdk/infra-runtime', 'export const resolvePreferredOpenClawTmpDir = () => "synthetic-tmp";');
replaceModule('openclaw/plugin-sdk/command-auth', `
  export async function resolveSenderCommandAuthorizationWithRuntime(params) {
    const allowFrom = await params.readAllowFromStore();
    const senderAllowedForCommands = params.isSenderAllowed(params.senderId, allowFrom);
    fixture.events.push('authorize');
    fixture.authorizations.push({ senderId: params.senderId, allowFrom, dmPolicy: params.dmPolicy });
    return { senderAllowedForCommands, commandAuthorized: senderAllowedForCommands };
  }
  export function resolveDirectDmAuthorizationOutcome(params) {
    if (params.isGroup) return 'allowed';
    if (params.dmPolicy === 'disabled') return 'disabled';
    return params.senderAllowedForCommands ? 'allowed' : 'unauthorized';
  }
`);
replaceModule('../dist/src/auth/pairing.js', `
  export function readFrameworkAllowFromList() { return [...fixture.allowFrom]; }
`);
replaceModule('../dist/src/auth/accounts.js', `
  export function loadWeixinAccount() {
    fixture.legacyReads += 1;
    return fixture.legacyOwner === undefined ? undefined : { userId: fixture.legacyOwner };
  }
`);
replaceModule('../dist/src/util/logger.js', 'export const logger = { debug() {}, info() {}, warn() {}, error() {} };');
replaceModule('../dist/src/storage/state-dir.js', `
  export function resolveStateDir() { throw new Error('test must not access host state'); }
`);
replaceModule('../dist/src/messaging/debug-mode.js', `
  export const isDebugMode = () => fixture.debugEnabled;
  export function toggleDebugMode() {
    fixture.events.push('toggle-debug');
    fixture.debugEnabled = !fixture.debugEnabled;
    return fixture.debugEnabled;
  }
`);
replaceModule('../dist/src/messaging/send.js', `
  export async function sendMessageWeixin(message) {
    fixture.events.push('send');
    fixture.sent.push(message);
  }
`);
replaceModule('../dist/src/api/api.js', 'export async function sendTyping() {}');
replaceModule('../dist/src/cdn/upload.js', 'export async function downloadRemoteImageToTemp() { throw new Error("unexpected media download"); }');
replaceModule('../dist/src/config/reply-progress.js', 'export const resolveReplyProgressMessagesEnabled = () => false;');
replaceModule('../dist/src/media/media-download.js', `
  export async function downloadMediaFromItem(item) {
    fixture.mediaDownloads.push(item);
    return { decryptedPicPath: 'synthetic-downloaded-image' };
  }
`);
replaceModule('../dist/src/messaging/error-notice.js', 'export async function sendWeixinErrorNotice() { throw new Error("unexpected error notice"); }');
replaceModule('../dist/src/messaging/outbound-hooks.js', `
  export const applyWeixinMessageSendingHook = async ({ text }) => ({ text });
  export function emitWeixinMessageSent() {}
`);
replaceModule('../dist/src/messaging/send-media.js', 'export async function sendWeixinMediaFile() { throw new Error("unexpected media send"); }');
replaceModule('../dist/src/messaging/reply-progress-sender.js', 'export class WeixinReplyProgressSender {}');

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const key = specifier.startsWith('openclaw/')
      ? specifier
      : specifier.startsWith('.') && context.parentURL
        ? new URL(specifier, context.parentURL).href
        : specifier;
    const url = modules.get(key);
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});
const { processOneMessage } = await import('../dist/src/messaging/process-message.js');
hooks.deregister();
after(() => { delete globalThis[fixtureKey]; });

beforeEach(() => {
  Object.assign(fixture, {
    allowFrom: ['synthetic-owner'], legacyOwner: undefined, legacyReads: 0,
    debugEnabled: false, sent: [], events: [], authorizations: [], dispatched: [], mediaDownloads: [],
  });
});

async function processMessage(body, senderId = 'synthetic-owner', mediaItems = []) {
  return processOneMessage({
    message_id: 1001,
    from_user_id: senderId,
    create_time_ms: 1_788_385_600_123,
    item_list: [{ type: 1, text_item: { text: body } }, ...mediaItems],
  }, {
    accountId: 'synthetic-account', config: {}, baseUrl: 'https://invalid.test', cdnBaseUrl: 'https://invalid.test',
    log() {}, errLog() {},
    channelRuntime: {
      commands: {},
      media: { async saveMediaBuffer() { throw new Error('unexpected media save'); } },
      routing: { resolveAgentRoute: () => ({ agentId: 'synthetic-agent', sessionKey: 'synthetic-session' }) },
      session: { resolveStorePath: () => 'synthetic-session-store', async recordInboundSession() {} },
      reply: {
        finalizeInboundContext: (ctx) => ctx,
        resolveHumanDelayConfig: () => ({}),
        createReplyDispatcherWithTyping: () => ({ dispatcher: {}, replyOptions: {}, markDispatchIdle() {} }),
        withReplyDispatcher: async ({ run }) => run(),
        dispatchReplyFromConfig: async ({ ctx }) => { fixture.dispatched.push(ctx); },
      },
    },
  });
}

for (const command of ['/echo synthetic-message', '/toggle-debug']) {
  test(`an unpaired sender cannot execute ${command.split(' ')[0]}`, async () => {
    await processMessage(command, 'synthetic-stranger');
    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.debugEnabled, false);
    assert.equal(fixture.dispatched.length, 0);
    assert.equal(fixture.authorizations.length, 1);
  });

  test(`missing pairing and owner data cannot authorize ${command.split(' ')[0]}`, async () => {
    fixture.allowFrom = [];
    await processMessage(command, 'synthetic-stranger');
    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.debugEnabled, false);
    assert.equal(fixture.dispatched.length, 0);
    assert.equal(fixture.legacyReads, 1);
  });

  for (const ownerSource of ['pairing store', 'legacy owner']) {
    test(`the ${ownerSource} authorizes ${command.split(' ')[0]} before side effects`, async () => {
      if (ownerSource === 'legacy owner') {
        fixture.allowFrom = [];
        fixture.legacyOwner = 'synthetic-owner';
      }
      await processMessage(command);
      assert.equal(fixture.events[0], 'authorize');
      assert.equal(fixture.sent.length, command.startsWith('/echo') ? 2 : 1);
      assert.ok(fixture.sent.every((message) => message.to === 'synthetic-owner'));
      assert.equal(fixture.debugEnabled, command === '/toggle-debug');
      assert.equal(fixture.dispatched.length, 0);
      assert.deepEqual(fixture.authorizations[0], {
        senderId: 'synthetic-owner', allowFrom: ['synthetic-owner'], dmPolicy: 'pairing',
      });
    });
  }
}

test('a paired sender keeps normal framework command routing', async () => {
  await processMessage('/help');
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.debugEnabled, false);
  assert.equal(fixture.dispatched.length, 1);
  assert.equal(fixture.dispatched[0].CommandAuthorized, true);
  assert.equal(fixture.dispatched[0].CommandBody, '/help');
});

test('pairing-store entries remain authoritative over the legacy owner fallback', async () => {
  fixture.legacyOwner = 'former-owner';
  await processMessage('/toggle-debug', 'former-owner');
  assert.equal(fixture.legacyReads, 0);
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.debugEnabled, false);
});

const imageItem = { type: 2, image_item: { media: { full_url: 'https://invalid.test/image' } } };

test('an unpaired sender cannot trigger an inbound media download', async () => {
  await processMessage('synthetic-image', 'synthetic-stranger', [imageItem]);
  assert.equal(fixture.mediaDownloads.length, 0);
  assert.equal(fixture.dispatched.length, 0);
  assert.equal(fixture.sent.length, 0);
});

test('paired media keeps its body, stable identity, attachment and authorization', async () => {
  await processMessage('/help', 'synthetic-owner', [imageItem]);
  assert.equal(fixture.mediaDownloads.length, 1);
  assert.equal(fixture.dispatched.length, 1);
  const [ctx] = fixture.dispatched;
  assert.equal(ctx.Body, '/help');
  assert.equal(ctx.CommandBody, '/help');
  assert.equal(ctx.CommandAuthorized, true);
  assert.equal(ctx.MessageSid, '1001');
  assert.equal(ctx.SenderId, 'synthetic-owner');
  assert.equal(ctx.MediaPath, 'synthetic-downloaded-image');
  assert.equal(ctx.MediaType, 'image/*');
});

test('a locally handled owner command does not download an attached image', async () => {
  await processMessage('/echo synthetic-message', 'synthetic-owner', [imageItem]);
  assert.equal(fixture.mediaDownloads.length, 0);
  assert.equal(fixture.sent.length, 2);
  assert.equal(fixture.dispatched.length, 0);
});
