# Clawbot

Clawbot is a private, local-first personal bookkeeping project. Its current working path is:

```text
WeChat
  -> Tencent iLink
  -> OpenClaw Gateway on Windows
  -> dedicated local Qwen bookkeeper
  -> least-privilege bookkeeping plugin
  -> ezBookkeeping on Windows
```

The repository contains reproducible source code, tests, documentation, and sanitized configuration templates. Live credentials, WeChat identities, conversations, and ledger data stay on the Windows host.

## Current baseline

Verified on 2026-09-03 in Asia/Singapore:

| Component | Current state |
| --- | --- |
| OpenClaw | 2026.8.2; Windows Scheduled Task; loopback Gateway on port 18789 |
| WeChat | Tencent iLink channel enabled, configured, and running on Windows |
| Active agent | Dedicated `bookkeeper` agent; the general `main` agent is not used for WeChat expenses |
| Local model | Ollama `qwen3:8b`, 8192-token context, thinking off |
| Ledger | ezBookkeeping 1.6.1; loopback port 8180; SGD account `日常支出` |
| Categories | 11 primary and 45 secondary expense categories |
| Bookkeeping plugin | Fixed loopback API, trusted sender/message correlation, SQLite deduplication |
| Live result | A real WeChat expense was written successfully and the phone received `已记账` |
| Former Mac receiver | Stopped; do not run it concurrently with the Windows iLink receiver |

The trusted-message bridge is disk-backed because OpenClaw can execute the inbound hook and the tool in isolated plugin instances. Lookup keys are hashed, records expire after ten minutes, and the raw sender/session identifiers are not written to the project.

## Behavior and safety

- One WeChat message records one SGD expense.
- An expression such as `6.5+2.5` is one expense totaling `9`, not two transactions.
- The local model selects the official primary and secondary categories.
- The transaction timestamp comes from trusted WeChat metadata, with receive time only as a fallback.
- Deduplication uses trusted channel plus message ID. Identical text sent as two distinct messages remains two expenses.
- The bot confirms success only after ezBookkeeping confirms the write.
- OpenClaw and ezBookkeeping listen on loopback; the bookkeeping agent has only `bookkeeping_health` and `record_expense`.
- No cloud model is part of the active bookkeeping path.

## Repository layout

| Path | Purpose |
| --- | --- |
| `openclaw-plugins/clawbot-bookkeeping/` | Local expense tool, trusted metadata bridge, API adapter, and tests |
| `openclaw-plugins/openclaw-weixin-stable-id/` | Tencent plugin 2.4.8 local variant preserving message and sender metadata |
| `openclaw-workspace/` | Minimal runtime prompt for the dedicated local bookkeeper |
| `config/expense-categories.json` | Machine-readable 11/45 category source |
| `config/*.example.json` | Sanitized OpenClaw configuration templates |
| `scripts/initialize-test-ledger.ps1` | Idempotent account/category initialization and verification |
| `WINDOWS-HANDOFF.md` | Detailed deployment, architecture, operations, and recovery notes |
| `research/accounting-options.md` | Historical product research; not the current implementation guide |

## Local-only files

The following stay outside Git even though they may exist in this working directory:

- `.openclaw/` diagnostic exports and runtime state
- `openclaw-workspace/memory/` generated session memory
- `config/bookkeeping-compact.batch.json` with the machine-specific workspace path
- `config/weixin-bookkeeper-agent.batch.json` with the live WeChat account binding
- token files, passwords, logs, databases, and QR/login state

Copy the matching `config/*.example.json` file and replace its placeholders when configuring another host. Never commit the filled copy.

## Verification

From Windows PowerShell:

```powershell
Set-Location openclaw-plugins\clawbot-bookkeeping
npm.cmd test

Set-Location ..\openclaw-weixin-stable-id
npm.cmd run build
node --test test\inbound-message-id.test.mjs

openclaw gateway status
openclaw channels status --probe
openclaw plugins info clawbot-bookkeeping
```

The full end-to-end acceptance check is a newly sent WeChat expense followed by both a successful tool receipt and the expected transaction in ezBookkeeping.

## Operations

```powershell
openclaw gateway start
openclaw gateway restart --safe
openclaw gateway status
openclaw channels status --probe
openclaw logs --follow --plain
```

ezBookkeeping is installed separately under `D:\Clawbot\ezbookkeeping` and is managed by the `Clawbot ezBookkeeping` Scheduled Task. The software, token, and SQLite ledger are intentionally not stored in this repository.

## Roadmap

Next planned work:

1. Have the local model infer a concise note from the message without inventing missing details.
2. Return a lively structured WeChat receipt containing ledger, amount, category, note, and trusted Singapore time.
3. Later add a securely authenticated family web view. The local ledger must not be exposed directly; hosting, synchronization, authentication, authorization, backups, and audit boundaries require a separate design.

See [WINDOWS-HANDOFF.md](WINDOWS-HANDOFF.md) for the detailed operational history and recovery boundaries.
