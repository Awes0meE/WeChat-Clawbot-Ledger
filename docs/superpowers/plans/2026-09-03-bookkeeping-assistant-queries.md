# Local Bookkeeping Assistant Queries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the local WeChat bookkeeper into an owner-only assistant that records one expense safely, returns a rich receipt, and answers historical and aggregate expense questions accurately.

**Architecture:** Keep `record_expense` as the only write path and preserve trusted-message correlation plus message-ID deduplication. Add a deterministic `summarize_expenses` plugin tool for exact totals, and expose only ezBookkeeping's native `query_transactions` MCP tool through a requester-scoped owner resolver for flexible history questions. Keep both services on loopback and keep credentials in local protected files.

**Tech Stack:** Node.js 24 ESM, TypeScript entry module, `node:test`, TypeBox, OpenClaw 2026.8.2 plugin SDK, ezBookkeeping 1.6.1 HTTP API and Streamable HTTP MCP, Windows PowerShell 5.1, Windows Task Scheduler.

---

## File structure

- Create `openclaw-plugins/clawbot-bookkeeping/categories.mjs`: one source of truth for category names, aliases, hierarchy lookup, and prompt guide.
- Create `openclaw-plugins/clawbot-bookkeeping/expense-summary.mjs`: Singapore date ranges, integer-minor-unit aggregation, sorting, and summary formatting.
- Create `openclaw-plugins/clawbot-bookkeeping/mcp-connection.mjs`: owner-only requester-scoped MCP connection resolution.
- Modify `openclaw-plugins/clawbot-bookkeeping/adapter.mjs`: query expense transactions and category hierarchy through the existing fixed loopback API client.
- Modify `openclaw-plugins/clawbot-bookkeeping/bookkeeping-core.mjs`: correct timestamp units, accept a grounded semantic note, and format the authoritative rich receipt.
- Modify `openclaw-plugins/clawbot-bookkeeping/index.ts`: register deterministic summary and owner-scoped MCP resolver; keep one safe write path.
- Modify `openclaw-plugins/clawbot-bookkeeping/openclaw.plugin.json`: declare the summary tool, MCP server identity, read-only filter, and token path.
- Create focused tests under `openclaw-plugins/clawbot-bookkeeping/test/` for each new module and plugin policy.
- Modify `openclaw-workspace/AGENTS.md`: intent routing and final-only reply rules.
- Modify `config/weixin-bookkeeper-agent.example.json`: exact tool allowlist for write, summary, and read-only MCP history.
- Create `scripts/configure-ezbookkeeping-mcp.ps1`: enable loopback MCP and securely generate/store a dedicated MCP token without printing it.
- Create `scripts/install-ezbookkeeping-task.ps1`: reproducibly install the persistent ezBookkeeping scheduled task.
- Modify `README.md`, `WINDOWS-HANDOFF.md`, and `docs/bookkeeping-deployment-brief.md`: architecture, operations, safety, and acceptance evidence.

### Task 1: Correct the trusted transaction timestamp unit

**Files:**
- Modify: `openclaw-plugins/clawbot-bookkeeping/bookkeeping-core.mjs`
- Modify: `openclaw-plugins/clawbot-bookkeeping/test/bookkeeping-core.test.mjs`

- [ ] **Step 1: Change the timestamp test to require Unix seconds**

Replace the current timestamp test with:

```js
test('normalizes trusted event timestamps to Unix seconds', () => {
  assert.equal(normalizeMessageTimestamp(1_788_425_460), 1_788_425_460);
  assert.equal(normalizeMessageTimestamp(1_788_425_460_000), 1_788_425_460);
});
```

In the existing `records one expense` assertion, change:

```js
time: 1_788_425_460_000,
```

to:

```js
time: 1_788_425_460,
```

- [ ] **Step 2: Run the focused test and verify the existing implementation fails**

Run:

```powershell
node --test test\bookkeeping-core.test.mjs
```

Expected: FAIL because `normalizeMessageTimestamp` currently converts seconds to milliseconds and preserves millisecond input.

- [ ] **Step 3: Implement the minimal seconds normalization**

Replace `normalizeMessageTimestamp` with:

```js
export function normalizeMessageTimestamp(timestamp) {
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('trusted message timestamp is unavailable');
  }
  return Math.trunc(numeric >= 1_000_000_000_000 ? numeric / 1000 : numeric);
}
```

- [ ] **Step 4: Run the focused and full plugin tests**

Run:

```powershell
node --test test\bookkeeping-core.test.mjs
npm.cmd test
```

Expected: all 13 baseline tests pass with the timestamp assertion now using seconds.

- [ ] **Step 5: Commit the timestamp fix**

```powershell
git add openclaw-plugins/clawbot-bookkeeping/bookkeeping-core.mjs openclaw-plugins/clawbot-bookkeeping/test/bookkeeping-core.test.mjs
git commit -m "fix: submit trusted transaction time in seconds"
```

### Task 2: Add grounded semantic notes and authoritative rich receipts

**Files:**
- Modify: `openclaw-plugins/clawbot-bookkeeping/bookkeeping-core.mjs`
- Modify: `openclaw-plugins/clawbot-bookkeeping/index.ts`
- Modify: `openclaw-plugins/clawbot-bookkeeping/test/bookkeeping-core.test.mjs`
- Create: `openclaw-plugins/clawbot-bookkeeping/test/receipt-tool.test.mjs`

- [ ] **Step 1: Write failing core tests for note precedence and receipt text**

Add imports for `formatExpenseReceipt` and `resolveExpenseComment`, then add:

```js
test('explicit notes win over a model-derived semantic note', () => {
  assert.equal(
    resolveExpenseComment(
      'NTUC购物8.25，备注家里补货',
      '两根芹菜，一个菜板',
    ),
    '家里补货',
  );
  assert.equal(
    resolveExpenseComment('NTUC购物8.25，买了两根芹菜，一个菜板', '两根芹菜，一个菜板'),
    '两根芹菜，一个菜板',
  );
  assert.equal(resolveExpenseComment('午饭7.2', ''), '');
  assert.throws(() => resolveExpenseComment('购物1', '字'.repeat(256)));
});

test('formats the confirmed expense as a rich WeChat receipt', () => {
  assert.equal(formatExpenseReceipt({
    ledgerDisplayName: '日常账本',
    amountMinor: 720,
    primaryCategory: '食品酒水',
    subcategory: '早午晚餐',
    comment: '',
    time: 1_788_425_460,
  }), [
    '记下来啦！🧾',
    '账本：[ 日常账本 ]',
    '支出：7.20 SGD',
    '分类：食品酒水 - 早午晚餐',
    '备注：无',
    '时间：2026/09/03 16:51',
  ].join('\n'));
});
```

- [ ] **Step 2: Run the core test and verify missing exports fail**

Run:

```powershell
node --test test\bookkeeping-core.test.mjs
```

