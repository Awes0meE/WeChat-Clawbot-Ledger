# Clawbot project guide

## Scope

This repository contains the reproducible source, tests, documentation, and sanitized configuration templates for the personal WeChat bookkeeping system. It does not contain live credentials, WeChat identities, OpenClaw transcripts, or ezBookkeeping data.

## Current architecture

```text
WeChat iLink -> Windows OpenClaw release -> OpenAI GPT-5.6 Sol via official Codex harness
  -> clawbot-bookkeeping -> 127.0.0.1:8888 ezBookkeeping

Browser -> ledger.66ccff-labs.com -> Cloudflare Tunnel
  -> guarded 127.0.0.1:8888 ezBookkeeping
```

- Windows is the active always-on host; the former Mac receiver is stopped.
- `openclaw-plugins/clawbot-bookkeeping` owns trusted-message correlation, category validation, deduplication, and local API writes.
- Its local SQLite state also carries pending confirmations, trusted tool bindings, and authoritative replies across Codex/OpenClaw instance boundaries.
- `openclaw-plugins/openclaw-weixin-stable-id` preserves Tencent message IDs and sender metadata.
- `openclaw-workspace/AGENTS.md` is the runtime prompt for the dedicated bookkeeper, not this repository guide.
- Production OpenClaw loads an immutable, hash-verified release outside this Git checkout. Development and integration work uses `127.0.0.1:18888` with separate config, secrets, storage, and SQLite.
- The Ledger Tunnel supervisor publishes only after it verifies the exact production port owner, explicit config, health JSON, and login-page fingerprint; origin degradation fails closed.
- Deterministic HTTP summaries are live. Native MCP history queries are implemented but remain unavailable until the local MCP service and its separate token are enabled through the documented interactive setup.

## Safety boundaries

- Never commit tokens, passwords, account IDs, sender IDs, QR data, transcripts, SQLite files, or OpenClaw state.
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
node --test test\inbound-message-id.test.mjs

openclaw gateway status
openclaw channels status --probe
```

For production/test migration, immutable release publication, Tunnel installation, public checks, restart/fail-closed checks, WeChat regression, and portfolio regression, follow `docs/ledger-cloudflare-runbook.md`. Real Cloudflare authorization occurs only in a visible local terminal/browser and never through copied credentials.

Update `README.md` and `WINDOWS-HANDOFF.md` when the live architecture, service state, tools, or user workflow changes.
