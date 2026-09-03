import { Type } from 'typebox';
import { createHash } from 'node:crypto';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import { EzBookkeepingApi, SqliteReceiptStore } from './adapter.mjs';
import {
  duplicateResponseText,
  ExpenseRecordingError,
  formatExpenseReceipt,
  recordExpense,
} from './bookkeeping-core.mjs';
import {
  CATEGORY_GUIDE,
  PRIMARY_CATEGORIES,
  normalizeSubcategory,
} from './categories.mjs';

type InboundMessage = {
  channel: string;
  messageId: string;
  content: string;
  timestamp: number;
  observedAt: number;
  timeSource: 'message' | 'received';
};

const TRUSTED_INBOUND_MAX_AGE_MS = 10 * 60 * 1000;

function trustedInboundLookupKey(kind: 'session' | 'sender', value: string) {
  return createHash('sha256').update(`${kind}\u0000${value}`, 'utf8').digest('hex');
}

function trustedInboundLookupKeys({
  sessionKey,
  channel,
  senderId,
}: {
  sessionKey?: string;
  channel?: string;
  senderId?: string;
}) {
  const keys: string[] = [];
  if (sessionKey) keys.push(trustedInboundLookupKey('session', sessionKey));
  if (channel && senderId) {
    keys.push(trustedInboundLookupKey('sender', `${channel}\u0000${senderId}`));
  }
  return keys;
}

function additiveAmountFromMessage(content: string): string | undefined {
  const expression = content.match(/\d+(?:\.\d{1,2})?(?:\s*[+＋]\s*\d+(?:\.\d{1,2})?)+/u)?.[0];
  if (!expression) return undefined;
  const totalCents = expression
    .split(/[+＋]/u)
    .reduce((sum, part) => sum + Math.round(Number(part.trim()) * 100), 0);
  return (totalCents / 100).toFixed(2).replace(/\.00$/u, '').replace(/(\.\d)0$/u, '$1');
}

