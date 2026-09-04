# Conversational Expense Confirmation Implementation Plan

> **Historical record (2026-09-04):** The confirmation flow has been implemented. The original local-Qwen runtime assumption is superseded by the official Codex harness, and cross-instance tool/reply handoff is now persisted in local SQLite. Use `README.md` and `WINDOWS-HANDOFF.md` for current operations.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the local bookkeeper ask for confirmation on ambiguous expenses and write the saved proposal only after the owner replies affirmatively, without turning the plugin into a Chinese-language semantic parser.

**Architecture:** Reuse the existing trusted inbound queue, run/tool-call binding, `SqliteReceiptStore`, category validation, exactly-once receipt state, ezBookkeeping API client, and rich receipt formatter. Add one durable pending proposal per owner conversation plus two narrow tools: `prepare_expense` and `resolve_expense_confirmation`. Keep semantic intent and note generation in local Qwen; keep identity, amount evidence, state transitions, deduplication, and API outcomes in the plugin.

**Tech Stack:** OpenClaw 2026.8.2 plugin SDK, TypeScript/ES modules, Node.js `node:sqlite`, TypeBox, Node test runner, local ezBookkeeping HTTP API.

---

## Existing code to reuse

- `SqliteReceiptStore` already owns database creation, WAL mode, busy handling, secure deletion, immediate transactions, receipt terminal states, and trusted inbound FIFO storage.
- `message_received`, `before_agent_run`, and `before_tool_call` already bind one trusted WeChat message to the correct OpenClaw run and tool call.
- `recordExpense` already owns amount parsing, receipt claiming, account/category lookup, API write, valid transaction-ID enforcement, timeout outcomes, and rich receipt data.
- `normalizeSubcategory`, the 11/45 category catalog, `formatExpenseReceipt`, and the fixed Singapore timestamp behavior remain authoritative.
- The local `AGENTS.md`, plugin manifest, tool metadata tests, and receipt-tool harness already provide the integration points needed for two more owner-only tools.

## Code to remove or simplify

- Remove the expanding Chinese semantic grammar in `bookkeeping-core.mjs` that tries to prove whether an arbitrary sentence is a real expense.
- Remove tests whose only purpose is enumerating more Chinese negation, quotation, merchant, or reimbursement phrasings.
- Retain deterministic hard checks for a single matching monetary value, explicit question/uncertainty routing, instruction-shaped tool injection, trusted metadata, owner identity, category validity, and exactly-once writes.
- Do not refactor unrelated summary, MCP, API, Windows deployment, or category code.

## Success criteria

1. `午饭7.2` still writes immediately and returns the six-line receipt.
2. `午饭7.2吗` creates no transaction, stores one ten-minute proposal, and returns the full confirmation form.
3. A same-conversation owner reply of `是` writes the stored proposal once using the original message time.
4. `不是`, another expense, a query, or any other substantive message removes the old proposal without writing it.
5. Restart, compact, replay, concurrent confirmation, and API timeout behavior remain fail-safe.
6. Existing write, query, MCP, stable-ID, category, and deployment-script tests remain green.

---

### Task 1: Add one durable pending proposal per conversation

**Files:**
- Modify: `openclaw-plugins/clawbot-bookkeeping/adapter.mjs`
- Modify: `openclaw-plugins/clawbot-bookkeeping/test/adapter.test.mjs`

- [ ] **Step 1: Add failing storage tests**

Add focused tests that use two `SqliteReceiptStore` instances against the same temporary database:

```js
test('pending expense confirmation is durable and replaced per conversation', () => {
  first.replacePendingExpenseConfirmation('conversation-a', {
    sourceMessageKey: 'message-1',
    sourceInbound: {
      channel: 'openclaw-weixin',
      messageId: 'message-1',
      content: '午饭7.2吗',
      timestamp: 1_788_425_460,
      observedAt: now,
      timeSource: 'message',
      conversationKey: 'conversation-a',
    },
    input: {
      amount: '7.2',
      primaryCategory: '食品酒水',
      subcategory: '早午晚餐',
      comment: '午饭',
    },
  }, now + 600_000, now);

  second.replacePendingExpenseConfirmation('conversation-a', {
    sourceMessageKey: 'message-2',
    sourceInbound: {
      channel: 'openclaw-weixin',
      messageId: 'message-2',
      content: '咖啡3.5吗',
      timestamp: 1_788_425_520,
      observedAt: now,
      timeSource: 'message',
      conversationKey: 'conversation-a',
    },
    input: {
      amount: '3.5',
      primaryCategory: '食品酒水',
      subcategory: '饮料甜品',
      comment: '咖啡',
    },
  }, now + 600_000, now);

  assert.equal(first.takePendingExpenseConfirmation('conversation-a', now).proposal.sourceMessageKey, 'message-2');
});
```