Expected: FAIL because `resolveExpenseComment` and `formatExpenseReceipt` do not exist.

- [ ] **Step 3: Implement comment selection and receipt formatting**

Add to `bookkeeping-core.mjs`:

```js
function validateComment(value) {
  const comment = String(value ?? '').trim();
  if (Array.from(comment).length > MAX_COMMENT_CHARACTERS) {
    throw new Error('comment exceeds ezBookkeeping 255-character limit');
  }
  return comment === '无' ? '' : comment;
}

export function resolveExpenseComment(content, semanticComment = '') {
  const verbatim = extractVerbatimComment(content);
  return verbatim ? validateComment(verbatim) : validateComment(semanticComment);
}

function formatSgdMinor(amountMinor) {
  return (amountMinor / 100).toFixed(2);
}

function formatSingaporeMinute(unixSeconds) {
  const date = new Date(unixSeconds * 1000 + 480 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

export function formatExpenseReceipt({
  ledgerDisplayName,
  amountMinor,
  primaryCategory,
  subcategory,
  comment,
  time,
}) {
  return [
    '记下来啦！🧾',
    `账本：[ ${ledgerDisplayName} ]`,
    `支出：${formatSgdMinor(amountMinor)} SGD`,
    `分类：${primaryCategory} - ${subcategory}`,
    `备注：${comment || '无'}`,
    `时间：${formatSingaporeMinute(time)}`,
  ].join('\n');
}
```

Change `recordExpense` to select the comment from both trusted content and the optional model value:

```js
const comment = resolveExpenseComment(inbound.content, input.comment);
```

Store `amountMinor: sourceAmount` in the confirmed receipt result.

- [ ] **Step 4: Add a failing plugin-level receipt test**

Create `test/receipt-tool.test.mjs` using the same plugin API stub pattern as `inbound-metadata.test.mjs`. Seed a trusted inbound message, stub `globalThis.fetch` for account, category, and add-transaction responses, execute `record_expense` with:

```js
{
  amount: '8.25',
  primaryCategory: '食品酒水',
  subcategory: '超市购物',
  comment: '两根芹菜，一个菜板',
}
```

Assert the result text is exactly:

```js
[
  '记下来啦！🧾',
  '账本：[ 日常账本 ]',
  '支出：8.25 SGD',
  '分类：食品酒水 - 超市购物',
  '备注：两根芹菜，一个菜板',
  '时间：2026/09/03 16:51',
].join('\n')
```

Expected before integration: FAIL because the tool schema rejects `comment` and still returns the one-line receipt.

- [ ] **Step 5: Integrate the optional comment and fixed receipt into `record_expense`**

Extend its schema with:

```ts
comment: Type.Optional(Type.String({ maxLength: 255 })),
```

Add plugin config:

```ts
const ledgerDisplayName = typeof config.ledgerDisplayName === 'string'
  ? config.ledgerDisplayName
  : '日常账本';
```

After a confirmed create, return:

```ts
text: formatExpenseReceipt({
  ledgerDisplayName,
  amountMinor: result.amountMinor,
  primaryCategory: normalizedInput.primaryCategory,
  subcategory: normalizedInput.subcategory,
  comment: result.comment,
  time: result.time,
}),
```

Keep the owner, trusted-message, expiry, and parameter-normalization checks outside the failure wrapper. Wrap only the single `recordExpense(...)` call; if it throws, log only the error class/message and return this non-success terminal result without retrying:

```ts
return {
  content: [{
    type: 'text',
    text: '账本暂时连不上，本次没有写入任何数据，请稍后再试。',
  }],
  details: { status: 'failed' },
};
```

Do not use this catch for missing trusted owner metadata; those checks remain fail-closed before the API call.

- [ ] **Step 6: Run tests and commit the receipt feature**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass, including explicit-note precedence, inferred note, empty note, fixed Singapore time, and exact receipt text.

Commit:

```powershell
git add openclaw-plugins/clawbot-bookkeeping/bookkeeping-core.mjs openclaw-plugins/clawbot-bookkeeping/index.ts openclaw-plugins/clawbot-bookkeeping/test/bookkeeping-core.test.mjs openclaw-plugins/clawbot-bookkeeping/test/receipt-tool.test.mjs
git commit -m "feat: return rich verified expense receipts"
```

### Task 3: Extract the category catalog and build deterministic summaries

**Files:**
- Create: `openclaw-plugins/clawbot-bookkeeping/categories.mjs`
- Create: `openclaw-plugins/clawbot-bookkeeping/expense-summary.mjs`
- Create: `openclaw-plugins/clawbot-bookkeeping/test/categories.test.mjs`
- Create: `openclaw-plugins/clawbot-bookkeeping/test/expense-summary.test.mjs`
- Modify: `openclaw-plugins/clawbot-bookkeeping/index.ts`

- [ ] **Step 1: Write failing tests for category lookup and period ranges**

Create `test/categories.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSubcategory, primaryCategoryForSubcategory } from '../categories.mjs';

test('normalizes meal aliases and resolves their primary category', () => {
  assert.equal(normalizeSubcategory('食品酒水', '午饭'), '早午晚餐');
  assert.equal(primaryCategoryForSubcategory('超市购物'), '食品酒水');
  assert.throws(() => normalizeSubcategory('行车交通', '早午晚餐'));
});
```

Create the first part of `test/expense-summary.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveExpenseRange } from '../expense-summary.mjs';

const nowMs = Date.parse('2026-09-03T16:30:00+08:00');

test('resolves Singapore calendar periods to inclusive Unix-second boundaries', () => {
  assert.deepEqual(resolveExpenseRange({ period: 'this_month' }, nowMs), {
    label: '这个月',
    startTime: 1_788_192_000,
    endTime: 1_790_783_999,
  });
  assert.deepEqual(resolveExpenseRange({
    period: 'custom',
    startDate: '2026-08-30',
    endDate: '2026-09-02',
  }, nowMs), {
    label: '2026/08/30–2026/09/02',
    startTime: 1_788_019_200,
    endTime: 1_788_364_799,
  });
});
```

- [ ] **Step 2: Run the new tests and verify missing modules fail**

Run:

```powershell
node --test test\categories.test.mjs test\expense-summary.test.mjs
```

Expected: FAIL with module-not-found errors.

- [ ] **Step 3: Create the shared category catalog**

Create `categories.mjs`:

