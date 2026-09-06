# Clawbot project guide

## Scope

This repository contains the reproducible source, tests, documentation, and sanitized configuration templates for the personal WeChat bookkeeping system. Git-tracked content does not contain live credentials, WeChat identities, OpenClaw transcripts, or ezBookkeeping data.

## Current architecture

```text
WeChat iLink -> Windows OpenClaw release -> OpenAI GPT-5.6 Sol via official Codex harness
  -> clawbot-bookkeeping -> 127.0.0.1:8888 ezBookkeeping

Browser -> ledger.66ccff-labs.com -> Cloudflare Tunnel
  -> guarded 127.0.0.1:8888 ezBookkeeping
```

- Windows is the active always-on host; the former Mac receiver is stopped.
- `openclaw-plugins/clawbot-bookkeeping` owns trusted-message correlation, category validation, deduplication, and local API writes.
- Its local SQLite state also carries pending confirmations, trusted tool bindings, and authoritative replies across Codex/OpenClaw instance boundaries. `ended_trusted_runs` revokes ended runs; `processed_expense_confirmations` permanently deduplicates confirmation message hashes; `receipt_store_migrations` records the one-time import of previously claimed message hashes. Preserve these records during upgrades.
- `openclaw-plugins/openclaw-weixin-stable-id` preserves Tencent message IDs and sender metadata.
- `openclaw-workspace/AGENTS.md` is the runtime prompt for the dedicated bookkeeper, not this repository guide.
- Production OpenClaw loads an immutable, hash-verified release outside this Git checkout. Development and integration work uses `127.0.0.1:18888` with separate config, secrets, storage, and SQLite.
- The Ledger Tunnel supervisor publishes only after it verifies the exact production port owner, explicit config, health JSON, and login-page fingerprint; origin degradation fails closed.
- Deterministic HTTP summaries and owner-scoped MCP history queries are live. The local MCP service and its separate token were enabled on 2026-09-07; local connection, tool discovery, an authorized public connection rejection check, and a real WeChat history query passed. See `docs/handoffs/2026-09-07-history-query-activation.md` for the verification scope.
- The dedicated bookkeeper uses `tools.profile=full` with an exact six-tool `tools.allow` list. The minimal base profile filters out the native MCP history tool before that allowlist is applied; preserve the exact allowlist when maintaining this configuration.
- Production release `c05813e16d5c87096dc379fc51c00fad648b0b94` repairs the cross-instance write regression. Strict local checks passed 14/14; real WeChat write-history-write and filtered-summary checks passed. The system audit and remaining acceptance limits are recorded in `docs/handoffs/2026-09-07-bookkeeping-system-audit.md`.

## Safety boundaries

- Never commit tokens, passwords, account IDs, sender IDs, QR data, transcripts, SQLite files, or OpenClaw state.
- An ignored root file named `testAccountInfo.txt` may exist for the isolated `18888` test account. Never read it with output-producing commands, place it in model context, stage it, commit it, or upload it. Only a non-echoing local test-login process may consume it.
- Keep production ezBookkeeping bound to `127.0.0.1:8888`, isolated test ezBookkeeping bound to `127.0.0.1:18888`, and OpenClaw Gateway bound to loopback. Never run repository tests against `8888`.
- `ledger.66ccff-labs.com` is the only public Tunnel hostname. Do not enable Cloudflare Access, expose an origin port, or change `66ccff-labs.com`/`www.66ccff-labs.com` routing.
- Registration and ineffective password recovery stay disabled server-side. API token, MCP, and trusted-proxy allowlists stay exact loopback.
- Never stop an unknown process, replace an unrecognized task/Tunnel/DNS/rule, delete an unknown account, or restore a database automatically.
- A successful WeChat reply may only be produced after the bookkeeping API confirms the write.
- One inbound message creates at most one expense; deduplicate by trusted channel plus message ID, not by message text.
- The user explicitly changed the former local-only policy on 2026-09-04. Keep the dedicated bookkeeper pinned to the official Codex harness; do not add other cloud providers or fallbacks without fresh approval.

## Checks

Run from Windows PowerShell:

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
npm.cmd test

Set-Location ..\openclaw-weixin-stable-id
npm.cmd run build
node --test test/*.test.mjs

openclaw gateway status
openclaw channels status --probe
```

For production/test migration, immutable release publication, Tunnel installation, public checks, restart/fail-closed checks, WeChat regression, and portfolio regression, follow `docs/ledger-cloudflare-runbook.md`. The active 2026-09-05 continuation checkpoint is `docs/handoffs/2026-09-05-secure-ledger-tunnel-gpt6-handoff.md`. Real Cloudflare authorization occurs only in a visible local terminal/browser and never through copied credentials.

Update `README.md` and `WINDOWS-HANDOFF.md` when the live architecture, service state, tools, or user workflow changes.
