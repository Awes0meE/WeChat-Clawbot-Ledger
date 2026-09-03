import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('the logged-in WeChat sender is an explicit OpenClaw owner', () => {
  const openclawDir = join(homedir(), '.openclaw');
  const configPath = join(openclawDir, 'openclaw.json');
  const accountsDir = join(openclawDir, 'openclaw-weixin', 'accounts');

  assert.equal(existsSync(configPath), true, 'OpenClaw config is missing');
  assert.equal(existsSync(accountsDir), true, 'WeChat account state is missing');

  const accountFiles = readdirSync(accountsDir).filter(
    (name) => name.endsWith('.json') && !name.endsWith('.context-tokens.json') && !name.endsWith('.sync.json'),
  );
  assert.equal(accountFiles.length, 1, 'Expected exactly one logged-in WeChat account');

  const account = JSON.parse(readFileSync(join(accountsDir, accountFiles[0]), 'utf8'));
  assert.equal(typeof account.userId, 'string', 'WeChat account owner ID is missing');
  assert.notEqual(account.userId.trim(), '', 'WeChat account owner ID is empty');

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const owners = Array.isArray(config.commands?.ownerAllowFrom)
    ? config.commands.ownerAllowFrom
    : [];
  const expectedOwner = `openclaw-weixin:${account.userId.trim()}`;

  assert.equal(
    owners.includes(expectedOwner),
    true,
    'Logged-in WeChat sender is not configured as an explicit OpenClaw owner',
  );
});
