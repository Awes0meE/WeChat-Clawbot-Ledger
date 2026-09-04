# Semantic Expense Time Implementation Plan

> **Historical record (2026-09-04):** This plan has been implemented, merged to `main` in PR #3, and loaded by the Windows OpenClaw Gateway. Use `README.md` and `WINDOWS-HANDOFF.md` for current operations; do not execute these unchecked implementation steps verbatim.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each expense write use the user-stated occurrence time when present, while keeping the trusted WeChat receive time as the safe default.

**Architecture:** Codex receives the trusted message timestamp as per-turn context and semantically produces an explicit time decision. The bookkeeping core validates currency, time mode, verbatim evidence, calendar values, temporal cues, and future bounds before the existing transaction claim/write path; pending confirmations persist the full validated proposal. The plugin remains a deterministic trust boundary rather than a Chinese-language parser.

**Tech Stack:** TypeScript OpenClaw plugin, TypeBox JSON Schema, Node.js ESM, `node:test`, SQLite, ezBookkeeping loopback HTTP API.

---

## File map

- Modify `openclaw-plugins/clawbot-bookkeeping/bookkeeping-core.mjs`: validate the structured time decision, resolve Singapore timestamps, and format trusted prompt context.
- Modify `openclaw-plugins/clawbot-bookkeeping/index.ts`: expose the new strict tool schema, inject trusted per-turn time context, and pass resolved time metadata through receipts and confirmations.
- Modify `openclaw-plugins/clawbot-bookkeeping/adapter.mjs`: retain the new proposal fields across SQLite serialization and restart.
- Modify `openclaw-plugins/clawbot-bookkeeping/test/bookkeeping-core.test.mjs`: reproduce the reported bug and cover deterministic time/currency gates.
- Modify `openclaw-plugins/clawbot-bookkeeping/test/receipt-tool.test.mjs`: cover the OpenClaw hook, JSON Schema, API request, receipt, and confirmation path.
- Modify `openclaw-plugins/clawbot-bookkeeping/test/adapter.test.mjs`: cover durable proposal normalization with the new fields.
- Modify `openclaw-plugins/clawbot-bookkeeping/test/prompt-policy.test.mjs`: lock the model's field-extraction and clarification contract.
- Modify `openclaw-workspace/AGENTS.md`: instruct Codex to extract time and currency before choosing a tool.
- Modify `README.md` and `WINDOWS-HANDOFF.md`: document behavior, checks, and live reload expectations.

No ezBookkeeping schema, stable WeChat ID plugin, credential file, OpenClaw transcript, or live SQLite database changes are required.

### Task 1: Core structured time validation

**Files:**
- Modify: `openclaw-plugins/clawbot-bookkeeping/test/bookkeeping-core.test.mjs`
- Modify: `openclaw-plugins/clawbot-bookkeeping/bookkeeping-core.mjs`

- [ ] **Step 1: Add a shared valid-input helper and failing timestamp tests**

Add this helper near the imports in `bookkeeping-core.test.mjs`, then use it for every existing `recordExpense`, `recordConfirmedExpense`, and `prepareExpenseConfirmation` input so old tests state the new contract explicitly:

```js
function receivedExpenseInput(overrides = {}) {
  return {
    amount: '7.2',
    currency: 'SGD',
    timeMode: 'received',
    primaryCategory: '食品酒水',
    subcategory: '早午晚餐',
    ...overrides,
  };
}
```

Import `formatTrustedExpenseTimeContext`, `hasExplicitExpenseTimeCue`, and `resolveExpenseTimestamp`. Add these focused tests:

```js
test('resolves the reported relative date and exact clock into Singapore time', () => {
  const time = resolveExpenseTimestamp({
    input: receivedExpenseInput({
      amount: '10.5',
      timeMode: 'explicit',
      localDate: '2026-09-03',
      localTime: '18:00',
      timeEvidence: '昨天晚上6点钟',
    }),
    inbound: {
      content: '记账昨天晚上6点钟，晚餐10.5 备注麦当劳5卤肉饭5.5',
      timestamp: 1_788_512_940,
    },
  });
  assert.equal(time, 1_788_429_600);
});

test('preserves trusted message clock time for an explicit date without a clock', () => {
  assert.equal(resolveExpenseTimestamp({
    input: receivedExpenseInput({
      amount: '10.5',
      timeMode: 'explicit',
      localDate: '2026-09-03',
      timeEvidence: '昨天',
    }),
    inbound: { content: '昨天晚饭10.5', timestamp: 1_788_512_940 },
  }), 1_788_426_540);
});

test('uses the trusted message timestamp only when no occurrence-time cue exists', () => {
  assert.equal(resolveExpenseTimestamp({
    input: receivedExpenseInput({ amount: '10.5' }),
    inbound: { content: '晚饭10.5', timestamp: 1_788_512_940_000 },
  }), 1_788_512_940);
  assert.equal(hasExplicitExpenseTimeCue('晚饭10.5'), false);
  assert.equal(hasExplicitExpenseTimeCue('昨晚六点，晚饭10.5'), true);
});

test('rejects ungrounded, invalid, future, and non-SGD time decisions', () => {
  const inbound = { content: '昨天晚上6点，晚饭10.5 备注明天见', timestamp: 1_788_512_940 };
  for (const overrides of [
    { timeMode: 'received' },
    { timeMode: 'explicit', localDate: '2026-09-03', localTime: '18:00', timeEvidence: '明天见' },
    { timeMode: 'explicit', localDate: '2026-02-30', localTime: '18:00', timeEvidence: '昨天晚上6点' },
    { timeMode: 'explicit', localDate: '2026-09-03', localTime: '25:00', timeEvidence: '昨天晚上6点' },
    { timeMode: 'explicit', localDate: '2026-09-05', localTime: '18:00', timeEvidence: '昨天晚上6点' },
    { currency: 'USD', timeMode: 'received' },
  ]) {
    assert.throws(() => resolveExpenseTimestamp({
      input: receivedExpenseInput({ amount: '10.5', ...overrides }),
      inbound,
    }));
  }
});

test('formats trusted prompt context without transport identifiers', () => {
  const context = formatTrustedExpenseTimeContext(1_788_512_940);
  assert.equal(context, [
    '[可信记账时间上下文]',
    '当前微信消息发送时间（Asia/Singapore）：2026-09-04 17:09',
    '只用它解析当前消息中的相对消费时间；不得把它当作用户声明的消费时间证据。',
  ].join('\n'));
  assert.equal(/sender|messageId|token|owner/u.test(context), false);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
node --test test\bookkeeping-core.test.mjs
```

Expected: FAIL because the three new exports do not exist and current validation always uses `inbound.timestamp`.

- [ ] **Step 3: Implement the minimum deterministic time contract**

In `bookkeeping-core.mjs`, add constants and helpers alongside the existing amount and question gates:

```js
const SINGAPORE_UTC_OFFSET_SECONDS = 8 * 60 * 60;
const FUTURE_CLOCK_TOLERANCE_SECONDS = 5 * 60;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const LOCAL_TIME = /^(\d{2}):(\d{2})$/u;
const EXPLICIT_TIME_CUE = /(?:今天|今日|昨天|昨日|前天|今晚|昨晚|今早|昨早|凌晨|早上|上午|中午|下午|晚上|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}\s*(?:点|时)(?:\s*\d{1,2}\s*分)?)/u;

function contentBeforeExplicitComment(content) {
  const text = String(content ?? '');
  const commentIndex = text.indexOf('备注');
  return (commentIndex < 0 ? text : text.slice(0, commentIndex)).trim();
}

function singaporeParts(timestamp) {
  const shifted = new Date((normalizeMessageTimestamp(timestamp) + SINGAPORE_UTC_OFFSET_SECONDS) * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function singaporeTimestamp({ year, month, day, hour, minute }) {
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute) - SINGAPORE_UTC_OFFSET_SECONDS * 1000;
  const candidate = Math.trunc(milliseconds / 1000);
  const roundTrip = singaporeParts(candidate);
  if (roundTrip.year !== year || roundTrip.month !== month || roundTrip.day !== day
    || roundTrip.hour !== hour || roundTrip.minute !== minute) {
    throw new Error('expense occurrence date or time is invalid');
  }
  return candidate;
}

export function hasExplicitExpenseTimeCue(content) {
  return EXPLICIT_TIME_CUE.test(contentBeforeExplicitComment(content));
}

export function resolveExpenseTimestamp({ input, inbound }) {
  if (input.currency !== 'SGD') throw new Error('expense currency must be SGD');
  const receivedTime = normalizeMessageTimestamp(inbound.timestamp);
  if (input.timeMode === 'received') {
    if (hasExplicitExpenseTimeCue(inbound.content)) {
      throw new Error('expense occurrence time requires semantic resolution');
    }
    return receivedTime;
  }
  if (input.timeMode !== 'explicit') throw new Error('expense time mode is required');

  const body = contentBeforeExplicitComment(inbound.content);
  const evidence = String(input.timeEvidence ?? '').trim();
  if (!evidence || !body.includes(evidence)) throw new Error('expense time evidence is not grounded');

  const dateMatch = String(input.localDate ?? '').match(LOCAL_DATE);
  if (!dateMatch) throw new Error('expense local date is invalid');
  const received = singaporeParts(receivedTime);
  let hour = received.hour;
  let minute = received.minute;
  if (input.localTime !== undefined) {
    const timeMatch = String(input.localTime).match(LOCAL_TIME);
    if (!timeMatch) throw new Error('expense local time is invalid');
    hour = Number(timeMatch[1]);
    minute = Number(timeMatch[2]);
  }
  const occurrenceTime = singaporeTimestamp({
    year: Number(dateMatch[1]),
    month: Number(dateMatch[2]),
    day: Number(dateMatch[3]),
    hour,
    minute,
  });
  if (occurrenceTime > receivedTime + FUTURE_CLOCK_TOLERANCE_SECONDS) {
    throw new Error('expense occurrence time is in the future');
  }
  return occurrenceTime;
}

export function formatTrustedExpenseTimeContext(timestamp) {
  const { year, month, day, hour, minute } = singaporeParts(timestamp);
  const twoDigits = (value) => String(value).padStart(2, '0');
  return [
    '[可信记账时间上下文]',
    `当前微信消息发送时间（Asia/Singapore）：${year}-${twoDigits(month)}-${twoDigits(day)} ${twoDigits(hour)}:${twoDigits(minute)}`,
    '只用它解析当前消息中的相对消费时间；不得把它当作用户声明的消费时间证据。',
  ].join('\n');
}
```

Change `validateExpenseInput` so its time line is exactly:

```js
const time = resolveExpenseTimestamp({ input, inbound });
```

Allow `writeExpense` to accept an optional `resolvedTime`. When present on a confirmed proposal, compare it to the freshly resolved value and reject on any mismatch before claiming the receipt; otherwise use the resolved value. Pass this option through `recordConfirmedExpense` unchanged:

```js
const time = resolveExpenseTimestamp({ input, inbound });
if (resolvedTime !== undefined
  && (!Number.isSafeInteger(resolvedTime) || resolvedTime !== time)) {
  throw new ExpenseRecordingError('rejected');
}
```

This makes the stored Unix timestamp authoritative while still detecting malformed or altered local SQLite proposal data.

Keep the existing amount, comment, claim, dedupe, category, API, and receipt logic unchanged.

- [ ] **Step 4: Run core tests and verify GREEN**

