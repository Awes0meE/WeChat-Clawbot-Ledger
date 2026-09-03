import { Type } from 'typebox';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import {
  EzBookkeepingApi,
  SqliteReceiptStore,
  trustedInboundMessageKey,
} from './adapter.mjs';
import {
  duplicateResponseText,
  ExpenseRecordingError,
  formatExpenseReceipt,
  recordExpense,
} from './bookkeeping-core.mjs';
import {
  CATEGORY_GUIDE,
  PRIMARY_CATEGORIES,
  SUBCATEGORIES,
  normalizeSubcategory,
} from './categories.mjs';
import {
  aggregateExpenseSummary,
  formatExpenseSummary,
  resolveExpenseRange,
} from './expense-summary.mjs';
import { createOwnerMcpConnectionResolver } from './mcp-connection.mjs';

type InboundMessage = {
  channel: string;
  messageId: string;
  content: string;
  timestamp: number;
  observedAt: number;
  timeSource: 'message' | 'received';
};

type SummaryParams = {
  period: 'today' | 'this_week' | 'this_month' | 'last_month' | 'this_year';
  primaryCategory?: string;
  subcategory?: string;
  keyword?: string;
} | {
  period: 'custom';
  startDate: string;
  endDate: string;
  primaryCategory?: string;
  subcategory?: string;
  keyword?: string;
};

type RecordExpenseParams = {
  amount: string;
  primaryCategory: string;
  subcategory: string;
  comment?: string;
};

type RecordExpenseResult = {
  status: 'created' | 'duplicate';
  dedupeStatus?: 'unconfirmed';
  [key: string]: unknown;
} & ({
  status: 'created';
  amountMinor: number;
  comment: string;
  time: number;
} | {
  status: 'duplicate';
  previousStatus: string;
  transactionId?: string;
});

const TRUSTED_INBOUND_MAX_AGE_MS = 10 * 60 * 1000;
const TOOL_CALL_SLOT_RETENTION_MS = TRUSTED_INBOUND_MAX_AGE_MS;

function trustedInboundLookupKey(kind: 'session' | 'sender' | 'run', value: string) {
  return createHash('sha256').update(`${kind}\u0000${value}`, 'utf8').digest('hex');
}