```js
export const CATEGORY_DEFINITIONS = {
  食品酒水: ['早午晚餐', '烟酒茶', '水果零食', '饮料甜品', '超市购物'],
  行车交通: ['公共交通', '打车租车', '私家车费用'],
  居家物业: ['日常用品', '水电煤气', '房租', '物业管理', '维修保养'],
  交流通讯: ['座机费', '手机费', '上网费', '邮寄费'],
  衣服饰品: ['衣服裤子', '鞋帽包包', '化妆饰品'],
  休闲娱乐: ['运动健身', '交际聚会', '休闲玩乐', '宠物宝贝', '旅游度假'],
  医疗保健: ['药品费', '保健费', '美容费', '治疗费'],
  学习进修: ['数码装备', '书报杂志', '培训进修'],
  人情往来: ['送礼请客', '孝敬长辈', '还人钱物', '慈善捐助'],
  金融保险: ['银行手续', '投资亏损', '按揭还款', '消费税收', '利息支出', '赔偿罚款'],
  其他杂项: ['其他支出', '意外丢失', '烂账损失'],
};

export const PRIMARY_CATEGORIES = Object.freeze(Object.keys(CATEGORY_DEFINITIONS));
export const SUBCATEGORIES = Object.freeze(Object.values(CATEGORY_DEFINITIONS).flat());
export const CATEGORY_GUIDE = Object.entries(CATEGORY_DEFINITIONS)
  .map(([primary, secondary]) => `${primary}: ${secondary.join('、')}`)
  .join('\n');

const SUBCATEGORY_ALIASES = new Map([
  ['餐饮', '早午晚餐'], ['早餐', '早午晚餐'], ['午餐', '早午晚餐'],
  ['晚餐', '早午晚餐'], ['早饭', '早午晚餐'], ['午饭', '早午晚餐'],
  ['晚饭', '早午晚餐'], ['正餐', '早午晚餐'],
]);

export function normalizeSubcategory(primaryCategory, value) {
  const normalized = SUBCATEGORY_ALIASES.get(value) ?? value;
  if (!CATEGORY_DEFINITIONS[primaryCategory]?.includes(normalized)) {
    throw new Error(`二级分类必须是“${primaryCategory}”下的正式分类名称。`);
  }
  return normalized;
}

export function primaryCategoryForSubcategory(value) {
  return Object.entries(CATEGORY_DEFINITIONS)
    .find(([, secondary]) => secondary.includes(value))?.[0];
}
```

Remove the duplicated category constants and normalizer from `index.ts`; import the four required exports from this module.

- [ ] **Step 4: Implement Singapore ranges**

Create `expense-summary.mjs` with:

```js
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
```

- [ ] **Step 5: Add failing aggregation and formatting tests**

Extend `expense-summary.test.mjs`:

```js
import { aggregateExpenseSummary, formatExpenseSummary } from '../expense-summary.mjs';

test('aggregates integer amounts by primary category and selects the largest three', () => {
  const summary = aggregateExpenseSummary([
    { id: '1', time: 1_788_300_000, sourceAmount: 720, categoryId: 'meal', category: { name: '早午晚餐' }, comment: '' },
    { id: '2', time: 1_788_200_000, sourceAmount: 825, categoryId: 'market', category: { name: '超市购物' }, comment: '两根芹菜，一个菜板' },
    { id: '3', time: 1_788_100_000, sourceAmount: 2400, categoryId: 'digital', category: { name: '数码装备' }, comment: '网线' },
    { id: '4', time: 1_788_000_000, sourceAmount: 250, categoryId: 'drink', category: { name: '饮料甜品' }, comment: '' },
  ], new Map([
    ['meal', '食品酒水'], ['market', '食品酒水'],
    ['digital', '学习进修'], ['drink', '食品酒水'],
  ]));

  assert.equal(summary.totalAmountMinor, 4095);
  assert.equal(summary.count, 4);
  assert.deepEqual(summary.categories, [
    { name: '学习进修', amountMinor: 2400 },
    { name: '食品酒水', amountMinor: 1695 },
  ]);
  assert.deepEqual(summary.largest.map((item) => item.id), ['3', '2', '1']);
});

test('formats the selected A-style summary and empty result', () => {
  assert.match(formatExpenseSummary('这个月', {
    totalAmountMinor: 4095,
    count: 4,
    categories: [{ name: '学习进修', amountMinor: 2400 }, { name: '食品酒水', amountMinor: 1695 }],
    largest: [{ id: '3', time: 1_788_100_000, sourceAmount: 2400, category: { name: '数码装备' } }],
  }), /^这个月一共花了 40\.95 SGD，共 4 笔 📊/u);
  assert.equal(formatExpenseSummary('这个月', {
    totalAmountMinor: 0, count: 0, categories: [], largest: [],
  }), '这个月还没有支出记录～');
});
```

- [ ] **Step 6: Implement aggregation and formatting**

Append to `expense-summary.mjs`:

```js
function formatMinor(value) {
  return `${(value / 100).toFixed(2)} SGD`;
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
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
      throw new Error('transaction amount is invalid');
    }
    totalAmountMinor += amountMinor;
    const primary = primaryByCategoryId.get(String(transaction.categoryId)) ?? '其他杂项';
    categoryTotals.set(primary, (categoryTotals.get(primary) ?? 0) + amountMinor);
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
```

- [ ] **Step 7: Run focused tests and commit the pure domain layer**

Run:

```powershell
node --test test\categories.test.mjs test\expense-summary.test.mjs
npm.cmd test
```

Expected: all category and summary tests pass without network access.

Commit:

```powershell
git add openclaw-plugins/clawbot-bookkeeping/categories.mjs openclaw-plugins/clawbot-bookkeeping/expense-summary.mjs openclaw-plugins/clawbot-bookkeeping/index.ts openclaw-plugins/clawbot-bookkeeping/test/categories.test.mjs openclaw-plugins/clawbot-bookkeeping/test/expense-summary.test.mjs
git commit -m "feat: add deterministic expense summaries"
```

### Task 4: Add the read-only HTTP adapter and summary tool

**Files:**
- Modify: `openclaw-plugins/clawbot-bookkeeping/adapter.mjs`
- Modify: `openclaw-plugins/clawbot-bookkeeping/index.ts`
- Modify: `openclaw-plugins/clawbot-bookkeeping/openclaw.plugin.json`
- Modify: `openclaw-plugins/clawbot-bookkeeping/test/adapter.test.mjs`
- Create: `openclaw-plugins/clawbot-bookkeeping/test/summary-tool.test.mjs`

- [ ] **Step 1: Write a failing adapter query test**

Add a fake response for `/transactions/list/all.json` and assert:

```js
const result = await api.listExpenseTransactions({
  accountId: 'account-1',
  startTime: 1_788_192_000,
  endTime: 1_790_783_999,
  categoryId: 'primary-1',
  keyword: 'NTUC',
});
assert.equal(result.length, 1);
const requestUrl = new URL(requests.at(-1).url);
assert.equal(requestUrl.pathname, '/api/v1/transactions/list/all.json');
assert.equal(requestUrl.searchParams.get('type'), '3');
assert.equal(requestUrl.searchParams.get('account_ids'), 'account-1');
assert.equal(requestUrl.searchParams.get('category_ids'), 'primary-1');
assert.equal(requestUrl.searchParams.get('start_time'), '1788192000');
assert.equal(requestUrl.searchParams.get('end_time'), '1790783999');
assert.equal(requestUrl.searchParams.get('keyword'), 'NTUC');
```

