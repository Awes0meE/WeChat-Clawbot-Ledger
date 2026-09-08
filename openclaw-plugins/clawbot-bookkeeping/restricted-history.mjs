import { createOwnerMcpConnectionResolver } from './mcp-connection.mjs';
import { HISTORY_TOOL_NAME, HISTORY_FAILURE_TEXT, normalizeExpenseHistoryQuery,
  formatExpenseHistory, readExpenseHistoryPayload } from './expense-history.mjs';

const INPUT_KEYS = new Set(['start_time', 'end_time', 'count', 'page', 'keyword', 'category_name',
  'type', 'account_name', 'response_fields']);
const ROW_KEYS = ['time', 'type', 'amount', 'currency', 'category_name', 'account_name', 'comment'];
export const HISTORY_PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['start_time', 'end_time'],
  properties: {
    start_time: { type: 'string', description: '查询起点，带时区的 ISO 8601 时间' },
    end_time: { type: 'string', description: '查询终点，带时区的 ISO 8601 时间' },
    count: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
    page: { type: 'integer', minimum: 1, default: 1 },
    keyword: { type: 'string', maxLength: 255 },
    category_name: { type: 'string', maxLength: 200 },
  },
};

// Use the official MCP SDK for protocol/session negotiation, but constrain its
// transport to this exact loopback endpoint, response budget and call lifetime.
export function createPinnedMcpFetch(url, signal, fetchImpl = globalThis.fetch) {
  return async (input, init = {}) => {
    if ((input instanceof Request ? input.url : String(input)) !== url) throw new Error('Unexpected MCP endpoint');
    const response = await fetchImpl(input, { ...init, redirect: 'error',
      signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal });
    if (!response.body) return response;
    let bytes = 0;
    const body = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > 128_000) { controller.error(new Error('MCP response exceeds limit')); return; }
      controller.enqueue(chunk);
    } }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

async function makeClient(connection, signal, timeout) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'clawbot-restricted-history', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: connection.headers, redirect: 'error' },
    fetch: createPinnedMcpFetch(connection.url, signal),
    reconnectionOptions: { maxRetries: 0 },
  });
  try { await client.connect(transport, { signal, timeout }); }
  catch { await client.close().catch(() => {}); throw new Error('MCP connection unavailable'); }
  return {
    query: (args) => client.callTool({ name: 'query_transactions', arguments: args }, undefined, { signal, timeout }),
    close: async () => {
      // Termination also shares the original deadline, then close local streams.
      try { await transport.terminateSession(); } catch { /* Already expired or unsupported. */ }
      await client.close();
    },
  };
}

export function createRestrictedHistoryTool({ config, pluginConfig, context, deployment,
  readToken, clientFactory = makeClient }) {
  const senderId = context?.requesterSenderId;
  if (context?.senderIsOwner !== true || context?.messageChannel !== 'openclaw-weixin'
    || typeof senderId !== 'string'
    || !config?.commands?.ownerAllowFrom?.includes(`openclaw-weixin:${senderId}`)) return null;
  const identity = Object.freeze({ messageChannel: 'openclaw-weixin', requesterSenderId: senderId });
  const resolveConnection = createOwnerMcpConnectionResolver({ config,
    serverBaseUrl: pluginConfig.serverBaseUrl, mcpTokenPath: pluginConfig.mcpTokenPath, deployment, readToken });
  const timeout = Number.isSafeInteger(pluginConfig.timeoutMs) && pluginConfig.timeoutMs > 0
    ? Math.min(pluginConfig.timeoutMs, 60_000) : 10_000;
  return {
    name: HISTORY_TOOL_NAME, label: '查询支出明细',
    description: '只读查询本人固定 SGD 支出账户的历史明细。时间必须包含时区，每页最多十笔。',
    // OpenClaw validates arguments again after before_tool_call. Its trusted
    // normalizer inserts these fixed fields, so the schema must admit exactly
    // those constants without giving the model a choice of account or type.
    parameters: { ...HISTORY_PARAMETERS, properties: { ...HISTORY_PARAMETERS.properties,
      type: { type: 'string', const: 'expense' },
      account_name: { type: 'string', const: pluginConfig.accountName },
      response_fields: { type: 'string', const: 'time,currency,category_name,account_name,comment' },
    } },
    async execute(_callId, input, abortSignal) {
      let client;
      try {
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).some((key) => !INPUT_KEYS.has(key))) throw new Error('Invalid history parameters');
        for (const [key, max] of [['keyword', 255], ['category_name', 200]]) {
          if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > max)) throw new Error('Invalid filter');
        }
        const query = normalizeExpenseHistoryQuery(input, pluginConfig.accountName);
        const deadline = AbortSignal.timeout(timeout);
        const signal = abortSignal ? AbortSignal.any([deadline, abortSignal]) : deadline;
        signal.throwIfAborted();
        const connection = await resolveConnection(identity);
        if (!connection) throw new Error('Owner connection unavailable');
        client = await clientFactory(connection, signal, timeout);
        const result = await client.query(query);
        signal.throwIfAborted();
        const readable = formatExpenseHistory(result, query, pluginConfig);
        const payload = readExpenseHistoryPayload(result);
        const structuredContent = { total_count: payload.total_count, current_page: payload.current_page,
          total_page: payload.total_page, transactions: payload.transactions.map((row) =>
            Object.fromEntries(ROW_KEYS.filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]]))) };
        // The existing authoritative reply hook consumes this validated data;
        // transaction IDs, credentials and unrelated server fields never escape.
        return { content: [{ type: 'text', text: readable }], details: { structuredContent } };
      } catch {
        return { isError: true, content: [{ type: 'text', text: HISTORY_FAILURE_TEXT }], details: { status: 'error' } };
      } finally { await client?.close().catch(() => {}); }
    },
  };
}
