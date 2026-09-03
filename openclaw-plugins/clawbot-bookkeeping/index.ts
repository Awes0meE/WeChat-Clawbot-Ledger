import { Type } from 'typebox';
import { createHash } from 'node:crypto';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import { EzBookkeepingApi, SqliteReceiptStore } from './adapter.mjs';
import { duplicateResponseText, formatExpenseReceipt, recordExpense } from './bookkeeping-core.mjs';

const PRIMARY_CATEGORIES = [
  '食品酒水', '行车交通', '居家物业', '交流通讯', '衣服饰品', '休闲娱乐',
  '医疗保健', '学习进修', '人情往来', '金融保险', '其他杂项',
] as const;

const SUBCATEGORIES = [
  '早午晚餐', '烟酒茶', '水果零食', '饮料甜品', '超市购物',
  '公共交通', '打车租车', '私家车费用',
  '日常用品', '水电煤气', '房租', '物业管理', '维修保养',
  '座机费', '手机费', '上网费', '邮寄费',
  '衣服裤子', '鞋帽包包', '化妆饰品',
  '运动健身', '交际聚会', '休闲玩乐', '宠物宝贝', '旅游度假',
  '药品费', '保健费', '美容费', '治疗费',
  '数码装备', '书报杂志', '培训进修',
  '送礼请客', '孝敬长辈', '还人钱物', '慈善捐助',
  '银行手续', '投资亏损', '按揭还款', '消费税收', '利息支出', '赔偿罚款',
  '其他支出', '意外丢失', '烂账损失',
] as const;

const CATEGORY_GUIDE = [
  '食品酒水: 早午晚餐、烟酒茶、水果零食、饮料甜品、超市购物',
  '行车交通: 公共交通、打车租车、私家车费用',
  '居家物业: 日常用品、水电煤气、房租、物业管理、维修保养',
  '交流通讯: 座机费、手机费、上网费、邮寄费',
  '衣服饰品: 衣服裤子、鞋帽包包、化妆饰品',
  '休闲娱乐: 运动健身、交际聚会、休闲玩乐、宠物宝贝、旅游度假',
  '医疗保健: 药品费、保健费、美容费、治疗费',
  '学习进修: 数码装备、书报杂志、培训进修',
  '人情往来: 送礼请客、孝敬长辈、还人钱物、慈善捐助',
  '金融保险: 银行手续、投资亏损、按揭还款、消费税收、利息支出、赔偿罚款',
  '其他杂项: 其他支出、意外丢失、烂账损失',
].join('\n');

const SUBCATEGORY_ALIASES = new Map<string, typeof SUBCATEGORIES[number]>([
  ['餐饮', '早午晚餐'],
  ['早餐', '早午晚餐'],
  ['午餐', '早午晚餐'],
  ['晚餐', '早午晚餐'],
  ['早饭', '早午晚餐'],
  ['午饭', '早午晚餐'],
  ['晚饭', '早午晚餐'],
  ['正餐', '早午晚餐'],
]);

function normalizeSubcategory(primaryCategory: string, value: string) {
  const normalized = SUBCATEGORY_ALIASES.get(value) ?? value;
  const guideLine = CATEGORY_GUIDE
    .split('\n')
    .find((line) => line.startsWith(`${primaryCategory}: `));
  const allowed = guideLine
    ?.slice(guideLine.indexOf(': ') + 2)
    .split('、') ?? [];
  if (!allowed.includes(normalized)) {
    throw new Error(`二级分类必须是“${primaryCategory}”下的正式分类名称。`);
  }
  return normalized;
}

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
            api.logger?.error?.(
              `clawbot-bookkeeping: record_expense failed ${error instanceof Error ? error.constructor.name : typeof error}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return {
              content: [{ type: 'text', text: '账本暂时连不上，本次没有写入任何数据，请稍后再试。' }],
              details: { status: 'failed' },
            };
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
