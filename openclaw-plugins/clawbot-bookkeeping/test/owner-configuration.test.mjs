import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../../../scripts/test-openclaw-owner.mjs', import.meta.url));

test('owner check requires an explicit state directory instead of reading the real user profile', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim(), 'OPENCLAW_OWNER_CHECK_ARGUMENTS_INVALID');
  assert.equal(result.stderr, '');
});

for (const { name, owners, userId = 'fixture-owner', extraAccount = false, succeeds = false } of [
  { name: 'exact channel-prefixed owner', owners: ['openclaw-weixin:fixture-owner'], succeeds: true },
  { name: 'wrong owner', owners: ['openclaw-weixin:different-owner'] },
  { name: 'bare owner ID', owners: ['fixture-owner'] },
  { name: 'wildcard with explicit owner', owners: ['*', 'openclaw-weixin:fixture-owner'] },
  { name: 'missing owner list' },
  { name: 'invalid owner list', owners: 'openclaw-weixin:fixture-owner' },
  { name: 'empty account owner', owners: ['openclaw-weixin:fixture-owner'], userId: ' ' },
  { name: 'multiple logged-in accounts', owners: ['openclaw-weixin:fixture-owner'], extraAccount: true },
]) {
  test(`owner check validates ${name} using only synthetic local state`, () => {
    const root = mkdtempSync(join(tmpdir(), 'clawbot-owner-check-'));
    try {
      const accounts = join(root, 'openclaw-weixin', 'accounts');
      mkdirSync(accounts, { recursive: true });
      writeFileSync(join(root, 'openclaw.json'), JSON.stringify({ commands: { ownerAllowFrom: owners } }));
      writeFileSync(join(accounts, 'fixture.json'), JSON.stringify({ userId }));
      writeFileSync(join(accounts, 'fixture.context-tokens.json'), '{}');
      writeFileSync(join(accounts, 'fixture.sync.json'), '{}');
      if (extraAccount) writeFileSync(join(accounts, 'extra.json'), JSON.stringify({ userId: 'other' }));
      const result = spawnSync(process.execPath, [script, '--openclaw-dir', root], { encoding: 'utf8' });
      assert.equal(result.status, succeeds ? 0 : 1);
      assert.equal(result.stdout.trim(), succeeds ? 'OPENCLAW_OWNER_CHECK_OK' : 'OPENCLAW_OWNER_CHECK_FAILED');
      assert.equal(result.stderr, '');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
