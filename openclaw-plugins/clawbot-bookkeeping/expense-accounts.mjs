import { MULTICURRENCY_ACCOUNT_NAME, normalizeCurrency } from './currency.mjs';

export function scopedExpenseAccounts(accounts, legacyName = '日常支出') {
  if (!Array.isArray(accounts)) throw new Error('invalid expense account list');
  const legacy = accounts.filter((a) => a?.name === legacyName && a.hidden !== true);
  const parents = accounts.filter((a) => a?.name === MULTICURRENCY_ACCOUNT_NAME && a.hidden !== true);
  if (legacy.length > 1 || parents.length > 1) throw new Error('expense account scope is ambiguous');
  const result = [];
  const seen = new Set();
  const add = (account, group) => {
    if (!account || typeof account.id !== 'string' || !account.id.trim() || account.id === '0'
      || /[,\s]/u.test(account.id) || seen.has(account.id)) throw new Error('invalid expense account identity');
    const currency = normalizeCurrency(account.currency);
    if (currency !== account.currency) throw new Error('noncanonical account currency');
    seen.add(account.id);
    result.push({ id: account.id, currency, group, name: account.name });
  };
  if (legacy.length) {
    if (legacy[0].currency !== 'SGD' || legacy[0].type === 2) throw new Error('legacy expense account must remain SGD');
    add(legacy[0], 'legacy');
  }
  if (parents.length) {
    const parent = parents[0];
    if (typeof parent.id !== 'string' || !parent.id || parent.id === '0' || /[,\s]/u.test(parent.id)
      || seen.has(parent.id) || parent.type !== 2 || parent.currency !== '---' || !Array.isArray(parent.subAccounts)) {
      throw new Error('multicurrency expense account must be a parent');
    }
    seen.add(parent.id);
    const currencies = new Set();
    for (const child of parent.subAccounts) {
      if (!child || typeof child !== 'object') throw new Error('invalid subaccount');
      if (child.hidden === true) continue;
      if (child.parentId !== parent.id || child.type !== 1 || currencies.has(child.currency)) {
        throw new Error('multicurrency expense subaccount is ambiguous');
      }
      add(child, 'multicurrency');
      currencies.add(child.currency);
    }
  }
  if (!result.length) throw new Error('no configured expense accounts');
  return result;
}

export function selectExpenseWriteAccount(accounts, currency = 'SGD') {
  currency = normalizeCurrency(currency);
  const matches = accounts.filter((a) => a.currency === currency);
  const preferred = matches.filter((a) => a.group === 'multicurrency');
  if (preferred.length === 1) return preferred[0];
  if (preferred.length === 0 && matches.length === 1) return matches[0];
  throw new Error('missing or ambiguous currency expense account');
}