Cover these exact behaviors in the same test file:

- a reopened store can take an unexpired proposal;
- `takePendingExpenseConfirmation` atomically removes the proposal so a second store receives `missing`;
- an expired proposal returns `expired` once and is removed;
- `discardPendingExpenseConfirmation` removes an active proposal and is idempotent;
- different conversation hashes never see each other's proposals;
- malformed JSON or malformed proposal fields fail closed and are deleted rather than returned.

- [ ] **Step 2: Verify the focused tests fail for missing methods**

Run:

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
node --test test\adapter.test.mjs
```

Expected: the new tests fail because the confirmation-table statements and store methods do not exist.

- [ ] **Step 3: Implement the minimum SQLite state**

Extend the existing constructor schema with one table:

```sql
CREATE TABLE IF NOT EXISTS pending_expense_confirmations (
  conversation_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Add prepared statements and these methods to `SqliteReceiptStore`:

```js
replacePendingExpenseConfirmation(conversationKey, proposal, expiresAt, now = Date.now())
takePendingExpenseConfirmation(conversationKey, now = Date.now())
discardPendingExpenseConfirmation(conversationKey)
```

Requirements:

- validate non-empty hashed keys and safe integer timestamps before SQL;
- upsert replaces the sole row for that conversation atomically;
- take runs inside the existing immediate transaction, deletes before returning, and returns exactly `{ status: 'active', proposal }`, `{ status: 'expired' }`, or `{ status: 'missing' }`;
- normalize the parsed proposal before returning it: source inbound must contain channel, message ID, content, timestamp, observed time, time source, and conversation key; input must contain amount, formal primary/subcategory, and an optional bounded comment;
- never include live credentials or raw sender IDs in this table.

- [ ] **Step 4: Run storage tests and commit**

Run:

```powershell
node --test test\adapter.test.mjs
npm.cmd test
```

Expected: all adapter tests and the existing full plugin suite pass.

Commit:

```text
feat: persist pending expense confirmations
```

---

### Task 2: Add prepare/resolve tools and simplify the semantic boundary

**Files:**
- Modify: `openclaw-plugins/clawbot-bookkeeping/bookkeeping-core.mjs`
- Modify: `openclaw-plugins/clawbot-bookkeeping/index.ts`
- Modify: `openclaw-plugins/clawbot-bookkeeping/openclaw.plugin.json`
- Modify: `openclaw-workspace/AGENTS.md`
- Modify: `openclaw-plugins/clawbot-bookkeeping/test/bookkeeping-core.test.mjs`
- Modify: `openclaw-plugins/clawbot-bookkeeping/test/receipt-tool.test.mjs`
- Modify: `openclaw-plugins/clawbot-bookkeeping/test/prompt-policy.test.mjs`
- Modify: `openclaw-plugins/clawbot-bookkeeping/test/summary-tool.test.mjs`

- [ ] **Step 1: Replace semantic-enumeration tests with behavior tests**

Keep existing transaction, amount, receipt, failure, and deduplication tests. Replace the long phrase blacklist matrix with focused tests for the true plugin boundary:

```js
assert.equal(messageSupportsExpenseAmount('午饭7.2', 720), true);
assert.equal(messageSupportsExpenseAmount('午饭7.2吗', 720), true);
assert.equal(messageSupportsExpenseAmount('咖啡3.5，午饭7.2', 720), false);
assert.equal(messageSupportsExpenseAmount('午饭7.2，余额100', 720), true);
assert.equal(requiresExpenseConfirmation('午饭7.2吗'), true);
assert.equal(requiresExpenseConfirmation('午饭7.2'), false);
```

Add receipt-tool integration tests for these complete flows:

- direct `午饭7.2` -> one POST and rich receipt;
- `午饭7.2吗` through `prepare_expense` -> zero POST and full confirmation form;
- restart harness, then `是` through `resolve_expense_confirmation(confirm)` -> one POST using original timestamp and proposal fields;
- `不是` through `resolve_expense_confirmation(cancel)` -> zero POST and cancellation text;
- decision/text mismatch -> no proposal mutation and no POST;
- expired confirmation -> expiry text and zero POST;
- second `是` -> no second POST;
- two concurrent `是` turns -> at most one POST;
- a new `咖啡3.5` turn discards the old lunch proposal and processes coffee independently;
- a history query turn discards the old proposal and performs no write;
- `不是，是8.2` is substantive content: it removes the old proposal and can only create a new candidate whose amount evidence is 8.2 in the current trusted message.

- [ ] **Step 2: Verify the new tool tests fail**

Run:

```powershell
node --test test\bookkeeping-core.test.mjs test\receipt-tool.test.mjs test\prompt-policy.test.mjs
```

Expected: failures for the missing amount-evidence helpers, confirmation formatter, two tool registrations, and proposal state transitions.

- [ ] **Step 3: Implement a small reusable core**

In `bookkeeping-core.mjs`:

- keep `parseAmountToMinorUnits`, comment validation, timestamp normalization, `formatExpenseReceipt`, receipt keys, terminal outcomes, and the actual ezBookkeeping write path;
- replace the open-ended Chinese proof grammar with:

```js
export function messageSupportsExpenseAmount(content, requestedAmountMinor) {
  // Strip explicit 备注, ignore documented administrative numbers,
  // require exactly one monetary candidate, and compare integer minor units.
}

export function requiresExpenseConfirmation(content) {
  const text = String(content ?? '').split('备注', 1)[0].trim();
  return /(?:吗|是不是|[?？])\s*$/u.test(text);
}

export function formatExpenseConfirmation(proposal) {
  // Return the approved fixed form with ledger, amount, category, note,
  // original Singapore time, and the “是/不是” instruction.
}
```

Split the write path into a validated wrapper and one internal transaction function so confirmation can reuse all existing API and receipt logic without pretending the current `是` message contains an amount:

```js
export async function recordExpense(params) {
  const sourceAmount = parseAmountToMinorUnits(params.input.amount);
  if (!messageSupportsExpenseAmount(params.inbound.content, sourceAmount)
      || requiresExpenseConfirmation(params.inbound.content)) {
    throw new ExpenseRecordingError('rejected');
  }
  return writeValidatedExpense(params);
}

export async function recordConfirmedExpense(params) {
  return writeValidatedExpense(params);
}
```

`writeValidatedExpense` must retain the current receipt claim, account/category lookup, pre-POST binding callback, add request, transaction-ID validation, terminal persistence, and rich receipt result unchanged.

- [ ] **Step 4: Reuse the trusted run/tool binding for all three expense tools**

In `index.ts`:

- add a hashed `conversationKey` to each trusted inbound payload using trusted channel, account, sender, and session context;
- keep the existing FIFO/run/tool-call state machine, but allow `record_expense`, `prepare_expense`, and `resolve_expense_confirmation` to obtain the bound inbound through one small helper;
- at `before_agent_run`, discard the conversation's prior proposal when the incoming owner text is not a pure confirmation/cancellation reply;
- do not change summary or MCP routing.

Register `prepare_expense` with the same candidate fields as `record_expense`. Its execution must:

1. verify owner and bound inbound;
2. normalize the category and comment;
3. verify `messageSupportsExpenseAmount`;
4. atomically replace the conversation proposal with a ten-minute expiry;
5. return `formatExpenseConfirmation` and never contact ezBookkeeping.

Register `resolve_expense_confirmation` with this exact parameter shape:

```ts
Type.Object({
  decision: Type.Union([Type.Literal('confirm'), Type.Literal('cancel')]),
}, { additionalProperties: false })
```

Its execution must:

1. verify owner, conversation, and bound inbound;
2. classify the current raw text with a short closed set of pure affirmative and negative replies;
3. reject a mismatch between the raw text and `decision` without consuming the proposal;
4. atomically take the proposal;
5. return missing/expired/cancel text or call `recordConfirmedExpense` with the stored original inbound and input;
6. use the existing pre-POST tool-call collision callback and existing stable terminal reply mapping.

- [ ] **Step 5: Update the local-model contract and manifests**

Update `openclaw.plugin.json` so both new tools use the `minimal` profile. Update `openclaw-workspace/AGENTS.md` so the local model:

- uses `record_expense` for clear completed expenses;
- uses `prepare_expense` when the amount/category/note can be proposed but intent is uncertain;
- uses `resolve_expense_confirmation` only for pure confirm/cancel replies;
- asks a normal question without a tool if amount or expense object is missing;
- treats any other new message as replacing the old proposal;
- copies tool-returned confirmation, cancellation, expiry, failure, or receipt text without reasoning traces;
- retains existing query routing and never lets query results trigger writes.

Update manifest/allowlist assertions from three to five owner conversation tools without exposing broader ezBookkeeping write MCP methods.

- [ ] **Step 6: Run focused and full tests, then commit**

Run:

```powershell
node --test test\bookkeeping-core.test.mjs test\receipt-tool.test.mjs test\prompt-policy.test.mjs test\summary-tool.test.mjs
npm.cmd test
node node_modules\typescript\bin\tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --skipLibCheck --allowJs --checkJs false --strict false --noImplicitAny false --useUnknownInCatchVariables false index.ts
```

Expected: every focused test, the full plugin suite, and the plugin entry type check pass.

Commit:

```text
feat: add conversational expense confirmation
```

---

### Task 3: Align documentation and run end-to-end regression

**Files:**
- Modify: `README.md`
- Modify: `WINDOWS-HANDOFF.md`
- Modify: `docs/bookkeeping-deployment-brief.md`
- Modify only if required by actual tool allowlist: `scripts/configure-ezbookkeeping-mcp.ps1`
- Test: `openclaw-plugins/clawbot-bookkeeping/test/runtime-scripts.test.mjs`
- Test: `openclaw-plugins/openclaw-weixin-stable-id/test/inbound-message-id.test.mjs`

- [ ] **Step 1: Update only workflow facts changed by this feature**

Document:

- direct versus ambiguous expense behavior;
- the full confirmation form;
- ten-minute expiry;
- original-message timestamp behavior;
- new substantive messages replacing the old proposal;
- durable local-only SQLite state;
- the five-tool owner conversation allowlist;
- unchanged loopback bindings, local-model policy, token handling, deduplication, and API-success requirement.

Remove documentation that tells users to rewrite every unknown merchant into a rigid command solely to satisfy the old semantic grammar. Do not change Vercel or public-hosting plans.

- [ ] **Step 2: Run all repository checks**

Run:

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
npm.cmd test
node node_modules\typescript\bin\tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --skipLibCheck --allowJs --checkJs false --strict false --noImplicitAny false --useUnknownInCatchVariables false index.ts

Set-Location ..\openclaw-weixin-stable-id
npm.cmd run build
node --test test\inbound-message-id.test.mjs

Set-Location ..\..
git diff --check
git status --short
```

Expected:

- bookkeeping tests: all pass;
- TypeScript entry check: exit 0;
- stable-ID build and tests: pass;
- diff check: no whitespace errors;
- only the intended documentation/test files are modified before commit.

- [ ] **Step 3: Commit the aligned documentation**

Commit:

```text
docs: document conversational expense confirmation
```

- [ ] **Step 4: Final local acceptance before live deployment**

Re-run the exact interaction scenarios with the plugin harness and confirm the HTTP request log:

```text
午饭7.2                 -> POST 1
午饭7.2吗               -> POST 0, proposal 1
是                      -> cumulative POST 1, original timestamp
再次是                  -> cumulative POST still 1
午饭8.2吗 -> 不是       -> POST 0 for that proposal
午饭8.2吗 -> 咖啡3.5    -> old proposal removed; only coffee may write
午饭8.2吗 -> wait 10m -> 是 -> POST 0 for expired proposal
```

Do not touch the live OpenClaw configuration, scheduled task, token files, or real ezBookkeeping data during this plan. Live deployment and owner WeChat acceptance remain the next separately verified step after code review.
