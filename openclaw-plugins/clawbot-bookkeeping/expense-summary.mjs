const SINGAPORE_OFFSET_SECONDS = 8 * 60 * 60;

function parseLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) throw new Error('custom dates must use YYYY-MM-DD');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error('custom date is invalid');
  }
  return { year, month, day };
}

function midnightSeconds({ year, month, day }) {
  return Math.trunc(Date.UTC(year, month - 1, day) / 1000) - SINGAPORE_OFFSET_SECONDS;
}

function addDays(parts, count) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + count));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function localParts(nowMs) {
  const date = new Date(nowMs + SINGAPORE_OFFSET_SECONDS * 1000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function formatDate(parts) {
  return `${parts.year}/${String(parts.month).padStart(2, '0')}/${String(parts.day).padStart(2, '0')}`;
}

export function resolveExpenseRange(input, nowMs = Date.now()) {
  const today = localParts(nowMs);
  let start;
  let endExclusive;
  let label;

  if (input.period === 'today') {
    start = today;
    endExclusive = addDays(today, 1);
    label = '今天';
  } else if (input.period === 'this_week') {
    const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
    start = addDays(today, -((weekday + 6) % 7));
    endExclusive = addDays(start, 7);
    label = '本周';
  } else if (input.period === 'this_month') {
    start = { year: today.year, month: today.month, day: 1 };
    endExclusive = today.month === 12
      ? { year: today.year + 1, month: 1, day: 1 }
      : { year: today.year, month: today.month + 1, day: 1 };
    label = '这个月';
  } else if (input.period === 'last_month') {
    endExclusive = { year: today.year, month: today.month, day: 1 };
    start = today.month === 1
      ? { year: today.year - 1, month: 12, day: 1 }
      : { year: today.year, month: today.month - 1, day: 1 };
    label = '上个月';
  } else if (input.period === 'this_year') {
    start = { year: today.year, month: 1, day: 1 };
    endExclusive = { year: today.year + 1, month: 1, day: 1 };
    label = '今年';
  } else if (input.period === 'custom') {
    start = parseLocalDate(input.startDate);
    const end = parseLocalDate(input.endDate);
    endExclusive = addDays(end, 1);
    if (midnightSeconds(start) >= midnightSeconds(endExclusive)) {
      throw new Error('custom date range must not be reversed');
    }
    label = `${formatDate(start)}–${formatDate(end)}`;
  } else {
    throw new Error('unsupported expense period');
  }

  return {
    label,
    startTime: midnightSeconds(start),
    endTime: midnightSeconds(endExclusive) - 1,
  };
}

function formatMinor(value) {
  const amountMinor = BigInt(value);
  const whole = amountMinor / 100n;
  const fractional = (amountMinor % 100n).toString().padStart(2, '0');
  return `${whole}.${fractional} SGD`;
}

function formatMonthDay(unixSeconds) {
  const date = new Date(unixSeconds * 1000 + SINGAPORE_OFFSET_SECONDS * 1000);
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function aggregateExpenseSummary(transactions, primaryByCategoryId) {
  const categoryTotals = new Map();
  let totalAmountMinor = 0;

  for (const transaction of transactions) {
    const amountMinor = Number(transaction.sourceAmount);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new Error('transaction amount is invalid');
    }
    const primary = primaryByCategoryId.get(String(transaction.categoryId)) ?? '其他杂项';
    const nextTotalAmountMinor = totalAmountMinor + amountMinor;
    const nextCategoryAmountMinor = (categoryTotals.get(primary) ?? 0) + amountMinor;
    if (!Number.isSafeInteger(nextTotalAmountMinor) || !Number.isSafeInteger(nextCategoryAmountMinor)) {
      throw new Error('transaction summary total is unsafe');
    }
    totalAmountMinor = nextTotalAmountMinor;
    categoryTotals.set(primary, nextCategoryAmountMinor);
  }

  const categories = [...categoryTotals.entries()]
    .map(([name, amountMinor]) => ({ name, amountMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor || a.name.localeCompare(b.name, 'zh-CN'));
  const largest = [...transactions]
    .sort((a, b) => b.sourceAmount - a.sourceAmount || b.time - a.time)
    .slice(0, 3);

  return { totalAmountMinor, count: transactions.length, categories, largest };
}

export function formatExpenseSummary(label, summary) {
  if (summary.count === 0) return `${label}还没有支出记录～`;
  return [
    `${label}一共花了 ${formatMinor(summary.totalAmountMinor)}，共 ${summary.count} 笔 📊`,
    '',
    '分类汇总：',
    ...summary.categories.map((item) => `${item.name}：${formatMinor(item.amountMinor)}`),
    '',
    '最大三笔：',
    ...summary.largest.map((item) => `${formatMonthDay(item.time)} ${item.category?.name ?? '未分类'}：${formatMinor(item.sourceAmount)}`),
  ].join('\n');
}
