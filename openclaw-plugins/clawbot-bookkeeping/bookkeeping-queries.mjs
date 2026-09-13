import { aggregateExpenseSummary, formatExpenseSummary, resolveExpenseRange } from './expense-summary.mjs';
import { resolveExpenseSearch, formatExpenseSearch } from './expense-search.mjs';
import { parseAmountToMinorUnits } from './bookkeeping-core.mjs';
import { normalizeSubcategory, CATEGORY_DEFINITIONS } from './categories.mjs';
import { normalizeCurrency, formatCurrencyAmount, convertCurrencyAmount, exchangeRateDescription, exchangeRateSourceText } from './currency.mjs';

const COMMON = ['period', 'startDate', 'endDate', 'currency'];
const ALLOWED = {
  summary: [...COMMON, 'primaryCategory', 'subcategory', 'keyword', 'convertTo'],
  find: [...COMMON, 'amount', 'limit'],
  history: [...COMMON, 'limit', 'keyword'],
  exchange: ['amount', 'fromCurrency', 'toCurrency'],
};

export function normalizeReadQuestion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.hasOwn(ALLOWED, value.kind)
    || Reflect.ownKeys(value).some((key) => key !== 'kind' && !ALLOWED[value.kind].includes(key))) {
    throw new Error('invalid bookkeeping question');
  }
  const q = { ...value };
  if (q.kind === 'find' && q.currency === undefined) q.currency = 'SGD';
  if (q.currency !== undefined) q.currency = normalizeCurrency(q.currency);
  if (q.convertTo !== undefined) {
    if (!Array.isArray(q.convertTo) || !q.convertTo.length || q.convertTo.length > 5) throw new Error('invalid conversion currencies');
    q.convertTo = [...new Set(q.convertTo.map(normalizeCurrency))];
  }
  if (q.kind === 'exchange') {
    q.fromCurrency = normalizeCurrency(q.fromCurrency);
    q.toCurrency = normalizeCurrency(q.toCurrency);
    parseAmountToMinorUnits(q.amount ?? '1');
  } else {
    if (q.kind === 'summary') resolveExpenseRange(q);
    else if (q.period !== undefined && q.period !== 'all') resolveExpenseRange(q);
    if (q.period !== 'custom' && (q.startDate !== undefined || q.endDate !== undefined)) throw new Error('dates require custom period');
    if (q.keyword !== undefined && (typeof q.keyword !== 'string' || !q.keyword.trim() || q.keyword.length > 100)) throw new Error('invalid keyword');
    if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 10)) throw new Error('invalid query limit');
    if (q.subcategory !== undefined) {
      if (q.primaryCategory === undefined) {
        const parents = Object.keys(CATEGORY_DEFINITIONS).filter((primary) => {
          try { normalizeSubcategory(primary, q.subcategory); return true; } catch { return false; }
        });
        if (parents.length !== 1) throw new Error('query subcategory requires an unambiguous parent');
        q.primaryCategory = parents[0];
      }
      q.subcategory = normalizeSubcategory(q.primaryCategory, q.subcategory);
    }
    if (q.kind === 'find') resolveExpenseSearch({ ...Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'kind')), currency: q.currency ?? 'SGD' });
  }
  return q;
}

// Some model tool clients repeat the single-question fields beside questions.
// Accept only exact redundant copies; conflicts and multi-question defaults fail.
export function questionsFromSummaryParams(params) {
  const questions = params.questions;
  if (!Array.isArray(questions) || !questions.length || questions.length > 8) throw new Error('one to eight questions required');
  for (const key of Object.keys(params).filter((key) => key !== 'questions')) {
    if (questions.length !== 1 || questions[0]?.kind !== 'summary'
      || !ALLOWED.summary.includes(key) || !Object.hasOwn(questions[0], key)
      || JSON.stringify(params[key]) !== JSON.stringify(questions[0][key])) {
      throw new Error('single and multiple question parameters disagree');
    }
  }
  return questions;
}

function mapsForCategories(categories) {
  const primary = new Map(), names = new Map();
  for (const item of categories) {
    primary.set(String(item.id), item.name); names.set(String(item.id), item.name);
    for (const child of item.subCategories ?? []) {
      primary.set(String(child.id), item.name); names.set(String(child.id), child.name);
    }
  }
  return { primary, names };
}