function transientBindingKey(kind: 'run' | 'tool-call', value: string) {
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

function documentedCategoryId(value: unknown): string | undefined {
  if ((typeof value !== 'string' && typeof value !== 'number')
    || (typeof value === 'number' && !Number.isFinite(value))
    || String(value).trim() === '') return undefined;
  return String(value);
}

function categoryMaps(categories: unknown[]) {
  const primaryByCategoryId = new Map<string, string>();
  const categoryNameById = new Map<string, string>();
  for (const category of categories) {
    if (!category || typeof category !== 'object') continue;
    const primary = category as { id?: unknown; name?: unknown; subCategories?: unknown };
    const primaryId = documentedCategoryId(primary.id);
    if (!primaryId || typeof primary.name !== 'string') continue;
    primaryByCategoryId.set(primaryId, primary.name);
    categoryNameById.set(primaryId, primary.name);
    if (!Array.isArray(primary.subCategories)) continue;
    for (const subcategory of primary.subCategories) {
      if (!subcategory || typeof subcategory !== 'object') continue;
      const child = subcategory as { id?: unknown; name?: unknown };
      const childId = documentedCategoryId(child.id);
      if (!childId || typeof child.name !== 'string') continue;
      primaryByCategoryId.set(childId, primary.name);
      categoryNameById.set(childId, child.name);
    }
  }
  return { primaryByCategoryId, categoryNameById };
}

const SUMMARY_FILTER_PROPERTIES = {
  primaryCategory: Type.Optional(Type.Union(PRIMARY_CATEGORIES.map((value) => Type.Literal(value)))),
  subcategory: Type.Optional(Type.Union(SUBCATEGORIES.map((value) => Type.Literal(value)))),
  keyword: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
};

const SUMMARY_PARAMETERS = Type.Union([
  Type.Object({
    period: Type.Union([
      Type.Literal('today'),
      Type.Literal('this_week'),
      Type.Literal('this_month'),
      Type.Literal('last_month'),
      Type.Literal('this_year'),
    ]),
    ...SUMMARY_FILTER_PROPERTIES,
  }, { additionalProperties: false }),
  Type.Object({
    period: Type.Literal('custom'),
    startDate: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    endDate: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    ...SUMMARY_FILTER_PROPERTIES,
  }, { additionalProperties: false }),
]);

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
      : join(homedir(), '.openclaw', 'secrets', 'ezbookkeeping-token.txt');
    const mcpTokenPath = typeof config.mcpTokenPath === 'string'
      ? config.mcpTokenPath
      : join(homedir(), '.openclaw', 'secrets', 'ezbookkeeping-mcp-token.txt');
    const stateDbPath = typeof config.stateDbPath === 'string'
      ? config.stateDbPath
      : 'D:\\Clawbot\\state\\message-receipts.sqlite';
    const accountName = typeof config.accountName === 'string' ? config.accountName : '日常支出';
    const ledgerDisplayName = typeof config.ledgerDisplayName === 'string' ? config.ledgerDisplayName : '日常账本';
    const requestTimeoutMs = (config.requestTimeoutMs === undefined ? 10_000 : config.requestTimeoutMs) as number;

    const bookkeepingApi = new EzBookkeepingApi({ serverBaseUrl, tokenPath, requestTimeoutMs });
    const receiptStore = new SqliteReceiptStore(stateDbPath);
    const preparedRuns = new Set<string>();
    const inboundByRun = new Map<string, InboundMessage>();
    const toolCallSlots = new Map<string, {
      runKey: string;
      inbound?: InboundMessage;
      ambiguous: boolean;
      touchedAt: number;
    }>();
    const pruneExpiredToolCallSlots = (now = Date.now()) => {
      for (const [toolCallKey, slot] of toolCallSlots) {
        if (now - slot.touchedAt > TOOL_CALL_SLOT_RETENTION_MS) {
          toolCallSlots.delete(toolCallKey);
        }
      }
    };

    api.registerMcpServerConnectionResolver({
      serverName: 'ezbookkeeping',
      resolve: createOwnerMcpConnectionResolver({
        config: api.config,
        serverBaseUrl,
        mcpTokenPath,
      }),
    });

    api.on('message_received', (event, context) => {
      const sessionKey = context.sessionKey ?? event.sessionKey;
      const messageId = context.messageId ?? event.messageId;
      if (!messageId) return;
      const channel = context.channelId ?? 'unknown';
      const senderId = context.senderId ?? event.senderId ?? event.from;
      api.logger?.info?.(
        `clawbot-bookkeeping: inbound metadata session=${Boolean(sessionKey)} message=${Boolean(messageId)} sender=${Boolean(senderId)} channel=${Boolean(channel)}`,
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
      const runId = context.runId ?? event.runId;
      if (runId) lookupKeys.push(trustedInboundLookupKey('run', runId));
      receiptStore.enqueueTrustedInbound(
        lookupKeys,
        trustedInboundMessageKey(channel, messageId),
        inbound,
        observedAt + TRUSTED_INBOUND_MAX_AGE_MS,
      );
    });

    api.on('before_agent_run', (event, context) => {
      const runId = context.runId;
      const runKey = runId ? transientBindingKey('run', runId) : undefined;
      if (runKey && preparedRuns.has(runKey)) return;
      if (runKey) preparedRuns.add(runKey);

      const channel = context.channel ?? context.channelId ?? event.channelId;
      const senderId = context.senderId ?? event.senderId;
      const fallbackKeys = channel && senderId
        ? trustedInboundLookupKeys({
          sessionKey: context.sessionKey,
          channel,
          senderId,
        })
        : [];
      const inbound = runId
        ? receiptStore.claimTrustedInbound([trustedInboundLookupKey('run', runId)]) as InboundMessage | undefined
        : undefined;

      if (!inbound && fallbackKeys.length > 0) {
        // Consume but never bind an inbound that cannot be correlated to this exact run.
        receiptStore.claimTrustedInbound(fallbackKeys);
      }
      if (inbound && runKey && event.senderIsOwner === true) {
        inboundByRun.set(runKey, inbound);
      }
    });

    api.on('before_tool_call', (event, context) => {
      if (event.toolName !== 'record_expense') return;
      const now = Date.now();
      pruneExpiredToolCallSlots(now);
      const runId = context.runId ?? event.runId;
      const toolCallId = context.toolCallId ?? event.toolCallId;
      if (!runId || !toolCallId || context.requester?.senderIsOwner !== true) return;
      const runKey = transientBindingKey('run', runId);
      const toolCallKey = transientBindingKey('tool-call', toolCallId);
      const existingSlot = toolCallSlots.get(toolCallKey);
      if (existingSlot) {
        if (existingSlot.runKey !== runKey) {
          existingSlot.ambiguous = true;
          existingSlot.touchedAt = now;
          delete existingSlot.inbound;
          inboundByRun.delete(runKey);
        }
        return;
      }
      const inbound = inboundByRun.get(runKey);
      toolCallSlots.set(toolCallKey, {
        runKey,
        ...(inbound ? { inbound } : {}),
        ambiguous: false,
        touchedAt: now,
      });
      if (inbound) inboundByRun.delete(runKey);
    });

    api.on('agent_end', (event, context) => {
      const now = Date.now();
      pruneExpiredToolCallSlots(now);
      const runId = context.runId ?? event.runId;
      if (!runId) return;
      const runKey = transientBindingKey('run', runId);
      preparedRuns.delete(runKey);
      inboundByRun.delete(runKey);
      for (const slot of toolCallSlots.values()) {
        if (slot.runKey === runKey) {
          delete slot.inbound;
          slot.touchedAt = now;
        }
      }
    });

    api.on('gateway_stop', () => {
      preparedRuns.clear();
      inboundByRun.clear();
      toolCallSlots.clear();
      receiptStore.close();
    });

    api.registerTool({
      name: 'bookkeeping_health',
      label: 'Bookkeeping health',
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
        name: 'summarize_expenses',
        label: 'Summarize expenses',
        catalogMode: 'direct-only',
        description: '权威的确定性本地账本查询：按时间、分类或关键词汇总 SGD 支出总额、笔数、分类和最大三笔；不会写入账本。',
        parameters: SUMMARY_PARAMETERS,
        async execute(_id, params: SummaryParams) {
          if (toolContext.senderIsOwner !== true) {
            throw new Error('无法确认消息发送者为账本 owner，已拒绝查询。');
          }
          if (params.subcategory !== undefined && params.primaryCategory === undefined) {
            throw new Error('二级分类查询必须同时指定一级分类。');
          }
          const subcategory = params.subcategory === undefined
            ? undefined
            : normalizeSubcategory(params.primaryCategory, params.subcategory);
          const keyword = params.keyword?.trim();
          if (params.keyword !== undefined && !keyword) {
            throw new Error('查询关键词不能为空白。');
          }
          const range = resolveExpenseRange(params);

          try {
            const accountId = await bookkeepingApi.resolveAccountId(accountName);
            const categories = await bookkeepingApi.listExpenseCategories();
            const categoryId = await bookkeepingApi.resolveExpenseCategoryFilterId(
              params.primaryCategory,
              subcategory,
              categories,
            );
            const transactions = await bookkeepingApi.listExpenseTransactions({
              accountId,
              startTime: range.startTime,
              endTime: range.endTime,
              categoryId,
              keyword,
            });
            const { primaryByCategoryId, categoryNameById } = categoryMaps(categories);
            const summary = aggregateExpenseSummary(transactions, primaryByCategoryId, categoryNameById);
            return {
              content: [{ type: 'text', text: formatExpenseSummary(range.label, summary) }],
              details: { status: 'ok', ...range, ...summary },
            };
          } catch (error) {
            const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
            api.logger?.error?.(`clawbot-bookkeeping: expense summary read failed errorClass=${errorClass}`);
            return {
              content: [{ type: 'text', text: '账本暂时连不上，本次没有读取任何数据，请稍后再试。' }],
              details: { status: 'failed' },
            };
          }
        },
      }),
      { name: 'summarize_expenses' },
    );

    api.registerTool(
      (toolContext) => {
        api.logger?.info?.(
          `clawbot-bookkeeping: tool metadata owner=${toolContext.senderIsOwner === true} session=${Boolean(toolContext.sessionKey)} requester=${Boolean(toolContext.requesterSenderId)} channel=${Boolean(toolContext.messageChannel)}`,
        );
        return {
          name: 'record_expense',
          label: 'Record expense',
          catalogMode: 'direct-only',
          description: [
            '将当前一条消费消息记为一笔 SGD 支出。必须由你理解用户消息并选择金额、一级和二级分类。',
            '不要把“备注”后的文字放进参数；工具会从可信原始消息中原样提取。',
            '若原始消息未明确标注“备注”，可提供简短且有依据的商户、商品或用途说明；不得编造信息。',
            '超市消费整笔归食品酒水/超市购物；网线归学习进修/数码装备。',
            '早餐、午餐、晚餐、早饭、午饭、晚饭或一般餐饮，二级分类一律使用“早午晚餐”，不要使用“餐饮”“午餐”等非正式名称。',
            '同一消息中的加法金额表示一笔消费总额，例如“6.5+2.5”必须只调用一次并传入“9”。',
            '裸商户加金额不一定能证明本人已支出；遇到“麦当劳7.2”等未授权简写时不得调用或重试本工具，应请用户重发“记账：麦当劳7.2”或“我在麦当劳花了7.2”。',
            '显式“记账：…”可以确认商户简写，但不能覆盖否定、举例、转述、代付、退款/收款等非支出语义；“记账：不要记午饭7.2”仍不得调用本工具。',
            '只有“能帮我记午饭7.2吗”这类明确祈使记账句可带疑问后缀；“午饭7.2吗”或“我在麦当劳花了7.2吗”不得调用本工具。',
            '工具成功后，最终回复只能原样采用工具返回的“已记账”结果；不得展示思考、参数校验、候选分类或重试过程。',
            CATEGORY_GUIDE,
          ].join('\n'),
          parameters: Type.Object({
            amount: Type.String({ pattern: '^(?:0|[1-9]\\d*)(?:\\.\\d{1,2})?$' }),
            primaryCategory: Type.Union(PRIMARY_CATEGORIES.map((value) => Type.Literal(value))),
            subcategory: Type.String({ minLength: 1, maxLength: 20 }),
            comment: Type.Optional(Type.String({ maxLength: 255 })),
          }, { additionalProperties: false }),
          async execute(_id, params: RecordExpenseParams) {
            pruneExpiredToolCallSlots();
            if (toolContext.senderIsOwner !== true) {
              throw new Error('无法确认消息发送者为账本所有者，已拒绝入账。');
            }
            const toolCallKey = typeof _id === 'string'
              ? transientBindingKey('tool-call', _id)
              : undefined;
            const slot = toolCallKey ? toolCallSlots.get(toolCallKey) : undefined;
            const inbound = slot?.ambiguous === false ? slot.inbound : undefined;
            if (slot) delete slot.inbound;
            if (!slot || !inbound || !toolCallKey) {
              throw new Error('缺少当前微信消息的可信元数据，已拒绝入账。');
            }
            const boundRunKey = slot.runKey;
            if (Date.now() - inbound.observedAt > TRUSTED_INBOUND_MAX_AGE_MS) {
              throw new Error('当前微信消息的可信元数据已过期，已拒绝入账。');
            }
            const normalizedInput = {
              ...params,
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
                validateBeforeWrite: () => toolCallSlots.get(toolCallKey) === slot
                  && slot.runKey === boundRunKey
                  && slot.ambiguous === false,
              }) as RecordExpenseResult;
            } catch (error) {
              if (!(error instanceof ExpenseRecordingError)) throw error;
              api.logger?.error?.(
                `clawbot-bookkeeping: ExpenseRecordingError outcome=${error.outcome} message=${error.message}`,
              );
              if (error.dedupeStatus === 'unconfirmed') {
                api.logger?.warn?.(
                  `clawbot-bookkeeping: ExpenseRecordingError outcome=${error.outcome} deduplication persistence is unconfirmed`,
                );
              }
              const unknown = error.outcome === 'unknown';
              const rejected = error.outcome === 'rejected';
              return {
                content: [{
                  type: 'text',
                  text: rejected
                    ? '这条消息无法确认是一笔金额一致的已发生消费，本次没有入账。请用“记账：麦当劳7.2”或“我在麦当劳花了7.2”的明确句式重新发送。'
                    : unknown
                      ? '记账请求已发送，但结果暂时无法确认。请先打开账本核对，不要重复发送这条消费。'
                      : '账本暂时连不上，本次没有写入任何数据，请稍后再试。',
                }],
                details: {
                  status: rejected ? 'rejected' : unknown ? 'unknown' : 'failed',
                  ...(error.dedupeStatus === undefined ? {} : { dedupeStatus: error.dedupeStatus }),
                },
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
        };
      },
      { name: 'record_expense' },
    );
  },
});