Expected response fixture:

```js
{ success: true, result: [{
  id: 'transaction-1', type: 3, categoryId: 'secondary-1', time: 1_788_425_460,
  sourceAccountId: 'account-1', sourceAmount: 825,
  category: { id: 'secondary-1', name: '超市购物', parentId: 'primary-1' },
  comment: '两根芹菜，一个菜板',
}] }
```

- [ ] **Step 2: Run the adapter test and verify the method is missing**

Run:

```powershell
node --test test\adapter.test.mjs
```

Expected: FAIL because `listExpenseTransactions` is undefined.

- [ ] **Step 3: Allow query strings and implement adapter read methods**

Change `#request` to accept `query`:

```js
async #request(path, { method = 'GET', body, query } = {}) {
  const token = readFileSync(this.tokenPath, 'utf8').trim();
  if (!token) throw new Error('ezBookkeeping API token file is empty');
  const url = new URL(`${this.baseUrl}/api/v1/${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await this.fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
      'X-Timezone-Name': 'Asia/Singapore',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok || payload.success !== true) {
    const code = payload?.errorCode ?? response.status;
    const message = payload?.errorMessage ?? response.statusText;
    throw new Error(`ezBookkeeping request failed (${code}): ${message}`);
  }
  return payload.result;
}
```

Add:

```js
async listExpenseCategories() {
  const result = await this.#request('transaction/categories/list.json');
  return Array.isArray(result?.['2']) ? result['2'] : [];
}

async resolveExpenseCategoryFilterId(primaryName, subcategoryName) {
  if (!primaryName) return undefined;
  const categories = await this.listExpenseCategories();
  const primary = categories.find((item) => item.name === primaryName && item.hidden !== true);
  if (!primary) throw new Error(`expense category not found: ${primaryName}`);
  if (!subcategoryName) return primary.id;
  const secondary = primary.subCategories?.find(
    (item) => item.name === subcategoryName && item.hidden !== true,
  );
  if (!secondary) throw new Error(`expense subcategory not found: ${primaryName}/${subcategoryName}`);
  return secondary.id;
}

async listExpenseTransactions({ accountId, startTime, endTime, categoryId, keyword }) {
  const result = await this.#request('transactions/list/all.json', { query: {
    type: 3,
    account_ids: accountId,
    category_ids: categoryId,
    start_time: startTime,
    end_time: endTime,
    keyword,
    trim_account: true,
    trim_tag: true,
  } });
  if (!Array.isArray(result)) throw new Error('ezBookkeeping transaction list is invalid');
  return result;
}
```

- [ ] **Step 4: Write the failing owner-only summary tool test**

Create `test/summary-tool.test.mjs`. Capture the `summarize_expenses` tool factory and assert:

```js
const denied = summaryFactory({ senderIsOwner: false });
await assert.rejects(() => denied.execute('query-1', { period: 'this_month' }), /owner/i);

const allowed = summaryFactory({ senderIsOwner: true });
const result = await allowed.execute('query-2', { period: 'this_month' });
assert.match(result.content[0].text, /^这个月一共花了 8\.25 SGD，共 1 笔 📊/u);
assert.equal(result.details.status, 'ok');
assert.equal(result.details.totalAmountMinor, 825);
```

Use fixed fake-fetch fixtures for account, categories, and the transaction list. Add a second test whose fetch throws and assert the tool returns exactly:

```text
账本暂时连不上，本次没有读取任何数据，请稍后再试。
```

- [ ] **Step 5: Register `summarize_expenses`**

Add a TypeBox schema with exact period literals, optional strict date strings, official categories, and keyword. In its owner-scoped tool factory:

```ts
const range = resolveExpenseRange(params);
const accountId = await bookkeepingApi.resolveAccountId(accountName);
const categoryId = await bookkeepingApi.resolveExpenseCategoryFilterId(
  params.primaryCategory,
  params.subcategory,
);
const categories = await bookkeepingApi.listExpenseCategories();
const primaryByCategoryId = new Map<string, string>();
for (const primary of categories) {
  for (const secondary of primary.subCategories ?? []) {
    primaryByCategoryId.set(String(secondary.id), primary.name);
  }
}
const transactions = await bookkeepingApi.listExpenseTransactions({
  accountId,
  startTime: range.startTime,
  endTime: range.endTime,
  categoryId,
  keyword: params.keyword,
});
const summary = aggregateExpenseSummary(transactions, primaryByCategoryId);
return {
  content: [{ type: 'text', text: formatExpenseSummary(range.label, summary) }],
  details: { status: 'ok', ...range, ...summary },
};
```

Catch expected API failures and return the stable read-failure text with `details: { status: 'failed' }`. Log only the error class/message; never log request headers or transaction contents.

- [ ] **Step 6: Declare the new plugin tool and run tests**

Add `summarize_expenses` to `contracts.tools` and `toolMetadata` in `openclaw.plugin.json`.

Run:

```powershell
npm.cmd test
```

Expected: adapter and owner-only summary tests pass; all previous tests remain green.

- [ ] **Step 7: Commit the query adapter and summary tool**

```powershell
git add openclaw-plugins/clawbot-bookkeeping/adapter.mjs openclaw-plugins/clawbot-bookkeeping/index.ts openclaw-plugins/clawbot-bookkeeping/openclaw.plugin.json openclaw-plugins/clawbot-bookkeeping/test/adapter.test.mjs openclaw-plugins/clawbot-bookkeeping/test/summary-tool.test.mjs
git commit -m "feat: add owner-only expense summaries"
```

### Task 5: Add requester-scoped read-only native MCP

**Files:**
- Create: `openclaw-plugins/clawbot-bookkeeping/mcp-connection.mjs`
- Create: `openclaw-plugins/clawbot-bookkeeping/test/mcp-connection.test.mjs`
- Create: `openclaw-plugins/clawbot-bookkeeping/test/manifest-policy.test.mjs`
- Modify: `openclaw-plugins/clawbot-bookkeeping/index.ts`
- Modify: `openclaw-plugins/clawbot-bookkeeping/openclaw.plugin.json`

- [ ] **Step 1: Write failing requester-identity tests**

Create `test/mcp-connection.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnerMcpConnectionResolver } from '../mcp-connection.mjs';

const config = { commands: { ownerAllowFrom: ['openclaw-weixin:alice'] } };

