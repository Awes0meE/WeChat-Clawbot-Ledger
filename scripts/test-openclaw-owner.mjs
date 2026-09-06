import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 2 || arguments_[0] !== '--openclaw-dir' || !arguments_[1]) {
  process.stdout.write('OPENCLAW_OWNER_CHECK_ARGUMENTS_INVALID\n');
  process.exitCode = 1;
} else {
  try {
    const root = arguments_[1];
    const accounts = join(root, 'openclaw-weixin', 'accounts');
    const files = readdirSync(accounts).filter((name) => name.endsWith('.json')
      && !name.endsWith('.context-tokens.json') && !name.endsWith('.sync.json'));
    if (files.length !== 1) throw new Error('invalid account count');
    const account = JSON.parse(readFileSync(join(accounts, files[0]), 'utf8'));
    if (typeof account.userId !== 'string' || !account.userId.trim()) throw new Error('invalid owner');
    const config = JSON.parse(readFileSync(join(root, 'openclaw.json'), 'utf8'));
    const owners = Array.isArray(config.commands?.ownerAllowFrom) ? config.commands.ownerAllowFrom : [];
    if (!owners.includes(`openclaw-weixin:${account.userId.trim()}`)
        || owners.some((owner) => typeof owner !== 'string' || owner.includes('*'))) {
      throw new Error('owner absent or unrestricted');
    }
    process.stdout.write('OPENCLAW_OWNER_CHECK_OK\n');
  } catch {
    process.stdout.write('OPENCLAW_OWNER_CHECK_FAILED\n');
    process.exitCode = 1;
  }
}