Run:

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
node --test test\bookkeeping-core.test.mjs
```

Expected: all `bookkeeping-core.test.mjs` tests PASS, including the reported `2026-09-03 18:00` case.

- [ ] **Step 5: Commit the core behavior**

```powershell
git add openclaw-plugins/clawbot-bookkeeping/bookkeeping-core.mjs openclaw-plugins/clawbot-bookkeeping/test/bookkeeping-core.test.mjs
git commit -m "feat(bookkeeping): resolve semantic expense timestamps"
```

### Task 2: OpenClaw tool, prompt-context, and durable confirmation integration

**Files:**
- Modify: `openclaw-plugins/clawbot-bookkeeping/index.ts`
- Modify: `openclaw-plugins/clawbot-bookkeeping/adapter.mjs`
- Modify: `openclaw-plugins/clawbot-bookkeeping/test/receipt-tool.test.mjs`
- Modify: `openclaw-plugins/clawbot-bookkeeping/test/adapter.test.mjs`

- [ ] **Step 1: Add failing integration tests for Schema, context, direct write, and persistence**

In `receipt-tool.test.mjs`, extend the harness so `on(name, handler, options)` stores hook options. Add a helper used by every direct record/prepare call:

```js
function receivedExpenseParams(overrides = {}) {
  return {
    amount: '7.2',
    currency: 'SGD',
    timeMode: 'received',
    primaryCategory: '食品酒水',
    subcategory: '早午晚餐',
    ...overrides,
  };
}
```

Add tests that assert:

```js
test('requires an explicit SGD currency and time decision in both expense tools', () => {
  const recordSchema = harness.recordExpenseDefinition({}).parameters;
  const prepareSchema = harness.prepareExpenseDefinition({}).parameters;
  for (const schema of [recordSchema, prepareSchema]) {
    assert.equal(schema.anyOf.length, 2);
    assert.deepEqual(schema.anyOf.map((branch) => branch.properties.timeMode.const), ['received', 'explicit']);
    assert.equal(schema.anyOf.every((branch) => branch.properties.currency.const === 'SGD'), true);
    assert.equal(schema.anyOf.every((branch) => branch.required.includes('currency')), true);
    assert.equal(schema.anyOf.every((branch) => branch.required.includes('timeMode')), true);
  }
});

test('injects only the correlated trusted send time into an authorized prompt', async () => {
  await beginTrustedOwnerTurn(harness.inboundHooks, {
    content: '昨天晚上6点，晚饭10.5',
    messageId: 'time-context-1',
    runId: 'run-time-context-1',
    timestamp: 1_788_512_940,
  });
  const result = await harness.inboundHooks.get('before_prompt_build')({ prompt: '昨天晚上6点，晚饭10.5', messages: [] }, {
    runId: 'run-time-context-1',
    trigger: 'user',
    toolAuthority: {
      assertActive() {},
      allows(name) { return name === 'record_expense'; },
    },
  });
  assert.match(result.prependContext, /2026-09-04 17:09/u);
  assert.equal(/owner-user|time-context-1|bot-account/u.test(result.prependContext), false);
  assert.equal(harness.hookOptions.get('before_prompt_build').requiresToolAuthority, true);
});
```

Also add one direct-write integration test using:

```js
receivedExpenseParams({
  amount: '10.5',
  timeMode: 'explicit',
  localDate: '2026-09-03',
  localTime: '18:00',
  timeEvidence: '昨天晚上6点钟',
})
```

Assert the single `/transactions/add.json` request has `time === 1_788_429_600` and the authoritative result contains `- 时间：2026/09/03 18:00`.

Change the existing `prepares an ambiguous expense, confirms it once, and keeps the original message time` scenario to prepare `昨天晚上6点，晚饭10.5吗` with the same explicit fields. Close the first plugin harness after preparation, create a second harness over the same SQLite path, receive the standalone confirmation `是`, and assert that the only transaction POST and final receipt still use `1_788_429_600` / `2026/09/03 18:00`. This is the restart/compaction boundary: the confirmation turn contributes only the decision, never a replacement timestamp.

In `adapter.test.mjs`, make `pendingExpenseProposal()` include:

```js
currency: 'SGD',
timeMode: 'explicit',
localDate: '2026-09-03',
localTime: '18:00',
timeEvidence: '昨晚6点',
```

Add `resolvedTime: 1_788_429_600` beside `input`, change the source content to `昨晚6点，午饭${amount}吗`, and assert the final timestamp plus all five input fields survive closing and reopening `SqliteReceiptStore`.

- [ ] **Step 2: Run integration tests and verify RED**

Run:

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
node --test test\adapter.test.mjs test\receipt-tool.test.mjs
```

Expected: FAIL because the Schema has no currency/time union, no authorized `before_prompt_build` hook is registered, and the SQLite proposal normalizer drops the fields.

- [ ] **Step 3: Add the strict TypeBox union and trusted prompt hook**

In `index.ts`, replace `RecordExpenseParams` with a shared base plus discriminated union:

```ts
type ExpenseBaseParams = {
  amount: string;
  currency: 'SGD';
  primaryCategory: string;
  subcategory: string;
  comment?: string;
};

type RecordExpenseParams = ExpenseBaseParams & ({
  timeMode: 'received';
} | {
  timeMode: 'explicit';
  localDate: string;
  localTime?: string;
  timeEvidence: string;
});
```

Build two `Type.Object` branches using one `EXPENSE_PARAMETER_PROPERTIES` object. Both branches require `currency: Type.Literal('SGD')`; the explicit branch requires `localDate`, `timeEvidence`, and permits optional `localTime`. Both use `{ additionalProperties: false }`.

Import `formatTrustedExpenseTimeContext`. Immediately after `before_agent_run`, register:

```ts
api.on('before_prompt_build', (_event, context) => {
  if (context.trigger !== 'user' || !context.runId || !context.toolAuthority) return;
  context.toolAuthority.assertActive();
  if (!context.toolAuthority.allows('record_expense')
    && !context.toolAuthority.allows('prepare_expense')) return;
  const inbound = inboundByRun.get(transientBindingKey('run', context.runId));
  if (!inbound) return;
  return { prependContext: formatTrustedExpenseTimeContext(inbound.timestamp) };
}, { requiresToolAuthority: true });
```

Do not inject content for queries, ordinary chat, missing trusted correlations, disallowed tools, or stale host authority.

Set response `details.timeSource` from the resolved decision (`received`, `explicit-date`, or `explicit-clock`) rather than the transport's `inbound.timeSource`; this is diagnostic metadata only and must not affect the displayed receipt.

- [ ] **Step 4: Preserve full proposals across confirmation and restart**

In `adapter.mjs`, extend `normalizePendingExpenseProposal` validation:

```js
const input = value.input;
const receivedTime = input.timeMode === 'received'
  && input.currency === 'SGD';
const explicitTime = input.timeMode === 'explicit'
  && input.currency === 'SGD'
  && /^\d{4}-\d{2}-\d{2}$/u.test(input.localDate)
  && (input.localTime === undefined || /^\d{2}:\d{2}$/u.test(input.localTime))
  && typeof input.timeEvidence === 'string'
  && input.timeEvidence.trim() !== '';
```

Reject the proposal unless `receivedTime || explicitTime`, and also require `Number.isSafeInteger(value.resolvedTime) && value.resolvedTime > 0`. Return `resolvedTime`, `currency`, `timeMode`, and, for explicit proposals, `localDate`, optional `localTime`, and `timeEvidence`. Calendar semantics remain centralized in `resolveExpenseTimestamp`; the adapter only prevents malformed persistence shapes.

Both prepare paths store `resolvedTime: candidate.time` with `normalizedInput`. The confirm path passes `resolvedTime: proposal.resolvedTime` into `recordConfirmedExpense`; the core cross-checks it against the persisted original inbound message and semantic fields before the receipt claim and API write. It never recalculates from the confirmation reply.

- [ ] **Step 5: Run integration and complete plugin tests**