export default definePluginEntry({
  id: 'clawbot-bookkeeping',
  name: 'Clawbot Bookkeeping',
  description: 'Least-privilege local expense recording',
  register(api) {
    const config = api.pluginConfig ?? {};
    const serverBaseUrl = typeof config.serverBaseUrl === 'string'
      ? config.serverBaseUrl
      : 'http://127.0.0.1:8180';
    const tokenPath = typeof config.tokenPath === 'string'
      ? config.tokenPath
      : 'C:\\Users\\USER\\.openclaw\\secrets\\ezbookkeeping-token.txt';
    const stateDbPath = typeof config.stateDbPath === 'string'
      ? config.stateDbPath
      : 'D:\\Clawbot\\state\\message-receipts.sqlite';
    const accountName = typeof config.accountName === 'string' ? config.accountName : '日常支出';
    const ledgerDisplayName = typeof config.ledgerDisplayName === 'string' ? config.ledgerDisplayName : '日常账本';

    const bookkeepingApi = new EzBookkeepingApi({ serverBaseUrl, tokenPath });
    const receiptStore = new SqliteReceiptStore(stateDbPath);

    api.on('message_received', (event, context) => {
      const sessionKey = context.sessionKey ?? event.sessionKey;
      const messageId = context.messageId ?? event.messageId;
      if (!messageId) return;
      const channel = context.channelId ?? 'unknown';
      const senderId = context.senderId ?? event.senderId ?? event.from;
      api.logger?.info?.(
        `clawbot-bookkeeping: inbound metadata session=${Boolean(sessionKey)} message=${Boolean(messageId)} sender=${Boolean(senderId)} channel=${channel}`,
      );
      const hasMessageTimestamp = Number.isFinite(event.timestamp) && Number(event.timestamp) > 0;
      const observedAt = Date.now();
      const inbound = {
        channel,
        messageId,
        content: String(event.content ?? ''),
        timestamp: hasMessageTimestamp ? Number(event.timestamp) : observedAt,
        observedAt,
        timeSource: hasMessageTimestamp ? 'message' : 'received',
      } satisfies InboundMessage;
      const lookupKeys = trustedInboundLookupKeys({ sessionKey, channel, senderId });
      receiptStore.putTrustedInbound(
        lookupKeys,
        inbound,
        observedAt + TRUSTED_INBOUND_MAX_AGE_MS,
      );
    });

    api.on('gateway_stop', () => {
      receiptStore.close();
    });

    api.registerTool({
      name: 'bookkeeping_health',
      catalogMode: 'direct-only',
      description: '只读检查本地 ezBookkeeping 版本、账户和支出分类数量。',
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        const details = await bookkeepingApi.health();
        return {
          content: [{
            type: 'text',
            text: `ezBookkeeping ${details.version}；账户 ${details.accountCount} 个；支出分类 ${details.primaryExpenseCategoryCount}/${details.secondaryExpenseCategoryCount}。`,
          }],
          details,
        };
      },
    });

    api.registerTool(
      (toolContext) => ({
        name: 'record_expense',
        catalogMode: 'direct-only',
        description: [
          '将当前一条消费消息记为一笔 SGD 支出。必须由你理解用户消息并选择金额、一级和二级分类。',
          '不要把“备注”后的文字放进参数；工具会从可信原始消息中原样提取。',
          '若原始消息未明确标注“备注”，可提供简短且有依据的商户、商品或用途说明；不得编造信息。',
          '超市消费整笔归食品酒水/超市购物；网线归学习进修/数码装备。',
          '早餐、午餐、晚餐、早饭、午饭、晚饭或一般餐饮，二级分类一律使用“早午晚餐”，不要使用“餐饮”“午餐”等非正式名称。',
          '同一消息中的加法金额表示一笔消费总额，例如“6.5+2.5”必须只调用一次并传入“9”。',
          '工具成功后，最终回复只能原样采用工具返回的“已记账”结果；不得展示思考、参数校验、候选分类或重试过程。',
          CATEGORY_GUIDE,
        ].join('\n'),
        parameters: Type.Object({
          amount: Type.String({ pattern: '^(?:0|[1-9]\\d*)(?:\\.\\d{1,2})?$' }),
          primaryCategory: Type.Union(PRIMARY_CATEGORIES.map((value) => Type.Literal(value))),
          subcategory: Type.String({ minLength: 1, maxLength: 20 }),
          comment: Type.Optional(Type.String({ maxLength: 255 })),
        }, { additionalProperties: false }),
        async execute(_id, params) {
          if (toolContext.senderIsOwner !== true) {
            throw new Error('无法确认消息发送者为账本所有者，已拒绝入账。');
          }
          const sessionKey = toolContext.sessionKey;
          const lookupKeys = trustedInboundLookupKeys({
            sessionKey,
            channel: toolContext.messageChannel,
            senderId: toolContext.requesterSenderId,
          });
          const inbound = receiptStore.findTrustedInbound(lookupKeys) as InboundMessage | undefined;
          api.logger?.info?.(
            `clawbot-bookkeeping: tool metadata owner=${toolContext.senderIsOwner === true} session=${Boolean(sessionKey)} requester=${Boolean(toolContext.requesterSenderId)} channel=${toolContext.messageChannel ?? 'none'} durableMatch=${Boolean(inbound)} lookupKeys=${lookupKeys.length}`,
          );
          if (!inbound) {
            throw new Error('缺少当前微信消息的可信元数据，已拒绝入账。');
          }
          if (Date.now() - inbound.observedAt > TRUSTED_INBOUND_MAX_AGE_MS) {
            throw new Error('当前微信消息的可信元数据已过期，已拒绝入账。');
          }
          const normalizedInput = {
            ...params,
            amount: additiveAmountFromMessage(inbound.content) ?? params.amount,
            subcategory: normalizeSubcategory(params.primaryCategory, params.subcategory),
          };
          let result;
          try {
            result = await recordExpense({
              api: bookkeepingApi,
              store: receiptStore,
              input: normalizedInput,
              inbound,
              accountName,
            });
          } catch (error) {
            if (!(error instanceof ExpenseRecordingError)) throw error;
            api.logger?.error?.(
              `clawbot-bookkeeping: ExpenseRecordingError outcome=${error.outcome} message=${error.message}`,
            );
            const unknown = error.outcome === 'unknown';
            return {
              content: [{
                type: 'text',
                text: unknown
                  ? '记账请求已发送，但结果暂时无法确认。请先打开账本核对，不要重复发送这条消费。'
                  : '账本暂时连不上，本次没有写入任何数据，请稍后再试。',
              }],
              details: { status: unknown ? 'unknown' : 'failed' },
            };
          }
          if (result.dedupeStatus === 'unconfirmed') {
            api.logger?.warn?.(
              'clawbot-bookkeeping: ExpenseRecordingError outcome=written_unconfirmed message=expense write confirmed; deduplication persistence is unconfirmed',
            );
          }
          const details = { ...result, currency: 'SGD', timeSource: inbound.timeSource };
          if (result.status === 'duplicate') {
            return {
              content: [{ type: 'text', text: duplicateResponseText(result) }],
              details,
            };
          }
          return {
            content: [{
              type: 'text',
              text: formatExpenseReceipt({
                ledgerDisplayName,
                amountMinor: result.amountMinor,
                primaryCategory: normalizedInput.primaryCategory,
                subcategory: normalizedInput.subcategory,
                comment: result.comment,
                time: result.time,
              }),
            }],
            details,
          };
        },
      }),
      { name: 'record_expense' },
    );
  },
});