test('materializes MCP only for the configured WeChat owner', async () => {
  let tokenReads = 0;
  const resolve = createOwnerMcpConnectionResolver({
    config,
    serverBaseUrl: 'http://127.0.0.1:8180',
    mcpTokenPath: 'unused',
    readToken() { tokenReads += 1; return 'mcp-token'; },
  });

  assert.equal(await resolve({ requesterSenderId: 'stranger', messageChannel: 'openclaw-weixin' }), null);
  assert.equal(await resolve({ requesterSenderId: 'alice', messageChannel: 'telegram' }), null);
  assert.equal(tokenReads, 0);
  assert.deepEqual(await resolve({ requesterSenderId: 'alice', messageChannel: 'openclaw-weixin' }), {
    url: 'http://127.0.0.1:8180/mcp',
    headers: { Authorization: 'Bearer mcp-token' },
  });
  assert.equal(tokenReads, 1);
});
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run:

```powershell
node --test test\mcp-connection.test.mjs
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the owner-scoped resolver**

Create `mcp-connection.mjs`:

```js
import { readFileSync } from 'node:fs';

export function createOwnerMcpConnectionResolver({
  config,
  serverBaseUrl,
  mcpTokenPath,
  readToken = (path) => readFileSync(path, 'utf8').trim(),
}) {
  const parsed = new URL(serverBaseUrl);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '8180') {
    throw new Error('MCP server must use http://127.0.0.1:8180');
  }
  const owners = new Set(Array.isArray(config?.commands?.ownerAllowFrom)
    ? config.commands.ownerAllowFrom
    : []);

  return async (ctx) => {
    if (ctx.messageChannel !== 'openclaw-weixin') return null;
    if (!owners.has(`${ctx.messageChannel}:${ctx.requesterSenderId}`)) return null;
    const token = readToken(mcpTokenPath);
    if (!token) throw new Error('ezBookkeeping MCP token file is empty');
    return {
      url: `${parsed.toString().replace(/\/$/u, '')}/mcp`,
      headers: { Authorization: `Bearer ${token}` },
    };
  };
}
```

- [ ] **Step 4: Write a failing manifest policy test**

Create `test/manifest-policy.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('declares a single read-only ezBookkeeping MCP tool', () => {
  const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.mcpServers.ezbookkeeping.toolFilter.include, ['query_transactions']);
  assert.equal(manifest.mcpServers.ezbookkeeping.url, 'http://127.0.0.1:8180/mcp');
  assert.equal(manifest.mcpServers.ezbookkeeping.transport, 'streamable-http');
  assert.equal(manifest.mcpServers.ezbookkeeping.toolFilter.include.includes('add_transaction'), false);
});
```

- [ ] **Step 5: Declare the MCP identity and token path**

Add to the manifest top level:

```json
"mcpServers": {
  "ezbookkeeping": {
    "transport": "streamable-http",
    "url": "http://127.0.0.1:8180/mcp",
    "toolFilter": {
      "include": ["query_transactions"]
    }
  }
}
```

Add `mcpTokenPath` to `configSchema.properties` as a non-empty string.

- [ ] **Step 6: Register the resolver in the plugin**

Import `homedir` from `node:os` and `join` from `node:path`, then read the configured path without adding another machine-specific username to source control:

```ts
const mcpTokenPath = typeof config.mcpTokenPath === 'string'
  ? config.mcpTokenPath
  : join(homedir(), '.openclaw', 'secrets', 'ezbookkeeping-mcp-token.txt');
```

Register:

```ts
api.registerMcpServerConnectionResolver({
  serverName: 'ezbookkeeping',
  resolve: createOwnerMcpConnectionResolver({
    config: api.config,
    serverBaseUrl,
    mcpTokenPath,
  }),
});
```

Update plugin API stubs in existing tests to capture or ignore `registerMcpServerConnectionResolver` without weakening assertions.

- [ ] **Step 7: Run policy and full tests, then commit**

Run:

```powershell
node --test test\mcp-connection.test.mjs test\manifest-policy.test.mjs
npm.cmd test
```

Expected: owner-scoped resolver passes, manifest exposes exactly one MCP tool, and all plugin tests pass.

Commit:

```powershell
git add openclaw-plugins/clawbot-bookkeeping/mcp-connection.mjs openclaw-plugins/clawbot-bookkeeping/index.ts openclaw-plugins/clawbot-bookkeeping/openclaw.plugin.json openclaw-plugins/clawbot-bookkeeping/test/mcp-connection.test.mjs openclaw-plugins/clawbot-bookkeeping/test/manifest-policy.test.mjs openclaw-plugins/clawbot-bookkeeping/test/inbound-metadata.test.mjs openclaw-plugins/clawbot-bookkeeping/test/receipt-tool.test.mjs openclaw-plugins/clawbot-bookkeeping/test/summary-tool.test.mjs
git commit -m "feat: scope read-only ledger MCP to the owner"
```

### Task 6: Teach the local assistant to route intents correctly

**Files:**
- Modify: `openclaw-workspace/AGENTS.md`
- Modify: `config/weixin-bookkeeper-agent.example.json`
- Create: `openclaw-plugins/clawbot-bookkeeping/test/prompt-policy.test.mjs`

- [ ] **Step 1: Write a failing prompt and allowlist policy test**

Create `test/prompt-policy.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('runtime prompt routes queries before writes and suppresses internal reasoning', () => {
  const prompt = readFileSync(new URL('../../../openclaw-workspace/AGENTS.md', import.meta.url), 'utf8');
  assert.match(prompt, /查询\/统计意图优先/u);
  assert.match(prompt, /summarize_expenses/u);
  assert.match(prompt, /query_transactions/u);
  assert.match(prompt, /不得重新计算/u);
  assert.doesNotMatch(prompt, /只处理当前用户从微信发来的个人记账请求/u);
});

test('bookkeeper allowlist contains only the intended assistant tools', () => {
  const batches = JSON.parse(readFileSync(new URL('../../../config/weixin-bookkeeper-agent.example.json', import.meta.url), 'utf8'));
  const bookkeeper = batches.find((item) => item.path === 'agents.entries.bookkeeper').value;
  assert.deepEqual(bookkeeper.tools.allow, [
    'record_expense',
    'summarize_expenses',
    'ezbookkeeping__query_transactions',
  ]);
});
```

- [ ] **Step 2: Run the policy test and verify the old prompt fails**

Run:

```powershell
node --test test\prompt-policy.test.mjs
```

Expected: FAIL because the prompt and allowlist are still record-only.

- [ ] **Step 3: Replace the runtime prompt with explicit intent routing**

Use this policy in `openclaw-workspace/AGENTS.md`:

```markdown
# Clawbot 本地账本助理

你是当前用户与本地 ezBookkeeping 之间的小助理，只处理个人账本相关请求，使用简体中文，语气简洁、自然、活泼。

