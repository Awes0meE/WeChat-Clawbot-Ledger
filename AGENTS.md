# Clawbot project guide

## Scope

This repository contains the reproducible source, tests, documentation, and sanitized configuration templates for the personal WeChat bookkeeping system. It does not contain live credentials, WeChat identities, OpenClaw transcripts, or ezBookkeeping data.

## Current architecture

`WeChat iLink -> Windows OpenClaw -> OpenAI GPT-5.6 Sol via official Codex harness -> clawbot-bookkeeping -> ezBookkeeping`

- Windows is the active always-on host; the former Mac receiver is stopped.
- `openclaw-plugins/clawbot-bookkeeping` owns trusted-message correlation, category validation, deduplication, and local API writes.
- Its local SQLite state also carries pending confirmations, trusted tool bindings, and authoritative replies across Codex/OpenClaw instance boundaries.
- `openclaw-plugins/openclaw-weixin-stable-id` preserves Tencent message IDs and sender metadata.
- `openclaw-workspace/AGENTS.md` is the runtime prompt for the dedicated bookkeeper, not this repository guide.
- Deterministic HTTP summaries are live. Native MCP history queries are implemented but remain unavailable until the local MCP service and its separate token are enabled through the documented interactive setup.

## Safety boundaries

- Never commit tokens, passwords, account IDs, sender IDs, QR data, transcripts, SQLite files, or OpenClaw state.
- Keep ezBookkeeping bound to `127.0.0.1:8180` and OpenClaw Gateway bound to loopback.
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

Update `README.md` and `WINDOWS-HANDOFF.md` when the live architecture, service state, tools, or user workflow changes.
