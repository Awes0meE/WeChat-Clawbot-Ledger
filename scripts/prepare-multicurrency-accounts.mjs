import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CURRENCY_CODES, CURRENCY_CATALOG, MULTICURRENCY_ACCOUNT_NAME } from '../openclaw-plugins/clawbot-bookkeeping/currency.mjs';
import { scopedExpenseAccounts } from '../openclaw-plugins/clawbot-bookkeeping/expense-accounts.mjs';

// This administrative helper is deliberately outside the six bookkeeper tools.
// It never changes a transaction, reparents the legacy account, or deletes data.
export function prepareMulticurrencyAccounts(accounts) {
  const scoped = scopedExpenseAccounts(accounts);
  const legacy = accounts.filter((a) => a.name === '日常支出');
  if (legacy.length !== 1 || legacy[0].hidden === true || legacy[0].type !== 1) throw new Error('Expected one visible legacy SGD account');
  const old = legacy[0];
  if (!Number.isInteger(old.category) || old.category < 1 || old.category > 10
    || typeof old.icon !== 'string' || !/^[1-9]\d*$/u.test(old.icon)
    || typeof old.color !== 'string' || !/^[0-9A-Fa-f]{6}$/u.test(old.color)) throw new Error('Legacy account appearance is invalid');
  const parents = accounts.filter((a) => a.name === MULTICURRENCY_ACCOUNT_NAME);
  const leaves = scoped.filter((a) => a.group === 'multicurrency');
  if (parents.length && (parents.length !== 1 || parents[0].hidden === true || leaves.length !== CURRENCY_CODES.length)) {
    throw new Error('An incomplete or hidden multicurrency account already exists; inspect it before any change');
  }
  const payload = {
    name: MULTICURRENCY_ACCOUNT_NAME, category: old.category, type: 2, icon: old.icon,
    color: old.color, currency: '---', balance: 0,
    comment: '按原币保存支出；汇总时换算。',
    subAccounts: CURRENCY_CODES.map((currency) => ({
      name: `${currency} ${CURRENCY_CATALOG[currency].nameZh}`.slice(0, 64),
      category: old.category, type: 1, icon: old.icon, color: old.color, currency, balance: 0,
    })),
  };
  const sha256 = createHash('sha256').update(JSON.stringify({ legacyId: old.id, payload })).digest('hex');
  payload.clientSessionId = sha256;
  return { action: parents.length ? 'already_complete' : 'create', sha256, payload,
    receipt: { parentName: payload.name, currencies: CURRENCY_CODES, childCount: CURRENCY_CODES.length,
      initialBalances: 0, legacyAccountPreserved: true, transactionsMoved: 0 } };
}

export async function runMulticurrencyAccountPreparation({ serverBaseUrl, tokenPath, applySha256, fetchImpl = globalThis.fetch }) {
  if (!['http://127.0.0.1:18888', 'http://127.0.0.1:8888'].includes(serverBaseUrl)) throw new Error('Use an exact supported loopback origin');
  const token = readFileSync(tokenPath, 'utf8').trim();
  if (!token) throw new Error('Credential unavailable');
  const request = async (path, payload) => {
    const response = await fetchImpl(`${serverBaseUrl}/api/v1/${path}`, {
      method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8', 'X-Timezone-Name': 'Asia/Singapore' },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    const result = await response.json();
    if (!response.ok || result.success !== true) throw new Error('Account operation did not return success');
    return result.result;
  };
  let plan = prepareMulticurrencyAccounts(await request('accounts/list.json'));
  if (applySha256 !== undefined) {
    if (applySha256 !== plan.sha256) throw new Error('Account plan changed; inspect a new read-only receipt');
    if (plan.action === 'create') {
      // One submission only. On uncertain outcome, inspect the live account list
      // before rerunning; clientSessionId is stable as an additional server guard.
      await request('accounts/add.json', plan.payload);
      const verified = prepareMulticurrencyAccounts(await request('accounts/list.json'));
      if (verified.action !== 'already_complete' || verified.sha256 !== plan.sha256) throw new Error('Account creation requires manual verification; do not retry blindly');
      plan = verified;
    }
  }
  return { action: plan.action, planSha256: plan.sha256, ...plan.receipt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length % 2 || args.some((arg, i) => i % 2 === 0 && !['--origin', '--token-path', '--apply-sha256'].includes(arg))
      || new Set(args.filter((_, i) => i % 2 === 0)).size !== args.length / 2) throw new Error('Invalid arguments');
    const values = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
    console.log(JSON.stringify(await runMulticurrencyAccountPreparation({ serverBaseUrl: values['--origin'], tokenPath: values['--token-path'], applySha256: values['--apply-sha256'] }), null, 2));
  } catch {
    console.error('Account preparation was not confirmed. Inspect the account list before any retry; no transaction migration or deletion was requested.');
    process.exitCode = 1;
  }
}