function safeText(value) {
  return String(value ?? '').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/gu, '\\$&');
}
const localTime = (value) => new Date((value + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ');

export async function answerBookkeepingQuestions({ api, accountName = '日常支出', questions, nowMs = Date.now() }) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 8) throw new Error('one to eight questions required');
  const normalized = questions.map(normalizeReadQuestion);
  let accountsPromise, categoriesPromise, ratesPromise;
  const accounts = () => accountsPromise ??= api.listExpenseAccounts(accountName);
  const categories = () => categoriesPromise ??= api.listExpenseCategories();
  const rates = () => ratesPromise ??= api.getExchangeRates();
  const results = [];

  for (const q of normalized) {
    try {
      if (q.kind === 'exchange') {
        const minor = parseAmountToMinorUnits(q.amount ?? '1');
        const fx = q.fromCurrency === q.toCurrency ? undefined : await rates();
        const converted = fx ? convertCurrencyAmount(minor, q.fromCurrency, q.toCurrency, fx) : minor;
        results.push({ status: 'ok', text: [
          `${formatCurrencyAmount(minor, q.fromCurrency)} ≈ ${formatCurrencyAmount(converted, q.toCurrency)}`,
          ...(fx ? [exchangeRateDescription(q.fromCurrency, q.toCurrency, fx), exchangeRateSourceText(fx)] : []),
        ].join('\n') });
        continue;
      }
      const selected = (await accounts()).filter((a) => q.currency === undefined || a.currency === q.currency);
      if (!selected.length) {
        results.push({ status: 'failed', text: `没有找到 ${q.currency} 的记账子账户，这次没有取得该币种的账本结果。` });
        continue;
      }
      const categoryList = await categories();
      const maps = mapsForCategories(categoryList);
      if (q.kind === 'summary') {
        const range = resolveExpenseRange(q, nowMs);
        const categoryId = await api.resolveExpenseCategoryFilterId(q.primaryCategory, q.subcategory, categoryList);
        const rows = await api.listScopedExpenseTransactions({ accounts: selected,
          startTime: range.startTime, endTime: range.endTime, categoryId, keyword: q.keyword?.trim() });
        const grouped = new Map();
        for (const row of rows) {
          const list = grouped.get(row.currency) ?? [];
          list.push(row); grouped.set(row.currency, list);
        }
        const groups = [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([currency, transactions]) => ({
          currency, summary: aggregateExpenseSummary(transactions, maps.primary, maps.names),
        }));
        const text = groups.length ? groups.map(({ currency, summary }) => formatExpenseSummary(range.label, summary, currency)).join('\n\n')
          : `${range.label}还没有支出记录哦～`;
        const targets = q.convertTo ?? (groups.some((g) => g.currency !== 'SGD') ? ['SGD'] : []);
        const extra = [];
        let status = 'ok';
        for (const target of targets) {
          try {
            const foreign = groups.filter((g) => g.currency !== target);
            const fx = foreign.length ? await rates() : undefined;
            let total = 0;
            const missing = [];
            for (const g of groups) {
              try { total += convertCurrencyAmount(g.summary.totalAmountMinor, g.currency, target, fx); }
              catch { missing.push(g.currency); }
            }
            if (missing.length || !Number.isSafeInteger(total)) {
              status = 'partial';
              extra.push(`折合 ${target}：暂时无法计算完整总额，缺少 ${missing.join('、') || '有效'} 汇率；以上原币金额仍有效。`);
            } else {
              extra.push(`折合约 ${formatCurrencyAmount(total, target)}`);
              if (fx) extra.push(...foreign.map((g) => exchangeRateDescription(g.currency, target, fx)));
            }
            // A missing currency does not erase the source/time of valid quotes.
            if (fx) extra.push(exchangeRateSourceText(fx));
          } catch {
            status = 'partial';
            extra.push(`折合 ${target}：本次未取得可靠汇率，暂时不能换算；以上原币查询结果仍有效。`);
          }
        }
        results.push({ status, text: [text, ...extra].join('\n'), details: {
          ...range, ...(groups.length === 1 ? groups[0].summary : { count: rows.length }),
          totalsByCurrency: groups.map((g) => ({ currency: g.currency, amountMinor: g.summary.totalAmountMinor })),
        } });
      } else if (q.kind === 'find') {
        const currency = q.currency ?? 'SGD';
        const query = resolveExpenseSearch({ ...Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'kind')), currency }, nowMs);
        const matches = [];
        for (const account of selected.filter((a) => a.currency === currency)) {
          matches.push(await api.findExpenseTransactions({ accountId: account.id,
            amountMinor: query.amountMinor, startTime: query.startTime, endTime: query.endTime, limit: query.limit }));
        }
        const all = matches.flatMap((m) => m.transactions).sort((a, b) => b.time - a.time);
        const merged = { transactions: all.slice(0, query.limit), hasMore: all.length > query.limit || matches.some((m) => m.hasMore) };
        results.push({ status: 'ok', text: formatExpenseSearch(query, merged, maps.names), details: {
          amountMinor: query.amountMinor, currency, scope: query.label, returnedCount: merged.transactions.length, hasMore: merged.hasMore,
        } });
      } else {
        const range = q.period === undefined || q.period === 'all' ? {} : resolveExpenseRange(q, nowMs);
        const history = await api.listExpenseHistory({ accounts: selected, ...range, limit: q.limit ?? 3, keyword: q.keyword });
        const lines = history.transactions.length ? ['查到这些支出 🧾', ...history.transactions.map((row, i) => (
          `${i + 1}. ${localTime(row.time)} · ${formatCurrencyAmount(row.sourceAmount, row.currency)} · ${safeText(maps.names.get(row.categoryId) ?? '未识别分类')}\n   备注：${safeText(row.comment) || '无'}`
        )), ...(history.hasMore ? ['还有更多记录，可以缩小时间范围继续查。'] : [])] : ['这次查询范围内没有支出记录哦～'];
        results.push({ status: 'ok', text: lines.join('\n') });
      }
    } catch {
      const text = q.kind === 'exchange'
        ? `汇率换算（${q.fromCurrency} → ${q.toCurrency}）：本次没有取得可靠的对应报价，暂时不能换算。`
        : `这项${q.kind === 'summary' ? '支出汇总' : q.kind === 'find' ? '金额查询' : '历史查询'}没有成功，暂时不能确认账本结果。`;
      results.push({ status: 'failed', text });
    }
  }
  const status = results.every((r) => r.status === 'ok') ? 'ok' : results.every((r) => r.status === 'failed') ? 'failed' : 'partial';
  return { content: [{ type: 'text', text: results.map((r, i) => normalized.length === 1 ? r.text : `【问题 ${i + 1}】\n${r.text}`).join('\n\n') }],
    details: { status, ...(results.length === 1 ? results[0].details : {}), answers: results.map(({ status }) => ({ status })) } };
}