- 查询/统计意图优先：询问“多少、总共、花了、支出、记录、最近几笔、这个月、上个月、哪一笔”等历史信息时，不得调用 `record_expense`。
- “今天/本周/这个月/上个月/今年花了多少钱”及带分类的汇总调用 `summarize_expenses`，最终回复必须原样采用工具文本，不得重新计算或改写金额。
- “最近几笔是什么”“某段时间在某商家买过什么”等灵活历史问题调用只读 `query_transactions`，只根据实际工具结果回答。
- 只有消息明确表达一笔已经发生的消费并包含明确金额时，才调用一次 `record_expense`。
- `6.5+2.5` 表示同一笔消费合计 9；每条消息最多写入一笔，失败后不重试。
- 模型选择正式一级、二级分类。未显式写“备注”时，可把消息中明确出现的商家、商品或用途提炼为简短 `comment`；不得补充原消息没有的信息。只有“午饭7.2”时 `comment` 留空。
- `record_expense` 和 `summarize_expenses` 成功、重复、空结果或连接失败后，只发送工具给出的最终用户文本。
- `query_transactions` 返回结构化记录时，只可根据这些记录中的时间、金额、分类和备注做简洁回答；不得猜测缺失字段或加入工具结果之外的交易。
- `query_transactions` 连接失败时只回复“账本暂时连不上，本次没有读取任何数据，请稍后再试。”，不得重试或展示底层错误。
- 不展示思考过程、工具名、JSON、参数、候选分类、校验过程、底层错误或重试过程。
- 无法区分记账与查询、缺少金额或日期范围时，只追问缺少的信息，不调用工具猜测。
- 一条消息同时要求记账与查询时，先完成一次明确记账，再提示用户另发一条查询。
- 不修改或删除账本，不执行账本以外的操作，不把账本内容交给云端模型。
```

- [ ] **Step 4: Restrict the example agent allowlist**

Set:

```json
"allow": [
  "record_expense",
  "summarize_expenses",
  "ezbookkeeping__query_transactions"
]
```

Keep `profile: "minimal"`, thinking/reasoning off, and loop detection enabled.

- [ ] **Step 5: Run tests and commit intent routing**

Run:

```powershell
npm.cmd test
```

Expected: prompt policy test and complete plugin suite pass.

Commit:

```powershell
git add openclaw-workspace/AGENTS.md config/weixin-bookkeeper-agent.example.json openclaw-plugins/clawbot-bookkeeping/test/prompt-policy.test.mjs
git commit -m "feat: route bookkeeping queries before writes"
```

### Task 7: Add reproducible local MCP and service setup scripts

**Files:**
- Create: `scripts/configure-ezbookkeeping-mcp.ps1`
- Create: `scripts/install-ezbookkeeping-task.ps1`

- [ ] **Step 1: Create the secure MCP setup script**

Implement `configure-ezbookkeeping-mcp.ps1` with `[CmdletBinding(SupportsShouldProcess)]`; the checked-in script, not an abbreviated plan snippet, is the executable source of truth. Its default INI is `D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini`, and `-WhatIf` returns before every mutation or password prompt.

The implementation must parse only the unambiguous `[mcp]` settings, create a collision-safe sibling backup, write a sibling temporary file, and use `[IO.File]::Replace` rather than overwriting the live INI directly. Before service control it must resolve exactly one root task and validate the exact Windows PowerShell 5.1 launcher, `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden` arguments, wrapped normalized `ezbookkeeping.exe server run`, and working directory. Stop/start uses that task object via `-InputObject`; process cleanup is limited to the normalized expected executable. Health or token failure restores both configuration and prior service state. Token output is normalized, newline-free, written with owner-only ACLs, and no password, request body, header, or token is logged.

- [ ] **Step 2: Create the scheduled-task installer**

Implement `install-ezbookkeeping-task.ps1` with the checked-in script as the executable source of truth. It resolves the install directory, expected `ezbookkeeping.exe`, and system Windows PowerShell 5.1 path before `ShouldProcess`. The registered root task action executes Windows PowerShell with the exact hidden, non-interactive arguments above and the normalized install directory; it never registers `ezbookkeeping.exe` as a direct visible action. Keep login trigger, limited current-user principal, bounded restart policy, no execution time limit, single-instance behavior, and battery-safe settings.

- [ ] **Step 3: Parse-check both scripts and inspect `-WhatIf` output**

Run:

```powershell
$errors = $null
[Management.Automation.Language.Parser]::ParseFile((Resolve-Path scripts\configure-ezbookkeeping-mcp.ps1), [ref]$null, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { $errors | Format-List; exit 1 }
[Management.Automation.Language.Parser]::ParseFile((Resolve-Path scripts\install-ezbookkeeping-task.ps1), [ref]$null, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { $errors | Format-List; exit 1 }
.\scripts\configure-ezbookkeeping-mcp.ps1 -WhatIf
.\scripts\install-ezbookkeeping-task.ps1 -WhatIf
```

Expected: no parser errors; both `-WhatIf` calls describe only the exact config file or `Clawbot ezBookkeeping`, make no changes, and do not request a password.

- [ ] **Step 4: Commit the runtime scripts**

```powershell
git add scripts/configure-ezbookkeeping-mcp.ps1 scripts/install-ezbookkeeping-task.ps1
git commit -m "feat: add secure local bookkeeping runtime setup"
```

### Task 8: Update documentation and sanitized configuration contracts

**Files:**
- Modify: `README.md`
- Modify: `WINDOWS-HANDOFF.md`
- Modify: `docs/bookkeeping-deployment-brief.md`
- Modify: `openclaw-plugins/clawbot-bookkeeping/openclaw.plugin.json`

- [ ] **Step 1: Extend the manifest config schema**

Add:

```json
"mcpTokenPath": {
  "type": "string",
  "minLength": 1
},
"ledgerDisplayName": {
  "type": "string",
  "const": "日常账本"
}
```

Keep `serverBaseUrl` fixed to `http://127.0.0.1:8180` and `accountName` fixed to `日常支出`.

- [ ] **Step 2: Update README architecture and verification**

Document this exact path:

```text
WeChat -> OpenClaw owner-bound local Qwen
  -> record_expense -> trusted write adapter -> ezBookkeeping HTTP API
  -> summarize_expenses -> deterministic read adapter -> ezBookkeeping HTTP API
  -> ezbookkeeping__query_transactions -> requester-scoped read-only MCP
```

Replace the old two-tool claim with the exact final allowlist. Add verification commands:

```powershell
openclaw gateway status
openclaw channels status --probe
openclaw plugins info clawbot-bookkeeping
```

State that dynamic MCP is declared only through the plugin manifest and requester-scoped resolver; do not add a top-level `mcp.servers` connection for CLI diagnostics. Use plugin info plus automated manifest/resolver/allowlist tests to prove that source includes `query_transactions` and excludes `add_transaction`, then use an owner WeChat history query as the end-to-end acceptance.

- [ ] **Step 3: Update the detailed handoff and deployment brief**

Record:

- why write remains custom and deduplicated;
- how requester-scoped MCP checks `commands.ownerAllowFrom`;
- the immutable runtime category contract has exactly 11 primary and 45 secondary categories;
- API token versus MCP token;
- Unix seconds for ezBookkeeping transaction time;
- rich receipt and A-style summary templates;
- expected service-unavailable replies;
- scheduled-task installation and recovery commands;
- no Vercel/public exposure in this release.

- [ ] **Step 4: Run repository secret and identity scans**

Run:

```powershell
rg -n --hidden --glob '!**/node_modules/**' --glob '!**/.git/**' --glob '!**/.worktrees/**' 'Bearer\s+[A-Za-z0-9._-]{20,}|openclaw-weixin:[A-Za-z0-9_-]{8,}' .
rg -n --hidden --glob '!**/node_modules/**' --glob '!**/.git/**' --glob '!**/.worktrees/**' '(?i)password\s*[:=]\s*["''][^<][^"'']{7,}["'']' .
git diff --cached --check
```

Expected: no unexplained live credential, literal-password, or sender-identity matches, and no staged whitespace errors. Review every match, including tests and examples; a synthetic fixture is not exempt merely because of its path. Documentation may contain only generic field names and paths. Separately compare the staged diff against the known live credentials in memory without writing those values into this plan, a command, or Git history.

- [ ] **Step 5: Run full tests and commit documentation**

Run:

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
npm.cmd test
Set-Location ..\openclaw-weixin-stable-id
npm.cmd run build
node --test test\inbound-message-id.test.mjs
```

Expected: all 81 bookkeeping plugin tests pass; stable-ID build and all three tests pass.

Commit:

```powershell
git add README.md WINDOWS-HANDOFF.md docs/bookkeeping-deployment-brief.md openclaw-plugins/clawbot-bookkeeping/openclaw.plugin.json
git commit -m "docs: document local bookkeeping assistant operations"
```

### Task 9: Deploy locally and perform end-to-end acceptance

**Files:**
- Runtime only: `D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini`
- Runtime only: `%USERPROFILE%\.openclaw\openclaw.json`
- Runtime only: `%USERPROFILE%\.openclaw\secrets\ezbookkeeping-mcp-token.txt`
- Runtime only: installed `clawbot-bookkeeping` plugin and bookkeeper workspace

- [ ] **Preflight: Assert that no static ezBookkeeping MCP fallback exists**

Before backing up, installing, or changing any runtime configuration, run this read-only PowerShell 5.1 check. It inspects property names only and never prints or serializes the configuration object, headers, or values. Missing `mcp` or `servers` properties pass safely.

```powershell
function Assert-NoStaticEzBookkeepingMcpFallback {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$ConfigPath)

    $rawConfig = $null
    $configObject = $null
    try {
        $rawConfig = [IO.File]::ReadAllText($ConfigPath, [Text.Encoding]::UTF8)
        $configObject = ConvertFrom-Json -InputObject $rawConfig -ErrorAction Stop
    } catch {
        throw 'Could not safely inspect OpenClaw configuration; stop deployment.'
    } finally {
        $rawConfig = $null
    }

    try {
        if ($null -eq $configObject -or $configObject -isnot [PSCustomObject]) {
            throw 'Could not safely inspect OpenClaw configuration; stop deployment.'
        }

        $mcpProperties = @($configObject.PSObject.Properties | Where-Object { $_.Name -ieq 'mcp' })
        if ($mcpProperties.Count -gt 1) {
            throw 'Could not safely inspect OpenClaw configuration; stop deployment.'
        }

        if ($mcpProperties.Count -eq 1) {
            $mcpObject = $mcpProperties[0].Value
            if ($null -eq $mcpObject -or $mcpObject -isnot [PSCustomObject]) {
                throw 'Could not safely inspect OpenClaw configuration; stop deployment.'
            }

            $serverProperties = @($mcpObject.PSObject.Properties | Where-Object { $_.Name -ieq 'servers' })
            if ($serverProperties.Count -gt 1) {
                throw 'Could not safely inspect OpenClaw configuration; stop deployment.'
            }

            if ($serverProperties.Count -eq 1) {
                $serversObject = $serverProperties[0].Value
                if ($null -eq $serversObject -or $serversObject -isnot [PSCustomObject]) {
                    throw 'Could not safely inspect OpenClaw configuration; stop deployment.'
                }

                $bookkeepingProperties = @($serversObject.PSObject.Properties | Where-Object {
                    $_.Name -ieq 'ezbookkeeping'
                })
                if ($bookkeepingProperties.Count -gt 0) {
                    throw 'Static ezbookkeeping MCP fallback detected; stop deployment and review removal separately.'
                }
            }
        }
    } finally {
        $configObject = $null
    }

    Write-Output 'STATIC_EZBOOKKEEPING_MCP_FALLBACK_ABSENT'
}

$openclawConfigPath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.openclaw\openclaw.json'
Assert-NoStaticEzBookkeepingMcpFallback -ConfigPath $openclawConfigPath
```

Expected: only `STATIC_EZBOOKKEEPING_MCP_FALLBACK_ABSENT` is emitted. If inspection fails or the property exists, stop deployment and require a separate reviewed removal; do not display or automatically delete the entry. This assertion, the 81 manifest/resolver/allowlist tests, and an owner-context WeChat history query close the no-static-fallback evidence chain.

- [ ] **Step 1: Back up runtime configuration without copying secrets into Git**

Use timestamped copies beside the live files, outside the repository:

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath "$env:USERPROFILE\.openclaw\openclaw.json" -Destination "$env:USERPROFILE\.openclaw\openclaw.json.before-assistant-$stamp"
Copy-Item -LiteralPath 'D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini' -Destination "D:\Clawbot\ezbookkeeping\conf\ezbookkeeping.ini.before-assistant-$stamp"
```

Expected: both backup files exist outside the Git worktree.

- [ ] **Step 2: Review, clean, and fast-forward the reviewed feature into local `main`**

The configured OpenClaw plugin source is already `F:\OneDrive - Nanyang Technological University\桌面\Clawbot\openclaw-plugins\clawbot-bookkeeping`; do not copy a second plugin tree. Finish the branch review and `/neat`, then fast-forward local `main` so that configured path contains the reviewed code:

```powershell
$repoPath = 'F:\OneDrive - Nanyang Technological University\桌面\Clawbot'
$worktreePath = Join-Path $repoPath '.worktrees\bookkeeping-assistant-queries'
Set-Location $worktreePath
git status --short --branch
git diff main...HEAD --check
git log --oneline --decorate main..HEAD

# Run the requested code-review and /neat skills here. Commit any resulting
# focused fixes on feat/bookkeeping-assistant-queries and rerun all tests.

Set-Location $repoPath
git merge --ff-only feat/bookkeeping-assistant-queries
openclaw plugins info clawbot-bookkeeping
```

Expected: review finds no unresolved critical issue, both worktrees are clean, local `main` fast-forwards, and plugin info reports the exact primary-repository source above. Do not push yet.

- [ ] **Step 3: Install and start the persistent service task**

From the primary repository, run:

```powershell
.\scripts\install-ezbookkeeping-task.ps1 -WhatIf
.\scripts\install-ezbookkeeping-task.ps1
$tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
  $_.TaskName -eq 'Clawbot ezBookkeeping' -and $_.TaskPath -eq '\'
})
if ($tasks.Count -ne 1) { throw 'Expected exactly one root Clawbot ezBookkeeping task.' }
$task = $tasks[0]
Start-ScheduledTask -InputObject $task -ErrorAction Stop
Start-Sleep -Seconds 3
Invoke-RestMethod -Uri 'http://127.0.0.1:8180/healthz.json' -TimeoutSec 5
```

Expected: `-WhatIf` changes nothing; actual installation re-registers the tested exact Windows PowerShell 5.1 hidden action before the unique root task object is resolved and started; health response reports success. Never start an unverified task selected only by name.

- [ ] **Step 4: Enable MCP and create the protected token**

Run the setup script in a visible local terminal, entering the ezBookkeeping password only at its secure prompt. The script performs the required service restart before requesting the MCP token:

```powershell
.\scripts\configure-ezbookkeeping-mcp.ps1
Test-Path -LiteralPath "$env:USERPROFILE\.openclaw\secrets\ezbookkeeping-mcp-token.txt"
(Get-Acl -LiteralPath "$env:USERPROFILE\.openclaw\secrets\ezbookkeeping-mcp-token.txt").Access |
  Select-Object IdentityReference,FileSystemRights,AccessControlType
```

Expected: the token file exists, its ACL grants the current Windows identity, and no token is printed.

- [ ] **Step 5: Apply only the new sanitized configuration values**

Do not replace `bindings`, `commands.ownerAllowFrom`, or the existing WeChat account entry. Set only the assistant allowlist and safe local plugin fields:

```powershell
openclaw config set agents.entries.bookkeeper.tools.allow '["record_expense","summarize_expenses","ezbookkeeping__query_transactions"]' --strict-json
openclaw config set plugins.entries.clawbot-bookkeeping.config.serverBaseUrl 'http://127.0.0.1:8180'
openclaw config set plugins.entries.clawbot-bookkeeping.config.tokenPath "$env:USERPROFILE\.openclaw\secrets\ezbookkeeping-token.txt"
openclaw config set plugins.entries.clawbot-bookkeeping.config.mcpTokenPath "$env:USERPROFILE\.openclaw\secrets\ezbookkeeping-mcp-token.txt"
openclaw config set plugins.entries.clawbot-bookkeeping.config.stateDbPath 'D:\Clawbot\state\message-receipts.sqlite'
openclaw config set plugins.entries.clawbot-bookkeeping.config.accountName '日常支出'
openclaw config set plugins.entries.clawbot-bookkeeping.config.ledgerDisplayName '日常账本'
openclaw config get agents.entries.bookkeeper.tools.allow
openclaw config get plugins.entries.clawbot-bookkeeping.config
```

Expected: only the displayed non-secret paths, names, and allowlist change; private account and owner values are neither modified nor printed.

- [ ] **Step 6: Restart and verify the complete local chain**

Run:

```powershell
openclaw gateway restart --safe
openclaw gateway status
openclaw channels status --probe
openclaw plugins info clawbot-bookkeeping
```

Expected: Gateway and WeChat are healthy and the plugin is active. The preflight assertion proved that no top-level `mcp.servers.ezbookkeeping` entry existed before deployment, and these steps added none. The automated manifest/resolver/allowlist tests establish that source includes `query_transactions` and excludes `add_transaction`; the owner WeChat history query in the next step proves requester-scoped connectivity and completes the evidence chain.

- [ ] **Step 7: Perform real WeChat acceptance in order**

Send one fresh message at a time and verify both the phone reply and ezBookkeeping data:

```text
午饭7.2
这个月我花了多少钱
这个月吃饭花了多少
最近三笔支出是什么
上个月在NTUC买过什么
```

Expected:

- first message creates exactly one expense and returns the six-line receipt;
- both summary questions return tool-backed totals, counts, category totals, and largest three where applicable;
- history questions mention only transactions present in MCP results;
- no message shows reasoning, JSON, tool parameters, or raw errors.

Use the WeChat client's resend action once on the original expense message. Expected: no second transaction is created and the reply states it was already processed.

- [ ] **Step 8: Verify failure behavior without risking a write**

Re-register the tested exact task action, resolve its unique root object, stop ezBookkeeping, send only a query, then restart the same object. Keep this in one PowerShell session so `finally` restores the service even if the check fails:

```powershell
.\scripts\install-ezbookkeeping-task.ps1 -WhatIf
.\scripts\install-ezbookkeeping-task.ps1
$tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object {
  $_.TaskName -eq 'Clawbot ezBookkeeping' -and $_.TaskPath -eq '\'
})
if ($tasks.Count -ne 1) { throw 'Expected exactly one root Clawbot ezBookkeeping task.' }
$task = $tasks[0]
$expectedExecutable = [IO.Path]::GetFullPath('D:\Clawbot\ezbookkeeping\ezbookkeeping.exe')
try {
  Stop-ScheduledTask -InputObject $task -ErrorAction Stop
  Get-CimInstance Win32_Process -Filter "Name='ezbookkeeping.exe'" | Where-Object {
    $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $expectedExecutable
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }
  $healthFailed = $false
  try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:8180/healthz.json' -TimeoutSec 2
  } catch {
    $healthFailed = $true
  }
  if (-not $healthFailed) { throw 'Health unexpectedly succeeded while the service was stopped.' }
  Read-Host 'Send only the planned WeChat query now, then press Enter to restore ezBookkeeping'
} finally {
  Start-ScheduledTask -InputObject $task -ErrorAction Stop
  Start-Sleep -Seconds 3
  Invoke-RestMethod -Uri 'http://127.0.0.1:8180/healthz.json' -TimeoutSec 5
}
```

Expected during the stopped interval: `账本暂时连不上，本次没有读取任何数据，请稍后再试。` No write request is sent. After restart, repeat the query and receive the normal summary.

- [ ] **Step 9: Run final verification, push, and compare exact heads**

Run both repository test suites again from primary `main`, then push and prove the local and remote heads match:

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
npm.cmd test
Set-Location ..\openclaw-weixin-stable-id
npm.cmd run build
node --test test\inbound-message-id.test.mjs
Set-Location ..\..
git status --short --branch
git log --oneline --decorate -10
git push origin main
git fetch origin main
$localHead = git rev-parse main
$remoteHead = git rev-parse origin/main
if ($localHead -ne $remoteHead) { throw "main mismatch: local=$localHead remote=$remoteHead" }
git status --short --branch
```

Expected: all tests pass, no credential/runtime files are tracked, local `main` and `origin/main` resolve to the same commit, and the primary checkout is clean.
