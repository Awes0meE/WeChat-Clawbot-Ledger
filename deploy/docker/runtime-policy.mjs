export const BOOKKEEPER_TOOLS = Object.freeze(['record_expense', 'prepare_expense',
  'resolve_expense_confirmation', 'summarize_expenses', 'find_expenses', 'ezbookkeeping__query_transactions']);

export function assertBookkeeperRuntimePolicy(config, bootstrapLengths = []) {
  const agent = config?.agents?.entries?.bookkeeper;
  const hooks = config?.plugins?.entries?.['clawbot-bookkeeping']?.hooks;
  const same = (a, b) => Array.isArray(a) && a.length === b.length
    && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (agent?.tools?.profile !== 'full' || !same(agent.tools.allow, BOOKKEEPER_TOOLS)
    || agent.model?.primary !== 'openai/gpt-5.6-sol'
    || agent.models?.['openai/gpt-5.6-sol']?.agentRuntime?.id !== 'codex'
    || agent.thinkingDefault !== 'low' || agent.model?.fallbacks?.length
    || hooks?.allowConversationAccess !== true || hooks?.allowPromptInjection !== true
    || config.plugins.entries.codex?.config?.codexDynamicToolsLoading !== 'direct') {
    throw new Error('CLAWBOT_BOOKKEEPER_RUNTIME_POLICY_INVALID');
  }
  if (!Number.isSafeInteger(agent.bootstrapMaxChars) || !Number.isSafeInteger(agent.bootstrapTotalMaxChars)
    || bootstrapLengths.some((n) => n > agent.bootstrapMaxChars)
    || bootstrapLengths.reduce((a, b) => a + b, 0) > agent.bootstrapTotalMaxChars) {
    throw new Error('CLAWBOT_BOOTSTRAP_WOULD_BE_TRUNCATED');
  }
}
