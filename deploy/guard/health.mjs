import { readFileSync } from 'node:fs';
try {
  const state = JSON.parse(readFileSync('/tmp/clawbot-guard-status.json'));
  process.exit(Date.now() - state.updatedAt < 10000 && ['tunnel-ready', 'publishing-test'].includes(state.state) ? 0 : 1);
} catch { process.exit(1); }
