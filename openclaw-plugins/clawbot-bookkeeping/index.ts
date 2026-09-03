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
  formatExpenseConfirmation,
  formatExpenseReceipt,
  prepareExpenseConfirmation,
  recordConfirmedExpense,
  recordExpense,
  requiresExpenseConfirmation,
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
  conversationKey: string;
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

type ResolveExpenseConfirmationParams = {
  decision: 'confirm' | 'cancel';
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
const PENDING_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const TOOL_CALL_SLOT_RETENTION_MS = TRUSTED_INBOUND_MAX_AGE_MS;
const AUTHORITATIVE_REPLY_MAX_AGE_MS = TRUSTED_INBOUND_MAX_AGE_MS;
const EXPENSE_TOOL_NAMES = new Set([
  'record_expense',
  'prepare_expense',
  'resolve_expense_confirmation',
]);
const AUTHORITATIVE_REPLY_TOOL_NAMES = new Set([
  ...EXPENSE_TOOL_NAMES,
  'summarize_expenses',
]);
const AFFIRMATIVE_REPLIES = new Set(['是', '对', '对的', '确认', '嗯', '嗯嗯', '好', '好的', '可以', '记吧', '记下吧']);
const NEGATIVE_REPLIES = new Set(['不是', '否', '不对', '取消', '不用', '别记', '不要']);

function trustedInboundLookupKey(kind: 'session' | 'sender' | 'run', value: string) {
  return createHash('sha256').update(`${kind}\u0000${value}`, 'utf8').digest('hex');
}

function transientBindingKey(kind: 'run' | 'tool-call', value: string) {
  return createHash('sha256').update(`${kind}\u0000${value}`, 'utf8').digest('hex');
}

function trustedConversationKey({
  sessionKey,
  channel,
  accountId,
  senderId,
}: {
  sessionKey?: string;
  channel?: string;
  accountId?: string;
  senderId?: string;
}) {
  if (!channel || !senderId) return undefined;
  return createHash('sha256')
    .update(`conversation\u0000${channel}\u0000${accountId ?? ''}\u0000${senderId}\u0000${sessionKey ?? ''}`, 'utf8')
    .digest('hex');
}

function confirmationDecision(content: string): 'confirm' | 'cancel' | undefined {
  const normalized = content.trim();
  if (AFFIRMATIVE_REPLIES.has(normalized)) return 'confirm';
  if (NEGATIVE_REPLIES.has(normalized)) return 'cancel';
  return undefined;
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

const EXPENSE_PARAMETERS = Type.Object({
  amount: Type.String({ pattern: '^(?:0|[1-9]\\d*)(?:\\.\\d{1,2})?$' }),
  primaryCategory: Type.Union(PRIMARY_CATEGORIES.map((value) => Type.Literal(value))),
  subcategory: Type.String({ minLength: 1, maxLength: 20 }),
  comment: Type.Optional(Type.String({ maxLength: 255 })),
}, { additionalProperties: false });

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
    const authoritativeRepliesByRun = new Map<string, { text: string; touchedAt: number }>();
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
      for (const [runKey, reply] of authoritativeRepliesByRun) {
        if (now - reply.touchedAt > AUTHORITATIVE_REPLY_MAX_AGE_MS) {
          authoritativeRepliesByRun.delete(runKey);
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
      const accountId = context.accountId;
      const conversationKey = trustedConversationKey({ sessionKey, channel, accountId, senderId });
      if (!conversationKey) return;
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
        conversationKey,
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
        if (confirmationDecision(inbound.content) === undefined) {
          receiptStore.discardPendingExpenseConfirmation(inbound.conversationKey);
        }
        inboundByRun.set(runKey, inbound);
      }
    });

    api.on('before_tool_call', (event, context) => {
      if (!EXPENSE_TOOL_NAMES.has(event.toolName)) return;
      const now = Date.now();
      pruneExpiredToolCallSlots(now);
      const runId = context.runId ?? event.runId;
      const toolCallId = context.toolCallId ?? event.toolCallId;
      if (!runId || !toolCallId) return;
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

    api.on('after_tool_call', (event, context) => {
      if (!AUTHORITATIVE_REPLY_TOOL_NAMES.has(event.toolName) || event.error) return;
      const runId = context.runId ?? event.runId;
      if (!runId || !event.result || typeof event.result !== 'object') return;
      const content = (event.result as { content?: unknown }).content;
      if (!Array.isArray(content)) return;
      const text = content.find((item) => item
        && typeof item === 'object'
        && (item as { type?: unknown }).type === 'text'
        && typeof (item as { text?: unknown }).text === 'string') as { text: string } | undefined;
      if (!text) return;
      const runKey = transientBindingKey('run', runId);
      if (authoritativeRepliesByRun.has(runKey)) return;
      authoritativeRepliesByRun.set(runKey, {
        text: text.text,
        touchedAt: Date.now(),
      });
    });

    api.on('reply_payload_sending', (event, context) => {
      if (event.kind !== 'final') return;
      pruneExpiredToolCallSlots();
      const runId = context.runId ?? event.runId;
      const runKey = runId ? transientBindingKey('run', runId) : undefined;
      const authoritative = runKey ? authoritativeRepliesByRun.get(runKey) : undefined;
      if (!runKey || !authoritative) return;
      authoritativeRepliesByRun.delete(runKey);
      return {
        payload: {
          ...event.payload,
          text: authoritative.text,
        },
      };
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
      authoritativeRepliesByRun.clear();
      receiptStore.close();
    });

    const takeToolCallBinding = (_id: unknown) => {
      pruneExpiredToolCallSlots();
      const toolCallKey = typeof _id === 'string'
        ? transientBindingKey('tool-call', _id)
        : undefined;
      const slot = toolCallKey ? toolCallSlots.get(toolCallKey) : undefined;
      const inbound = slot?.ambiguous === false ? slot.inbound : undefined;
      if (slot) delete slot.inbound;
      if (!slot || !inbound || !toolCallKey) {
        throw new Error('缺少当前微信消息的可信元数据，已拒绝操作账本。');
      }
      if (Date.now() - inbound.observedAt > TRUSTED_INBOUND_MAX_AGE_MS) {
        throw new Error('当前微信消息的可信元数据已过期，已拒绝操作账本。');
      }
      const boundRunKey = slot.runKey;
      return {
        inbound,
        isStillAuthorized: () => toolCallSlots.get(toolCallKey) === slot
          && slot.runKey === boundRunKey
          && slot.ambiguous === false,
      };
    };

    const expenseFailureResponse = (error: ExpenseRecordingError) => {
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
          type: 'text' as const,
          text: rejected
            ? '这条消息的金额与当前请求不一致，或仍带有疑问，本次没有入账。'
            : unknown
              ? '记账请求已发送，但结果暂时无法确认。请先打开账本核对，不要重复发送这条消费。'
              : '账本暂时连不上，本次没有写入任何数据，请稍后再试。',
        }],
        details: {
          status: rejected ? 'rejected' : unknown ? 'unknown' : 'failed',
          ...(error.dedupeStatus === undefined ? {} : { dedupeStatus: error.dedupeStatus }),
        },
      };
    };

    const recordedExpenseResponse = (
      result: RecordExpenseResult,
      input: RecordExpenseParams,
      inbound: InboundMessage,
    ) => {
      if (result.dedupeStatus === 'unconfirmed') {
        api.logger?.warn?.(
          'clawbot-bookkeeping: ExpenseRecordingError outcome=written_unconfirmed message=expense write confirmed; deduplication persistence is unconfirmed',
        );
      }
      const details = { ...result, currency: 'SGD', timeSource: inbound.timeSource };
      if (result.status === 'duplicate') {
        return {
          content: [{ type: 'text' as const, text: duplicateResponseText(result) }],
          details,
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: formatExpenseReceipt({
            ledgerDisplayName,
            amountMinor: result.amountMinor,
            primaryCategory: input.primaryCategory,
            subcategory: input.subcategory,
            comment: result.comment,
            time: result.time,
          }),
        }],
        details,
      };
    };

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
            '将当前明确、已发生的一条消费消息记为一笔 SGD 支出。由你理解语义并选择金额、一级和二级分类。',
            '不要把“备注”后的文字放进参数；工具会从可信原始消息中原样提取。',
            '若原始消息未明确标注“备注”，可提供简短且有依据的商户、商品或用途说明；不得编造信息。',
            '超市消费整笔归食品酒水/超市购物；网线归学习进修/数码装备。',
            '早餐、午餐、晚餐、早饭、午饭、晚饭或一般餐饮，二级分类一律使用“早午晚餐”，不要使用“餐饮”“午餐”等非正式名称。',
            '同一消息中的加法金额表示一笔消费总额，例如“6.5+2.5”必须只调用一次并传入“9”。',
            '如果消息像“午饭7.2吗”一样含有不确定或疑问语气，不要调用本工具，改用 prepare_expense。',
            '否定、举例、转述、代付、退款、收款、未来计划或查询不是已发生的本人支出；正常对话或查询即可，不要调用写入工具。',
            '工具成功后，最终回复只能原样采用工具返回的“已记账”结果；不得展示思考、参数校验、候选分类或重试过程。',
            CATEGORY_GUIDE,
          ].join('\n'),
          parameters: EXPENSE_PARAMETERS,
          async execute(_id, params: RecordExpenseParams) {
            if (toolContext.senderIsOwner !== true) {
              throw new Error('无法确认消息发送者为账本所有者，已拒绝入账。');
            }
            const { inbound, isStillAuthorized } = takeToolCallBinding(_id);
            const normalizedInput = {
              ...params,
              subcategory: normalizeSubcategory(params.primaryCategory, params.subcategory),
            };
            if (requiresExpenseConfirmation(inbound.content)) {
              let candidate;
              try {
                candidate = prepareExpenseConfirmation({ input: normalizedInput, inbound });
              } catch (error) {
                if (!(error instanceof ExpenseRecordingError)) throw error;
                return expenseFailureResponse(error);
              }
              if (!isStillAuthorized()) {
                throw new Error('当前微信消息的可信绑定已变化，本次没有准备入账。');
              }
              receiptStore.replacePendingExpenseConfirmation(
                inbound.conversationKey,
                {
                  sourceMessageKey: trustedInboundMessageKey(inbound.channel, inbound.messageId),
                  sourceInbound: inbound,
                  input: normalizedInput,
                },
                Date.now() + PENDING_CONFIRMATION_TTL_MS,
              );
              return {
                content: [{
                  type: 'text',
                  text: formatExpenseConfirmation({
                    ledgerDisplayName,
                    amountMinor: candidate.amountMinor,
                    primaryCategory: normalizedInput.primaryCategory,
                    subcategory: normalizedInput.subcategory,
                    comment: candidate.comment,
                    time: candidate.time,
                  }),
                }],
                details: {
                  status: 'pending_confirmation',
                  currency: 'SGD',
                  timeSource: inbound.timeSource,
                  expiresInSeconds: PENDING_CONFIRMATION_TTL_MS / 1000,
                },
              };
            }
            let result;
            try {
              result = await recordExpense({
                api: bookkeepingApi,
                store: receiptStore,
                input: normalizedInput,
                inbound,
                accountName,
                validateBeforeWrite: isStillAuthorized,
              }) as RecordExpenseResult;
            } catch (error) {
              if (!(error instanceof ExpenseRecordingError)) throw error;
              return expenseFailureResponse(error);
            }
            return recordedExpenseResponse(result, normalizedInput, inbound);
          },
        };
      },
      { name: 'record_expense' },
    );

    api.registerTool(
      (toolContext) => ({
        name: 'prepare_expense',
        label: 'Prepare expense confirmation',
        catalogMode: 'direct-only',
        description: [
          '为包含明确金额、但语义仍需用户确认的一笔候选支出生成确认单；本工具绝不会写入账本。',
          '例如“午饭7.2吗”应使用本工具，让用户确认你的金额、分类、备注和原消息时间理解。',
          '金额、分类和备注由你根据当前消息理解；不得猜测消息中没有的信息。',
          '工具返回后只逐字回复确认单，不展示思考、参数或工具名。',
          CATEGORY_GUIDE,
        ].join('\n'),
        parameters: EXPENSE_PARAMETERS,
        async execute(_id, params: RecordExpenseParams) {
          if (toolContext.senderIsOwner !== true) {
            throw new Error('无法确认消息发送者为账本所有者，已拒绝准备入账。');
          }
          const { inbound, isStillAuthorized } = takeToolCallBinding(_id);
          const normalizedInput = {
            ...params,
            subcategory: normalizeSubcategory(params.primaryCategory, params.subcategory),
          };
          let candidate;
          try {
            candidate = prepareExpenseConfirmation({ input: normalizedInput, inbound });
          } catch (error) {
            if (!(error instanceof ExpenseRecordingError)) throw error;
            return expenseFailureResponse(error);
          }
          if (!isStillAuthorized()) {
            throw new Error('当前微信消息的可信绑定已变化，本次没有准备入账。');
          }
          receiptStore.replacePendingExpenseConfirmation(
            inbound.conversationKey,
            {
              sourceMessageKey: trustedInboundMessageKey(inbound.channel, inbound.messageId),
              sourceInbound: inbound,
              input: normalizedInput,
            },
            Date.now() + PENDING_CONFIRMATION_TTL_MS,
          );
          return {
            content: [{
              type: 'text',
              text: formatExpenseConfirmation({
                ledgerDisplayName,
                amountMinor: candidate.amountMinor,
                primaryCategory: normalizedInput.primaryCategory,
                subcategory: normalizedInput.subcategory,
                comment: candidate.comment,
                time: candidate.time,
              }),
            }],
            details: {
              status: 'pending_confirmation',
              currency: 'SGD',
              timeSource: inbound.timeSource,
              expiresInSeconds: PENDING_CONFIRMATION_TTL_MS / 1000,
            },
          };
        },
      }),
      { name: 'prepare_expense' },
    );

    api.registerTool(
      (toolContext) => ({
        name: 'resolve_expense_confirmation',
        label: 'Resolve expense confirmation',
        catalogMode: 'direct-only',
        description: [
          '处理用户对上一张待确认支出单独回复的确认或取消。',
          '只有当前消息本身是简短确认词或取消词时才调用；不要传金额、分类或备注。',
          '用户发送其他新内容时，按新请求正常处理，不要调用本工具。',
          '工具返回后只逐字回复结果，不展示思考、参数或工具名。',
        ].join('\n'),
        parameters: Type.Object({
          decision: Type.Union([Type.Literal('confirm'), Type.Literal('cancel')]),
        }, { additionalProperties: false }),
        async execute(_id, params: ResolveExpenseConfirmationParams) {
          if (toolContext.senderIsOwner !== true) {
            throw new Error('无法确认消息发送者为账本所有者，已拒绝处理确认。');
          }
          const { inbound, isStillAuthorized } = takeToolCallBinding(_id);
          const trustedDecision = confirmationDecision(inbound.content);
          if (trustedDecision === undefined || trustedDecision !== params.decision) {
            return {
              content: [{ type: 'text', text: '当前回复不是有效的确认或取消，本次没有操作账本。' }],
              details: { status: 'rejected' },
            };
          }
          if (!isStillAuthorized()) {
            throw new Error('当前微信消息的可信绑定已变化，本次没有操作账本。');
          }
          const pending = receiptStore.takePendingExpenseConfirmation(inbound.conversationKey);
          if (pending.status === 'missing') {
            return {
              content: [{ type: 'text', text: '现在没有等待确认的支出，不用担心，我没有记账。' }],
              details: { status: 'missing' },
            };
          }
          if (pending.status === 'expired') {
            return {
              content: [{ type: 'text', text: '刚才那笔待确认支出已经过期，我没有记账；需要的话请重新发一次。' }],
              details: { status: 'expired' },
            };
          }
          if (params.decision === 'cancel') {
            return {
              content: [{ type: 'text', text: '好哒，已经取消，这笔没有记到账本里。' }],
              details: { status: 'cancelled' },
            };
          }
          const proposal = pending.proposal;
          if (proposal.sourceMessageKey !== trustedInboundMessageKey(
            proposal.sourceInbound.channel,
            proposal.sourceInbound.messageId,
          )) {
            throw new Error('待确认支出的可信消息标识不一致，已拒绝入账。');
          }
          let result;
          try {
            result = await recordConfirmedExpense({
              api: bookkeepingApi,
              store: receiptStore,
              input: proposal.input,
              inbound: proposal.sourceInbound,
              accountName,
              validateBeforeWrite: isStillAuthorized,
            }) as RecordExpenseResult;
          } catch (error) {
            if (!(error instanceof ExpenseRecordingError)) throw error;
            return expenseFailureResponse(error);
          }
          return recordedExpenseResponse(result, proposal.input, proposal.sourceInbound);
        },
      }),
      { name: 'resolve_expense_confirmation' },
    );
  },
});