Run:

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
node --test test\adapter.test.mjs test\receipt-tool.test.mjs
npm.cmd test
```

Expected: all tests PASS; there is exactly one transaction POST in the semantic-time case, and all existing trust, collision, receipt, timeout, and dedupe scenarios remain green.

- [ ] **Step 6: Commit the OpenClaw integration**

```powershell
git add openclaw-plugins/clawbot-bookkeeping/index.ts openclaw-plugins/clawbot-bookkeeping/adapter.mjs openclaw-plugins/clawbot-bookkeeping/test/receipt-tool.test.mjs openclaw-plugins/clawbot-bookkeeping/test/adapter.test.mjs
git commit -m "feat(bookkeeping): carry expense occurrence time through OpenClaw"
```

### Task 3: Runtime policy, documentation, and complete verification

**Files:**
- Modify: `openclaw-workspace/AGENTS.md`
- Modify: `openclaw-plugins/clawbot-bookkeeping/test/prompt-policy.test.mjs`
- Modify: `README.md`
- Modify: `WINDOWS-HANDOFF.md`

- [ ] **Step 1: Add failing prompt-policy assertions**

Add a test in `prompt-policy.test.mjs` that reads `openclaw-workspace/AGENTS.md` and asserts the policy contains all of these exact concepts:

```js
for (const phrase of [
  '时间、金额、币种、分类和备注',
  'timeMode',
  'received',
  'explicit',
  'timeEvidence',
  'localDate',
  'localTime',
  'Asia/Singapore',
  '非 SGD',
  '不要展示这套检查过程',
]) {
  assert.match(policy, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
}
```

Also assert the example `记账昨天晚上6点钟，晚餐10.5` routes to `record_expense` with `localDate: 2026-09-03` and `localTime: 18:00` when the trusted message time is `2026-09-04 17:09`.

- [ ] **Step 2: Run prompt tests and verify RED**

Run:

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
node --test test\prompt-policy.test.mjs
```

Expected: FAIL because the current runtime policy does not describe the new time fields or extraction order.

- [ ] **Step 3: Update the runtime policy without exposing chain of thought**

Add one `## 支出字段检查` section before `## 分类和备注` in `openclaw-workspace/AGENTS.md`:

```markdown
## 支出字段检查

- 对候选支出先在内部依次核对时间、金额、币种、分类和备注，再选择工具；不要展示这套检查过程。
- 当前轮可能包含插件注入的可信微信发送时间（`Asia/Singapore`），它只用于把“昨天”“前天”等相对时间换算成日期，不是消费时间的原文证据。
- 用户没有说明消费发生时间时，传 `currency: SGD`、`timeMode: received`，工具采用可信微信发送时间。
- 用户说明了日期或钟点时，传 `currency: SGD`、`timeMode: explicit`、解析后的 `localDate`（`YYYY-MM-DD`）及原文连续片段 `timeEvidence`；只有具体钟点明确时才传 `localTime`（`HH:mm`）。
- 只给日期没给具体钟点时不要猜钟点；工具会保留消息发送时分。日期或钟点无法唯一理解时，先自然追问，不调用写入工具。
- 本地无币种标记的金额按 SGD 理解；用户明确写了非 SGD 币种时，不换汇、不写入，先询问对应的 SGD 金额。
```

Update the record and prepare examples with the approved relative-time example. Keep the existing authoritative-result, one-write, confirmation, query, and no-reasoning rules unchanged.

- [ ] **Step 4: Update operator documentation**

In `README.md`, document:

- explicit occurrence time is model-interpreted and plugin-validated;
- no time expression uses trusted send time;
- date-only preserves the trusted send hour/minute;
- explicit non-SGD requires clarification;
- the tool receipt time is the actual API timestamp.

In `WINDOWS-HANDOFF.md`, document:

- both expense tools now require `currency` and `timeMode`;
- trusted reference time comes from the correlated WeChat message and is injected only on authorized bookkeeping turns;
- reloading the gateway is required after deploying the plugin/workspace prompt;
- the focused and full verification commands below.

Do not include live usernames, sender IDs, token paths containing secrets, transcripts, or database contents.

- [ ] **Step 5: Run the complete verification matrix**

Run:

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
npm.cmd test

Set-Location ..\openclaw-weixin-stable-id
npm.cmd run build
node --test test\inbound-message-id.test.mjs

Set-Location ..\..
git diff --check
git status --short
```

Expected:

- all bookkeeping tests PASS;
- stable WeChat plugin build exits 0;
- inbound stable-ID tests PASS;
- `git diff --check` prints nothing;
- `git status --short` lists only the four intended Task 3 files before commit.

Run live read-only service checks:

```powershell
openclaw gateway status
openclaw channels status --probe
```

Expected: gateway reports healthy and the WeChat channel probe is connected. These checks do not create a ledger record.

- [ ] **Step 6: Commit policy and documentation**

```powershell
git add openclaw-workspace/AGENTS.md openclaw-plugins/clawbot-bookkeeping/test/prompt-policy.test.mjs README.md WINDOWS-HANDOFF.md
git commit -m "docs(bookkeeping): document semantic expense time flow"
```

- [ ] **Step 7: Verify branch completion**

Run:

```powershell
git status --short --branch
git log --oneline --decorate -4
```

Expected: branch `fix/semantic-expense-time` is clean and contains the design commit, this plan commit, and the three implementation commits. No push, merge, live ledger write, or test-expense cleanup occurs without a separate user request.
